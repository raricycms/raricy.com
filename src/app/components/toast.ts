// 全局 toast 的唯一入口。
//
// 站内 toast 由 `public/static/js/core/base.js` 注入到 `window.showToast`；组件侧只做一次
// 存在性判断：脚本没跑起来时静默跳过，不因为反馈层缺失而打断业务动作。
// 只能在浏览器侧调用 —— 服务端渲染期间没有 `window`，不存在「静默跳过」这回事。

export function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}
