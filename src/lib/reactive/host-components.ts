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
// 【选项键是站内自己维护的固定签名】
// 上游的 `localCompileOptionsKey()` 是运行时代码；为了保持本模块客户端可用，
// 这里不调用它（`cache.ts` 头部也写明不要另行重写它的通用算法）。站点选项只有
// 一个变量（`markdownBreaks`），宿主 schema 与节点预算都是编译期常量，所以用
// 一个带版本前缀的固定签名即可。**改选项形状时必须递增 `SITE_OPTIONS_KEY_VERSION`**
// —— 缓存键同时含 `REACTIVE_COMPILER_VERSION`，升级包也会自然换键。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileOptions, LocalHostComponentSchema } from 'reactive-md';
import type { ContentFormat } from '../content-format';

/** 唯一允许作者/适配器产出的宿主标签。 */
export const SITE_EMBED_TAG = 'site-embed';

/**
 * 单篇文档的语法节点上限。与计划 D1 一致；改它要同步缓存键（见下方 options key）
 * 与页面提示。
 */
export const REACTIVE_MAX_SYNTAX_NODES = 50_000;

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

/** 站内固定选项的签名版本；改 `reactiveCompileOptions` 的形状时递增。 */
const SITE_OPTIONS_KEY_VERSION = 'site-embed-options/1';

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

/**
 * 与 `reactiveCompileOptions(format)` 一一对应的稳定键（进编译缓存键）。
 * 不读运行时对象、不依赖键顺序 —— 相同 format 必须永远得到同一个字符串。
 */
export function reactiveCompileOptionsKeyFor(format: ContentFormat): string {
  return [
    SITE_OPTIONS_KEY_VERSION,
    SITE_EMBED_TAG,
    String(REACTIVE_MAX_SYNTAX_NODES),
    format === 'markdown' ? 'breaks' : 'plain',
  ].join(':');
}
