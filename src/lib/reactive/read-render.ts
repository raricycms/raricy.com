// ─────────────────────────────────────────────────────────────────────────────
// read-render.ts — 阅读页（博客 / 剪贴板）的**唯一渲染决策入口**（服务端）
//
// 它只做三件事，顺序固定：
//   1. 读 flag，解析存储格式（`parseContentFormat`：认不出就是认不出，不猜 markdown）；
//   2. 把决定权交给 `selectContentRenderer`（灰度 / override / 回退的规则只住那里，
//      这里**不复制**任何一份 cohort 或 override 判定）；
//   3. 需要编译时调 `compileReactiveSource`，用 `shouldFallbackToLegacy` 把
//      「编译通过但语义不兼容」也算进回退判据。
//
// ── 五条「错了也不报错」的纪律 ────────────────────────────────────────────────
//
// 【1】reactive 源码**永不**交给旧 Markdown 渲染器。格式认不出 → `unavailable`；
//   编译失败 → `unavailable`；能编译但不能交互 → 服务端现算的 `reactive-static`。
//   把 reactive 源文喂给 marked 不会抛错，只会把 `{{ }}` / 组件标签当成普通文本
//   显示出来 —— 这正是最难被发现的那种坏页面。
//
// 【2】reactive 的静态正文**优先读同版本持久快照**（`reactive_snapshots`），读不到
//   才按**当前正文**现编译一次。两者都不会把旧版本正文冒充成当前正文：版本 /
//   编译签名不符的快照在 `snapshot-store.ts` 里按 stale 拒读。绝不在服务端用
//   `react-dom/server` 现拼 HTML（Next 的 RSC 编译链会拒绝）。
//
// 【3】markdown 只有在**候选**（override=reactive 或命中灰度）时才编译。候选之外
//   的 markdown 直接 legacy —— 否则每一次阅读都要为一次「反正会回退」的编译付费。
//
// 【4】`markdownCompatible` 必须由 `shouldFallbackToLegacy` 给出，不能只看 `ok`。
//   `local.html` / `local.component.unknown` 会在 `ok: true` 的情况下静默改变可见
//   内容（HTML 标签降级成源码文本），这正是 D4 的判据。
//
// 【5】日志只写结构化字段（renderer / reason / codes / 耗时 / 缓存命中 / 快照状态），
//   **不写正文、不写标题**。这些是运维台账，不是内容副本。
// ─────────────────────────────────────────────────────────────────────────────

import { parseContentFormat, type ContentFormat } from '../content-format';
import { selectContentRenderer, type RendererChoice } from '../renderer-select';
import { parseReactiveFlags } from './flags';
import { compileReactiveSource, type ReactiveCompileOutcome } from './compile';
import { shouldFallbackToLegacy } from './diagnostics';
import { hasMutableExternalReferences, hostDataEqual } from './snapshot-revalidation';
import {
  reactiveContentVersion,
  readReactiveSnapshot,
  type SnapshotPayload,
} from './snapshot-store';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';

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
  /** 本次编译产物；reactive 与 reactive-static 都由它渲染。 */
  bundle?: ReactiveCompileOutcome;
  /** 持久快照（仅 reactive-static 且版本匹配时）；优先于 bundle。 */
  snapshot?: SnapshotPayload;
  failure?: 'compile' | 'snapshot-missing' | 'snapshot-references' | 'invalid-format' | 'invalid-override';
  log: {
    renderer: string;
    reason: string;
    format: string | null;
    codes: string[];
    compileMs: number;
    cacheHit: boolean;
    snapshotStatus: string;
  };
}

/**
 * 选择器只比较「内容版本 == 快照版本」这两个标记；真正的版本 / 编译签名校验在
 * `readReactiveSnapshot` 里做。这里传同一个常量表示「调用方没有额外的版本要求」，
 * 不会被 `selectContentRenderer` 误判成 snapshot-missing。
 */
const SELECTION_VERSION = 'current';

/**
 * 把一次选择落成结果：生成日志、记录失败原因。
 * `overrideChoice` 用于「编译失败后必须换成 unavailable」这类二次判定。
 */
