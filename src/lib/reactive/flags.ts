/**
 * 阅读渲染的**事故回退开关**。
 *
 * 2026-11 起博客与云剪贴板默认全量使用 ReactiveMD：不读环境变量也是启用状态。
 * `REACTIVE_MD_MODE=off` 只用于迁移 / 事故回退，把 **Markdown** 文档临时交回旧
 * 渲染器；Reactive 源文任何情况下都不会进入旧解析器。
 *
 * 只有 `off` 有意义：历史部署里的 `shadow`、百分比灰度等取值一律按启用处理，
 * 不报错也不再参与选择（内部只保留 off / on 两态）。
 */
export interface ReactiveFlags {
  mode: 'off' | 'on';
}

export function parseReactiveFlags(env: Readonly<Record<string, string | undefined>>): ReactiveFlags {
  return { mode: env.REACTIVE_MD_MODE === 'off' ? 'off' : 'on' };
}
