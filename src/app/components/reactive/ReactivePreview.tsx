'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReactivePreview.tsx — 编辑器预览面板里的 ReactiveMD 实时预览
//
// 【流程】防抖 300ms → 客户端适配 `[@…]` 引用（只发 GET）→ 把适配后的源码交给
// `LocalCompileScheduler`（优先 worker，失败回退主线程）→ 用 `ReactiveDocument`
// 渲染。
//
// 【三条静默错，各有对策】
//   · **先适配再调度**：调度器只认最终源码。若把原文排进去、适配结果晚到再补一次，
//     两次编译会互相覆盖，屏幕上偶尔闪回「未展开」的那一版（不报错）。
//   · **编译期间保留上一版**：`onResult` 只在成功时替换 `rendered`；失败只更新
//     错误列表。否则每次按键预览都会白一下，看起来像卡死。
//   · **hostData 按源码配对**：`onResult` 拿到的 `outcome.source` 才是那份结果对应
//     的源码。用「最新一次适配」的 hostData 去配旧结果，会让投票卡片显示另一篇
//     的数据（形状全对、内容错位）。这里用一个小 Map 按源码取。
//
// 【预览不写服务】`preview` 一路传到 `SiteEmbedView`，投票控件只读；本组件自身
// 只调用 `compileLocal` / 适配器（后者只发 GET）。
//
// 【刷新引用 = 换一份 reader】`refreshToken` 变化时重建会话级 reader（成功与失败的
// 缓存都在它身上），对同一份源码重新适配、重新编译；代次守卫保证旧的在飞结果
// 不会覆盖新结果。普通按键仍复用同一份 reader（同样的引用只取一次）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import {
  compileFailureDiagnostic,
  compileLocal,
  formatLocalDiagnostic,
  LocalCompileScheduler,
  type Diagnostic,
  type LocalCompileOutcome,
  type LocalCompileWorker,
  type LocalDocument,
} from 'reactive-md';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';
import {
  adaptReactivePreview,
  createClientReferenceReader,
} from '@/lib/reactive/client-compile';
import type { SiteHostData } from '@/lib/reactive/ref-types';
import ReactiveDocument from './ReactiveDocument';

const DEFAULT_DEBOUNCE_MS = 300;

/** 已成功渲染的一版：文档与它自己的 hostData 必须成对。 */
interface RenderedPreview {
  document: LocalDocument;
  hostData: SiteHostData;
}

export interface ReactivePreviewProps {
  /** 作者原文（未适配）。 */
  source: string;
  referenceMode?: 'expand' | 'external';
  /** 适配防抖；调度器自身还会再合并 150ms（上游默认）。 */
  debounceMs?: number;
  /**
   * 「刷新引用」按钮的计数器。
   *
   * 变化时**重建本组件的会话级 reader** —— 成功与失败的缓存都挂在它上面，不换掉
   * 就等于「点刷新也永远读到同一份旧数据」（失败更是永远不会重试）；换掉之后
   * 同一份源码也会重新取数、重新编译。普通按键仍然复用同一份 reader（缓存去重）。
   */
  refreshToken?: number;
}

