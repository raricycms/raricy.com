/**
 * 锁住页面滚动。
 *
 * 【为什么只有锁与放】锁滚动用的是 `body { overflow: hidden }`（经 overflow 传播作用
 * 在视口上），它会顺手把滚动条一起去掉。桌面端（有悬停、精确指针）已把原生那条换成
 * 自绘的（见 components/SiteScrollbar.tsx），它不占布局宽度、也不随锁滚动消失，所以
 * 这里不必量宽度、补内距 —— 补内距也挪不动 fixed 元素。其余平台原生条仍在，由
 * styles-scss/layout/_scrollbar.scss 让根元素常驻 scrollbar-gutter 抵掉宽度变化。
 *
 * 【可嵌套】浮层可能叠着出现（详情层里再开一个面板），卸载顺序也不保证与打开相反：
 * 用模块级计数，第一个锁记下原值、最后一个释放才还原。返回的释放函数幂等 ——
 * 同一帧里既点关闭又卸载组件，不会重复计数。
 */

let locks = 0;
let previousOverflow = '';

/**
 * 锁住页面滚动。
 * @returns 幂等的还原函数
 */
export function lockPageScroll(): () => void {
  if (locks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) document.body.style.overflow = previousOverflow;
  };
}
