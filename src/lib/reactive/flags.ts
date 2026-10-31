/**
 * 阅读渲染的**事故回退开关**。
 *
 * 2026-11 起博客与云剪贴板默认全量使用 ReactiveMD：不读环境变量也是启用状态。
 * `REACTIVE_MD_MODE=off` 只用于迁移 / 事故回退，把 **Markdown** 文档临时交回旧
 * 渲染器；Reactive 源文任何情况下都不会进入旧解析器。
 *
 * `percent` 与 `shadow` 保留为历史字段：百分比灰度不再参与选择，`shadow` 等同
 * 启用（不再做影子编译）。最终常规路径不按兼容警告切回旧引擎。
 */
export interface ReactiveFlags {
  mode: 'off' | 'shadow' | 'on';
  /** 已废弃：仅保留环境变量兼容，选择器不再读取。 */
  percent: number;
}

export function parseReactiveFlags(env: Readonly<Record<string, string | undefined>>): ReactiveFlags {
  const mode = env.REACTIVE_MD_MODE;
  const rawPercent = env.REACTIVE_MD_PERCENT;
  const percent = rawPercent !== undefined && /^\d{1,3}$/.test(rawPercent) ? Number(rawPercent) : 100;
  return {
    // 默认启用：未设置、`on`、`shadow` 都走统一管线；只有显式 `off` 回退。
    mode: mode === 'off' ? 'off' : mode === 'shadow' ? 'shadow' : 'on',
    percent: percent >= 0 && percent <= 100 ? percent : 100,
  };
}
