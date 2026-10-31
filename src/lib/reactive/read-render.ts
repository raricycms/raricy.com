// ─────────────────────────────────────────────────────────────────────────────
// read-render.ts — 阅读页（博客 / 剪贴板）的**唯一渲染决策入口**（服务端）
//
// 2026-11 统一后的顺序：
//   1. 读 flag（默认启用；只有 `REACTIVE_MD_MODE=off` 是事故回退）与存储格式；
//   2. 非成员视图优先读**同版本持久快照**（发布时生成，避免每次未命中都付冷编译）；
//   3. 快照不可用 / 成员需要展开引用 / 事故回退时现编译；
//   4. Markdown 编译失败走 `compile-content.ts` 的字面量容错，Reactive 失败则不可用。
//
// ── 四条「错了也不报错」的纪律 ────────────────────────────────────────────────
//
// 【1】reactive 源码**永不**交给旧 Markdown 渲染器。`REACTIVE_MD_MODE=off` 时
//   Markdown 才回旧引擎；reactive 只走静态快照，格式认不出则 unavailable。
//
// 【2】快照版本 / 编译签名不符按 stale 拒读，绝不拿旧正文冒充当前正文。用快照前
//   还要按当前 external 规则重验引用（`snapshot-revalidation.ts`）：任何含旧剪贴板
//   载荷的结果都必须重编译。成员视图的引用展开不写回共享快照。
//
// 【3】正常阅读默认交互：快照与现编译产物都以 `reactive` 返回，页面用
//   `staticFirst` 先给 SSR 静态首屏，再水合为可操作组件。百分比 / cohort 不再
//   参与决策。
//
// 【4】日志只写结构化字段（renderer / reason / codes / 耗时 / 缓存命中 / 快照状态），
//   **不写正文、不写标题**。
// ─────────────────────────────────────────────────────────────────────────────

import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import { parseContentFormat, type ContentFormat } from '../content-format';
import { selectContentRenderer, type RendererChoice } from '../renderer-select';
import { parseReactiveFlags } from './flags';
import { compileContent } from './compile-content';
import type { ReactiveCompileOutcome } from './compile';
import { hasMutableExternalReferences, hostDataEqual } from './snapshot-revalidation';
import { scanReactiveReferences } from './ref-adapter';
import {
  reactiveContentVersion,
  readReactiveSnapshot,
  type SnapshotPayload,
} from './snapshot-store';

export interface ReadRenderInput {
  kind: 'blog' | 'clipboard';
  id: string;
  source: string;
  format: unknown;
  override?: unknown;
  viewer: { id: string; role?: string; archivedAt?: Date | null } | null;
  mode: 'expand' | 'external';
  clientIp?: string;
  /** 正文行里存着的语法版本（仅 reactive 有意义）；缺省按当前编译器版本。 */
  syntaxVersion?: string | null;
}

export interface ReadRenderResult {
  choice: RendererChoice;
  /** 日志字段（只含结构化信息）。 */
  log: {
    renderer: string;
    reason: string;
    format: string | null;
    codes: string[];
    compileMs: number;
    cacheHit: boolean;
    snapshotStatus: string;
  };
  /** 现编译的产物（快照命中时没有）。 */
  bundle?: ReactiveCompileOutcome;
  /** 同版本持久快照（成员引用展开时不用它）。 */
  snapshot?: SnapshotPayload;
  failure?: 'invalid-format' | 'compile' | 'snapshot-missing';
}

function finish(
  choice: RendererChoice,
  format: ContentFormat | null,
  bundle: ReactiveCompileOutcome | undefined,
  extra?: {
    failure?: ReadRenderResult['failure'];
    snapshot?: SnapshotPayload;
    snapshotStatus?: string;
  }
): ReadRenderResult {
  const codes = bundle?.result.diagnostics
    ? bundle.result.diagnostics.map((diagnostic) => diagnostic.code)
    : [];
  const log: ReadRenderResult['log'] = {
    renderer: choice.renderer,
    reason: choice.reason,
    format,
    codes,
    compileMs: bundle?.compileMs ?? 0,
    cacheHit: bundle?.cacheHit ?? false,
    snapshotStatus: extra?.snapshotStatus ?? 'none',
  };
  console.info('[reactive-read]', JSON.stringify(log));
  return {
    choice,
    log,
    ...(bundle ? { bundle } : {}),
    ...(extra?.snapshot ? { snapshot: extra.snapshot } : {}),
    ...(extra?.failure ? { failure: extra.failure } : {}),
  };
}

/**
 * 用当前 external 权限重验快照里的引用是否仍然有效。
 * 返回 keep / replace / untrusted，语义与快照模块一致（见 snapshot-revalidation.ts）。
 */
