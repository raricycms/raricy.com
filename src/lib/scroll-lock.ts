/**
 * 锁住页面滚动，同时让布局视口的宽度保持不变。
 *
 * 【为什么需要这一层】锁滚动只能靠 `body { overflow: hidden }`（它会经 overflow 传播
 * 落到视口上）。带经典滚动条的平台上一锁，滚动条当场消失、布局视口宽出 10~15px：
 * 居中的正文右移半个滚动条，`position: fixed` 的顶栏因为 `left/right: 0` 跟着变宽，
 * 顶栏里的内容同样右移 —— 读数就是「打开弹层，顶栏和页面一起抖几像素」。
 *
 * 【为什么用 scrollbar-gutter 而不是补内距】补 `padding-right` 只挪得动 body 里的内容，
 * 挪不动 fixed 顶栏；而且每个用到它的组件都得自己量一次、自己记还原值。
 * `scrollbar-gutter: stable` 让根元素把滚动条那条槽一直占着：锁滚动时槽还在，
 * 布局视口宽度、fixed 元素宽度、居中内容位置全都不动，一处解决。
 * 槽只在「本来就有滚动条」时才占（没有滚动条的短页面占了会凭空变窄）。
 *
 * 【怎么用】在锁之前调用，拿到还原函数；cleanup 里调用它。还原函数幂等：
 * 同一帧里既点关闭又卸载组件，不会互相把样式覆盖回去。
 */

/**
 * 锁住页面滚动，并保持布局视口宽度不变。
 * @returns 幂等的还原函数
 */
export function lockPageScroll(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const previousOverflow = body.style.overflow;
  const previousGutter = root.style.scrollbarGutter;
  // 先判有没有滚动条：没有的话不占槽，否则内容会无端窄一条。
  if (window.innerWidth - root.clientWidth > 0) root.style.scrollbarGutter = 'stable';
  body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 同一帧里两件事一起做：滚动条回来、槽位撤掉，宽度始终是同一个值。
    body.style.overflow = previousOverflow;
    root.style.scrollbarGutter = previousGutter;
  };
}
