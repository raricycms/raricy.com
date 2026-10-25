'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReactiveDocument.tsx — ReactiveMD 文档的客户端渲染表面
//
// 三件事必须稳定，否则整篇会在每次父级渲染时重新分派：
//   · runtime —— 一个视图一个实例，由服务端编译好的 `LocalDocument` 惰性创建；
//   · urlPolicy —— 内部就是静态的 `isAllowedReactiveUrl`，`useCallback` 固定引用；
//   · hostRenderer —— 只随 `preview` 变化，绝不每次渲染新建。
//
// 【卸载 dispose 与 StrictMode】React 18/19 的开发态 StrictMode 会
// setup → cleanup → setup 同一份 state。若 cleanup 里立刻 `runtime.dispose()`，
// 第二次 setup 拿到的就是已经死掉的 runtime。这里用一个 ref 做「还持有吗」的
// 令牌，把真正的 dispose 推迟到宏任务：同步的重挂载会重置令牌，只有真正的卸载
// 才会走到 dispose。
// ─────────────────────────────────────────────────────────────────────────────

import 'reactive-md/screen.css';
import 'reactive-md/print.css';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createLocalRuntime, type LocalDocument, type LocalRuntime } from 'reactive-md';
import {
  LocalDocumentView,
  type LocalHostData,
  type LocalHostRenderer,
  type LocalLocale,
} from 'reactive-md/react';
import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';
import { SiteEmbedView } from './SiteEmbedView';

export interface ReactiveDocumentProps {
  /** 服务端已编译、可序列化的文档。 */
  document: LocalDocument;
  hostData?: LocalHostData;
  mode?: 'interactive' | 'static';
  staticFirst?: boolean;
  /** 预览上下文：传给 hostRenderer 闭包，预览不发改写请求。 */
  preview?: boolean;
  locale?: LocalLocale;
  /** 仅用于 `data-content-renderer` 标记与测试。 */
  role?: 'read' | 'preview' | 'export';
}

export default function ReactiveDocument({
  document,
  hostData,
  mode = 'interactive',
  staticFirst = false,
  preview = false,
  locale = 'zh',
  role = 'read',
}: ReactiveDocumentProps): ReactNode {
  // 一个视图一个 runtime，惰性创建；`document` 换了（编辑器预览每 300ms 会换）
  // 就必须换新 runtime —— 旧 runtime 绑定的是上一版文档，继续用会读错节点。
  const [state, setState] = useState<{ document: LocalDocument; runtime: LocalRuntime }>(
    () => ({ document, runtime: createLocalRuntime(document) })
  );
  let runtime = state.runtime;
  if (state.document !== document) {
    runtime = createLocalRuntime(document);
    setState({ document, runtime });
  }

  // StrictMode 安全阀：按 runtime 记一个「还持有吗」的令牌。cleanup 只松开令牌，
  // 宏任务里确认无人持有才 dispose —— 同步重挂载会重新持有，真正的卸载才不会。
  const disposals = useRef(new Map<LocalRuntime, { held: number }>());
  useEffect(() => {
    let token = disposals.current.get(runtime);
    if (!token) {
      token = { held: 0 };
      disposals.current.set(runtime, token);
    }
    token.held += 1;
    const entry = token;
    return () => {
      entry.held -= 1;
      setTimeout(() => {
        if (entry.held > 0) return;
        if (disposals.current.get(runtime) !== entry) return;
        disposals.current.delete(runtime);
        runtime.dispose();
      }, 0);
    };
  }, [runtime]);

  const urlPolicy = useCallback(
    (url: string, kind: 'image' | 'link') => isAllowedReactiveUrl(url, kind),
    []
  );

  const hostRenderer = useCallback<LocalHostRenderer>(
    (node, data, ctx) => SiteEmbedView(node, data, ctx, { preview }),
    [preview]
  );

  return (
    <div className="reactive-document" data-content-renderer={role}>
      <LocalDocumentView
        document={document}
        runtime={runtime}
        locale={locale}
        mode={mode}
        staticFirst={staticFirst}
        hostData={hostData}
        hostRenderer={hostRenderer}
        urlPolicy={urlPolicy}
      />
    </div>
  );
}
