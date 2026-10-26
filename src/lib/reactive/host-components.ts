// ─────────────────────────────────────────────────────────────────────────────
// host-components.ts — 站点宿主组件（`<site-embed>`）与编译选项的**唯一词汇表**
//
// 【只 import 类型，不 import 运行时】本模块要能被客户端组件（编辑器预览 /
// worker）直接 import，所以对 `reactive-md` 的依赖必须是 `import type`。这里
// 放的是纯数据与固定选项，没有任何 DOM / React / prisma。
//
// 【标签与属性名不能改】
//   · 适配器（ref-adapter.ts）输出的就是 `<site-embed kind="…" ref="…" />`；
//   · ReactiveMD 的 hostData 键由 `node.attrs.kind` + `node.attrs.ref` 拼成
//     `${kind}:${ref}`（计划 §5.2）。改属性名 → 数据永远取不到，页面只剩
//     `local-host-unavailable` 占位，且不报错。
//
// 【选项键只有一份实现：上游的 `localCompileOptionsKey()`】
// 缓存键与快照签名里的 optionsKey 都由 `localCompileOptionsKey(reactiveCompileOptions(…))`
// 现算（见 `compile.ts` 与 `snapshot-store.ts`），本模块**不另写一份**。
//
// 这里曾经有一个 `reactiveCompileOptionsKeyFor(format)` 的固定字符串实现，零调用点 —— 
// 那是「同一组选项」的第二个真相源：谁要是顺手改用它，缓存键与快照签名会悄悄换成
// 另一套字符串，命中率静默下降、快照全判 stale，且不报任何错。已删除，别再抄回来。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileOptions, LocalHostComponentSchema } from 'reactive-md';
import type { ContentFormat } from '../content-format';

/** 唯一允许作者/适配器产出的宿主标签。 */
export const SITE_EMBED_TAG = 'site-embed';

/**
 * 单篇文档的语法节点上限。改它要同步缓存键（见下方 options key）与页面提示。
 *
 * ★ **这是宿主进程的限速器，不是「能写多花」的额度 ★**
 *
 * `compileLocal` 是**同步**调用，直接跑在被 await 的页面渲染路径上（`compile.ts`），
 * Node 单线程 ⇒ 编译期间整个进程的其它请求一起排队。所以这个数直接等于「一份
 * 恶意 / 失控正文能把事件循环占多久」。
 *
 * 实测（`reactive-md@0.5.3`，单进程，中位数）：
 *   · 真实文章 250 KB → 5,378 节点 → 206 ms；
 *   · 密集语法 50 KB → 16,062 节点 → 354 ms；
 *   · 密集语法 250 KB → 28,954 节点 → 2,827 ms（峰值 4,707 ms）。
 *
 * 上游默认是 10,000。曾经设成 50,000（5×），后果是：**上游那个天然兜底被拆掉了**
 * —— 1 万预算下超过约 30 KB 的密集文档会被编译器以 `local.budget` 直接拒绝，提到
 * 5 万之后这些文档全部被接受，代价是秒级同步阻塞。
 *
 * 取 15,000 的理由：真实文章 250 KB 也只有 5,378 个节点，**正常内容远远用不到**；
 * 而 15,000 能把最坏情况压回数百毫秒量级，同时给「写得花哨一点」留出余量。
 * 调大之前先量冷编译 p50/p95 —— 数据要能支持这个决定。
 */
export const REACTIVE_MAX_SYNTAX_NODES = 15_000;

/** 精确编译包版本（进缓存键与诊断上报，不是 semver 范围）。 */
export const REACTIVE_COMPILER_VERSION = 'reactive-md/0.5.3';

/**
 * 宿主组件 schema。`kind` 是枚举、`ref` 是受限字符串，两者都静态（拒绝 `{{ }}`）。
 * `ref` 的 pattern 必须与适配器 `EMBED_REF_RE` 完全一致。
 */
export const SITE_EMBED_SCHEMA: LocalHostComponentSchema = {
  name: SITE_EMBED_TAG,
  form: 'leaf',
  props: {
    kind: {
      kind: 'enum',
      required: true,
      static: true,
      enum: ['audio', 'vote', 'favorite', 'clipboard'],
    },
    ref: {
      kind: 'string',
      required: true,
      static: true,
      pattern: '^[A-Za-z0-9]{1,32}$',
    },
  },
};

/**
 * 阅读页 / 预览共用的一份编译选项。
 *
 * `markdownBreaks` 只在 Markdown 文档为 true：存量 Markdown 的旧渲染器用
 * `breaks: true`，而 reactive 文档按语法本身解释单换行。两者不能共用一套。
 */
export function reactiveCompileOptions(format: ContentFormat): LocalCompileOptions {
  return {
    hostComponents: [SITE_EMBED_SCHEMA],
    limits: { maxSyntaxNodes: REACTIVE_MAX_SYNTAX_NODES },
    markdownBreaks: format === 'markdown',
  };
}