async function revalidateSnapshotReferences(
  input: ReadRenderInput,
  format: ContentFormat,
  snapshotHostData: SnapshotPayload['hostData']
): Promise<'keep' | 'replace' | 'untrusted'> {
  if (!hasMutableExternalReferences(input.source)) return 'keep';
  try {
    const { prepareReactiveDocument } = await import('./prepare');
    const prepared = await prepareReactiveDocument(input.source, {
      mode: 'external',
      format,

      viewer: input.viewer,
      clientIp: input.clientIp,
    });
    return hostDataEqual(prepared.hostData, snapshotHostData) ? 'keep' : 'replace';
  } catch {
    return 'untrusted';
  }
}

/** 快照内容版本：Markdown 的 syntaxVersion 恒为 null，与发布侧一致。 */
function contentVersionFor(input: ReadRenderInput, format: ContentFormat): string {
  const syntaxVersion =
    format === 'reactive' ? input.syntaxVersion ?? LOCAL_SYNTAX_VERSION : null;
  return reactiveContentVersion(format, syntaxVersion, input.source);
}

/** 成员视图是否含有必须按本人权限展开的成员资源。 */
function hasMemberReferences(input: ReadRenderInput): boolean {
  if (input.mode !== 'expand' || !input.viewer) return false;
  return scanReactiveReferences(input.source).some((slot) =>
    slot.kind === 'clipboard' || slot.kind === 'vote' || slot.kind === 'favorite'
  );
}

async function compile(input: ReadRenderInput, format: ContentFormat) {
  try {
    return await compileContent({
      source: input.source,
      format,
      mode: input.mode,
      viewer: input.viewer,
      clientIp: input.clientIp,
    });
  } catch {
    return undefined;
  }
}

export async function resolveReadRender(input: ReadRenderInput): Promise<ReadRenderResult> {
  const flags = parseReactiveFlags(process.env);
  const format = parseContentFormat(input.format);

  if (!format) {
    return finish(
      { renderer: 'unavailable', reason: 'invalid-format' },
      null,
      undefined,
      { failure: 'invalid-format' }
    );
  }

  // 事故回退：Markdown 才允许旧引擎；Reactive 仍只走静态快照 / 现编译。
  if (flags.mode === 'off' && format === 'markdown') {
    return finish({ renderer: 'legacy', reason: 'flag' }, format, undefined);
  }

  const contentVersion = contentVersionFor(input, format);
  const member = hasMemberReferences(input);

  // ── 快照优先（成员引用展开不适用：那些数据只属于本人）───────────────────
  let snapshotStatus = 'none';
  let snapshotPayload: SnapshotPayload | undefined;
  const snapshotRead = await readReactiveSnapshot(
    input.kind,
    input.id,
    contentVersion,
    format
  );
  snapshotStatus = snapshotRead.status;
  if (snapshotRead.status === 'ready' && !member) {
    const verdict = await revalidateSnapshotReferences(input, format, snapshotRead.payload.hostData);
    if (verdict === 'keep') {
      const renderer = flags.mode === 'off' ? 'reactive-static' : 'reactive';
      return finish({ renderer, reason: 'format' }, format, undefined, {
        snapshot: snapshotRead.payload,
        snapshotStatus: 'ready',
      });
    }
    snapshotStatus = verdict === 'untrusted' ? 'untrusted-references' : 'stale-references';
    // 旧快照的引用数据不可信：按 external 重新编译一份替代它。
    const replacement = await compile({ ...input, mode: 'external' }, format);
    if (replacement?.outcome.result.ok) {
      const renderer = flags.mode === 'off' ? 'reactive-static' : 'reactive';
      return finish({ renderer, reason: 'format' }, format, replacement.outcome, { snapshotStatus });
    }
  } else if (snapshotRead.status === 'ready') {
    // 成员引用视图需要现编译；快照留作编译失败时的静态兜底。
    snapshotPayload = snapshotRead.payload;
  }

  const compiled = await compile(input, format);
  if (compiled?.outcome.result.ok) {
    const renderer = flags.mode === 'off' ? 'reactive-static' : 'reactive';
    return finish({ renderer, reason: 'format' }, format, compiled.outcome, { snapshotStatus });
  }

  // 现编译失败时，同版本访客快照仍是一份可读的静态正文（引用保持字面量）。
  if (snapshotPayload) {
    return finish({ renderer: 'reactive-static', reason: 'format' }, format, undefined, {
      snapshot: snapshotPayload,
      snapshotStatus: 'ready-fallback',
    });
  }

  return finish(
    { renderer: 'unavailable', reason: 'fallback' },
    format,
    compiled?.outcome,
    {
      // 现编译抛错也是编译失败；只有「没有快照且压根没产出编译结果」才归 snapshot-missing。
      failure: snapshotRead.status === 'missing' && !compiled ? 'snapshot-missing' : 'compile',
      snapshotStatus,
    }
  );
}