export default function ReactivePreview({
  source,
  referenceMode = 'expand',
  debounceMs = DEFAULT_DEBOUNCE_MS,
  refreshToken = 0,
}: ReactivePreviewProps) {
  const [rendered, setRendered] = useState<RenderedPreview | null>(null);
  const [errors, setErrors] = useState<Diagnostic[]>([]);
  const [pending, setPending] = useState(false);

  const schedulerRef = useRef<LocalCompileScheduler | null>(null);
  /** 最近几次适配结果，按 adaptedSource 索引（见文件头「hostData 按源码配对」）。 */
  const hostDataBySourceRef = useRef(new Map<string, SiteHostData>());
  /** 代际：源码变了之后，晚到的适配结果不得再排进调度器。 */
  const generationRef = useRef(0);
  /** 会话级 reader（缓存 + 在飞去重）；每次挂载一份，卸载即释放。 */
  const readerRef = useRef<ReturnType<typeof createClientReferenceReader> | null>(null);
  if (!readerRef.current) readerRef.current = createClientReferenceReader();
  /** 上一次看到的刷新代次 —— 只在它真的变了时重建 reader。 */
  const refreshTokenRef = useRef(refreshToken);

  // ── 调度器：整个挂载期一个 ────────────────────────────────────────────────
  useEffect(() => {
    const scheduler = new LocalCompileScheduler({
      createWorker: () =>
        new Worker(new URL('../../../lib/reactive/compile.worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as LocalCompileWorker,
      fallbackCompile: (src) => compileLocal(src, reactiveCompileOptions('reactive')),
      onResult: (outcome: LocalCompileOutcome) => {
        if (!outcome.result.ok) {
          // 坏文档不渲染：保留上一版成功结果，只把诊断摆出来。
          setErrors(outcome.result.diagnostics);
          return;
        }
        const hostData = hostDataBySourceRef.current.get(outcome.source) ?? {};
        setErrors([]);
        setRendered({ document: outcome.result.document, hostData });
      },
      onPendingChange: setPending,
    });
    schedulerRef.current = scheduler;
    return () => {
      schedulerRef.current = null;
      scheduler.dispose();
      hostDataBySourceRef.current.clear();
    };
  }, []);

  // ── 「刷新引用」：换一份会话级 reader ────────────────────────────────────
  // ⚠️ 不能只让适配「再跑一遍」：缓存本身就挂在 reader 上，成功与失败都在里面。
  // 不换 reader，同样的引用永远读到同一份旧结果；失败的那几条更是**永远不会重试**。
  // 新 reader 也丢掉在飞去重那一层，于是刷新之后同一引用会真的再发一次 GET。
  // ⚠️ 这条 effect 必须排在下一条之前：同一提交里先换 reader，下一条才用得上新的。
  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    readerRef.current = createClientReferenceReader();
  }, [refreshToken]);

  // ── 防抖 → 适配 → 调度 ───────────────────────────────────────────────────
  useEffect(() => {
    // 每一轮（源码变化 / 刷新引用）都推进代次：晚到的旧适配结果据此丢弃，
    // 绝不能把旧引用数据排进调度器去覆盖新结果。
    const generation = (generationRef.current += 1);
    // 取**这一代**的 reader（刷新会换掉 readerRef；旧一代的任务不该用新 reader）。
    const reader = readerRef.current!;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const adapted = await adaptReactivePreview(source, reader, referenceMode);
          if (generation !== generationRef.current) return;
          const store = hostDataBySourceRef.current;
          store.set(adapted.adaptedSource, adapted.hostData);
          if (store.size > 8) {
            const oldest = store.keys().next().value;
            if (oldest !== undefined) store.delete(oldest);
          }
          schedulerRef.current?.schedule(
            adapted.adaptedSource,
            reactiveCompileOptions('reactive')
          );
        } catch (error) {
          if (generation !== generationRef.current) return;
          setErrors([compileFailureDiagnostic(error)]);
        }
      })();
    }, Math.max(0, debounceMs));

    return () => window.clearTimeout(timer);
  }, [source, debounceMs, refreshToken, referenceMode]);

  return (
    <div
      className="reactive-preview"
      data-reactive-preview-pending={pending ? 'true' : 'false'}
    >
      {errors.length > 0 && (
        <ul className="reactive-preview__errors" role="alert">
          {errors.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.line}:${diagnostic.column}:${index}`}>
              {formatLocalDiagnostic(diagnostic, 'zh')}
            </li>
          ))}
        </ul>
      )}
      {rendered ? (
        <ReactiveDocument
          document={rendered.document}
          hostData={rendered.hostData}
          mode="interactive"
          preview
          role="preview"
        />
      ) : (
        pending && (
          <p className="reactive-preview__status" role="status">
            正在编译预览…
          </p>
        )
      )}
    </div>
  );
}
