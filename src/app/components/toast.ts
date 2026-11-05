// 全局 toast 的唯一入口。
//
// 站内 toast 由 `public/static/js/core/base.js` 注入到 `window.showToast`；组件侧只做一次
// 存在性判断：脚本没跑起来（或服务端渲染期间的调用点被提前执行）时静默跳过，
// 不因为反馈层缺失而打断业务动作。

export function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}
