/**
 * 锁住页面滚动。
 *
 * 【为什么只有锁与放】锁滚动用的是 `body { overflow: hidden }`（经 overflow 传播作用
 * 在视口上），它会顺手把滚动条一起去掉。桌面端（有悬停、精确指针）已把原生那条换成
 * 自绘的（见 components/SiteScrollbar.tsx），它不占布局宽度、也不随锁滚动消失，所以
 * 这里不必量宽度、补内距 —— 补内距也挪不动 fixed 元素。其余平台原生条仍在，由
 * styles-scss/layout/_scrollbar.scss 让根元素常驻 scrollbar-gutter 抵掉宽度变化。
 *
 * 【按引用计数】六个入口（每日一言、图片放大、个人主页排版、窄屏博客侧栏、阅读器
 * 全屏、跨站 iframe 提示）可能同时在场：各自记 `previousOverflow` 的话，先关的那个会
 * 把 overflow 还原成空，外层还开着时页面就恢复了滚动。这里只在外层第一把锁进来时记
 * 原值、最后一把锁释放时还原。
 *
 * 【幂等】返回的释放函数重复调用只生效一次 —— 同一帧里既点关闭又卸载组件，不会重复计数。
 */

let lockCount = 0;
let previousOverflow = '';

/**
 * 锁住页面滚动。
 * @returns 幂等的还原函数
 */
export function lockPageScroll(): () => void {
  const body = document.body;
  if (lockCount === 0) {
    previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) body.style.overflow = previousOverflow;
  };
}