function finish(
  choice: RendererChoice,
  format: ContentFormat | null,
  bundle: ReactiveCompileOutcome | undefined,
  extra?: {
    failure?: ReadRenderResult['failure'];
    snapshot?: SnapshotPayload;
    snapshotStatus?: string;
  },
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
  // 只写结构化字段：不打印 source / 标题 / 任何正文片段。
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
 *
 * 返回 `keep`    = 引用数据与快照一致，快照可用；
 *      `replace` = 有变化（改私密 / 删除 / 改标题 / 改版本 / 新公开），旧快照作废；
 *      `untrusted` = 读当前权限时失败 —— 这时**旧引用数据同样不可信**（可能正好是
 *                    权限变动导致的那次故障），不能继续用快照，只能现编译。
 *
 * 没有剪贴板引用时直接 `keep`：音频 / 图床 / 投票 / 收藏夹的 external 形态不随
 * 权限变化，快照快速路径一次库都不查。
 */
async function revalidateSnapshotReferences(
  input: ReadRenderInput,
  snapshotHostData: SnapshotPayload['hostData'],
): Promise<'keep' | 'replace' | 'untrusted'> {
  if (!hasMutableExternalReferences(input.source)) return 'keep';
  try {
    // 延迟加载：`prepare` 会拖进剪贴板 / 投票 / 收藏夹三个 service；只在真正
    // 需要重验时付这份模块成本（与 publish.ts 的动态 import 同一理由）。
    const { prepareReactiveDocument } = await import('./prepare');
    const prepared = await prepareReactiveDocument(input.source, {
      mode: 'external',
      viewer: input.viewer,
      clientIp: input.clientIp,
    });
    return hostDataEqual(prepared.hostData, snapshotHostData) ? 'keep' : 'replace';
  } catch {
    return 'untrusted';
  }
}

/**
 * reactive 的静态分支：先重验快照引用，再决定用快照还是现编译。
 *
 * 为什么先快照：快照是发布那一刻的可信产物，读取时不需要重编译；版本 / 编译签名
 * 不符的快照按 missing 处理，绝不拿旧正文冒充当前正文。为什么还要重验引用：快照
 * 里的公开剪贴板数据会随作者改权限 / 改标题而过期，见 `snapshot-revalidation.ts`。
 *
 * 引用不一致时按**当前 external 权限重新编译**，而不是修补旧 hostData —— 后者会
 * 既留下旧标题、又把「改私密」的引用继续当可用；新公开的引用也只有重编译才会出现。
 * 读失败时同样不用快照：那时无法确认任何引用数据仍然有效。
 *
 * 静态形态交给客户端组件的 `mode="static"`（SSR 首屏即静态正文，无 JS 也可读）。
 * 不在服务端调 `react-dom/server`：Next 的 RSC 编译链会拒绝它（构建期失败）。
 */
async function buildStatic(
  input: ReadRenderInput,
  choice: RendererChoice,
  format: ContentFormat,
  bundle: ReactiveCompileOutcome | undefined,
  compile: () => Promise<ReactiveCompileOutcome>,
  compileExternal: () => Promise<ReactiveCompileOutcome>,
): Promise<ReadRenderResult> {
  const syntaxVersion =
    format === 'reactive' ? (input.syntaxVersion ?? LOCAL_SYNTAX_VERSION) : LOCAL_SYNTAX_VERSION;
  const contentVersion = reactiveContentVersion(format, syntaxVersion, input.source);
  const snapshot = await readReactiveSnapshot(input.kind, input.id, contentVersion);
  if (snapshot.status === 'ready') {
    const verdict = await revalidateSnapshotReferences(input, snapshot.payload.hostData);
    if (verdict === 'keep') {
      return finish({ renderer: 'reactive-static', reason: choice.reason }, format, bundle, {
        snapshot: snapshot.payload,
        snapshotStatus: 'ready',
      });
    }

    // 旧快照的引用数据不可信 —— 按当前 external 权限重编一份替代它。
    let replacement: ReactiveCompileOutcome | undefined;
    try {
      replacement = await compileExternal();
    } catch {
      replacement = undefined;
    }
    const snapshotStatus =
      verdict === 'untrusted' ? 'untrusted-references' : 'stale-references';
    if (replacement?.result.ok && replacement.result.document) {
      return finish({ renderer: 'reactive-static', reason: choice.reason }, format, replacement, {
        snapshotStatus,
      });
    }
    return finish({ renderer: 'unavailable', reason: choice.reason }, format, replacement, {
      failure: verdict === 'untrusted' ? 'snapshot-references' : 'compile',
      snapshotStatus,
    });
  }

  if (!bundle) {
    try {
      bundle = await compile();
    } catch {
      bundle = undefined;
    }
  }
  if (bundle?.result.ok && bundle.result.document) {
    return finish({ renderer: 'reactive-static', reason: choice.reason }, format, bundle, {
      snapshotStatus: snapshot.status,
    });
  }
  return finish({ renderer: 'unavailable', reason: choice.reason }, format, bundle, {
    // 编译真的失败时优先报 compile；只有「没快照、也没能编出一份当前正文」才归为
    // snapshot-missing（运维据此区分「包/内容问题」与「发布链路没生成快照」）。
    failure:
      snapshot.status === 'missing' && (!bundle || bundle.result.ok)
        ? 'snapshot-missing'
        : 'compile',
    snapshotStatus: snapshot.status,
  });
}

export async function resolveReadRender(input: ReadRenderInput): Promise<ReadRenderResult> {
  const flags = parseReactiveFlags(process.env);
  const format = parseContentFormat(input.format);

  const selectionBase = {
    kind: input.kind,
    id: input.id,
    format: input.format,
    override: input.override,
    flags,
    contentVersion: SELECTION_VERSION,
    snapshotVersion: SELECTION_VERSION,
  };

  // 认不出的格式不是 markdown（见文件头【1】）。
  if (!format) {
    return finish(
      selectContentRenderer({ ...selectionBase, markdownCompatible: true }),
      null,
      undefined,
      { failure: 'invalid-format' },
    );
  }

  const compile = () =>
    compileReactiveSource({
      source: input.source,
      format,
      mode: input.mode,
      viewer: input.viewer,
      clientIp: input.clientIp,
    });

  const compileExternal = () => compileReactiveSource({ source: input.source, format, mode: 'external', viewer: input.viewer, clientIp: input.clientIp });

  if (format === 'markdown') {
    // flag 关 / override=legacy / 未命中灰度都在这一步直接落 legacy，不编译。
    const tentative = selectContentRenderer({ ...selectionBase, markdownCompatible: true });
    if (tentative.renderer !== 'reactive') {
      return finish(tentative, format, undefined, {
        ...(tentative.reason === 'invalid-override' ? { failure: 'invalid-override' } : {}),
      });
    }

    let bundle: ReactiveCompileOutcome | undefined;
    try {
      bundle = await compile();
    } catch {
      bundle = undefined;
    }
    // 编译失败 / 命中回退码 → markdownCompatible=false → 选择器给回 legacy。
    const compatible = !!bundle && bundle.result.ok && !shouldFallbackToLegacy(bundle.result);
    const choice = selectContentRenderer({ ...selectionBase, markdownCompatible: compatible });
    return finish(choice, format, bundle, {
      ...(choice.reason === 'fallback' && (!bundle || !bundle.result.ok)
        ? { failure: 'compile' as const }
        : {}),
    });
  }

  // ── reactive：flag=on 时实时编译（expand 权限）；其余分支走静态快照 ─────────
  const tentative = selectContentRenderer(selectionBase);

  if (tentative.renderer === 'reactive') {
    let bundle: ReactiveCompileOutcome | undefined;
    try {
      bundle = await compile();
    } catch {
      bundle = undefined;
    }
    const failed = !bundle || !bundle.result.ok || shouldFallbackToLegacy(bundle.result);
    const choice = selectContentRenderer({ ...selectionBase, compilationFailed: failed });
    if (choice.renderer === 'reactive') return finish(choice, format, bundle);
    // 编译失败或语义不兼容 → 同版本静态快照，绝不退回旧 Markdown。
    return buildStatic(input, choice, format, bundle, compile, compileExternal);
  }

  // flag 关 / 未命中灰度 / 脏 override：选择器已经判为 reactive-static。
  return buildStatic(input, tentative, format, undefined, compile, compileExternal);
}
