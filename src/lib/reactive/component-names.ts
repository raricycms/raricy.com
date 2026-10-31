// ─────────────────────────────────────────────────────────────────────────────
// component-names.ts — 上游默认组件名的**构建期快照**（零运行时依赖）
//
// 为什么需要这份快照：`reactive-md` 是 ESM-only 且 `reactive-md/authoring` 没有
// CJS 入口；e2e 的 globalSetup / 部分脚本仍以 tsx(CJS) 运行，如果在
// `legacy-compat.ts` / `detect-format.ts` 顶层 import 子路径，整个 globalSetup 会在
// 加载阶段失败。兼容层只需要一份**名字集合**，不能因此把测试基建改成另一套。
//
// 【这不是第二份真相源】这份数组由脚本从上游 `LOCAL_COMPONENT_NAMES` 生成，
// `tests/unit/reactive-component-names.test.ts` 每次跑测试都会与上游逐项对账；
// 上游增删组件而这里没跟上 → 测试直接红。改这里必须同时改测试证据。
//
// 前端「Components」菜单仍应使用上游 catalog（`createLocalComponentCatalogForOptions`），
// 不要 import 这份快照去渲染菜单。
// ─────────────────────────────────────────────────────────────────────────────

export const SITE_REACTIVE_COMPONENT_NAMES = [
  'accordion', 'alert', 'anchor', 'badge', 'card', 'chart', 'checkbox', 'checklist',
  'choices', 'column', 'computed', 'const', 'coordinate', 'counter', 'data-table',
  'date', 'diagram', 'disclosure', 'edge', 'external', 'grid', 'if', 'input',
  'jump', 'multi-select', 'node', 'number', 'option', 'panel', 'plot', 'progress',
  'quiz', 'radio-group', 'range-slider', 'section', 'select', 'slider', 'step',
  'steps', 'tab', 'table', 'tabs', 'text', 'textarea', 'timeline', 'timer',
  'toggle', 'tooltip', 'validation',
] as const;

export const SITE_REACTIVE_COMPONENT_SET: ReadonlySet<string> = new Set(
  SITE_REACTIVE_COMPONENT_NAMES
);
