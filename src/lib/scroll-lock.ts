/**
 * 锁住页面滚动。
 *
 * 【为什么只有锁与放】锁滚动用的是 `body { overflow: hidden }`（经 overflow 传播作用
 * 在视口上），它会顺手把滚动条一起去掉。原生滚动条一旦存在就占 10~15px，去掉之后布局
 * 视口变宽，`position: fixed` 的顶栏与居中内容会横移半个滚动条。桌面端现在把原生那条
 * 换成了自绘的（见 components/SiteScrollbar.tsx），它不占布局宽度、也不随锁滚动消失，
 * 所以这里不必再量宽度、补内距 —— 补内距挪不动 fixed 元素。
 *
 * 【怎么用】在锁之前调用，拿到还原函数；cleanup 里调用它。还原函数幂等：
 * 同一帧里既点关闭又卸载组件，不会互相把样式覆盖回去。
 *
 * 【按引用计数】四个入口（每日一言、图片放大、个人主页排版、窄屏博客侧栏）可能同时
 * 在场：各自记 `previousOverflow` 的话，先关的那个会把 overflow 还原成空，外层还开着
 * 时页面就恢复了滚动。这里只在外层第一把锁进来时记原值、最后一把锁释放时还原。
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
