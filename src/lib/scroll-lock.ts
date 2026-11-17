/**
 * 锁住页面滚动，同时保持布局视口宽度不变。
 *
 * 【为什么需要这一层】锁滚动只能靠 `body { overflow: hidden }`（它会经 overflow 传播
 * 落到视口上）。带经典滚动条的平台上一锁，滚动条当场消失、布局视口宽出 10~15px：
 * 居中的正文右移半个滚动条，`position: fixed` 的顶栏因为 `left/right: 0` 跟着变宽，
 * 顶栏里的内容同样右移 —— 读数就是「打开弹层，顶栏和页面一起抖几像素」。
 *
 * 【宽度恒定由样式层负责】根元素常驻 `scrollbar-gutter: stable`（见 base/_root.scss），
 * 滚动条槽一直在，锁滚动时布局视口宽度不变，fixed 顶栏与居中内容都不会动。
 * 所以这里只做「锁 / 放」两件事，不量滚动条、不补内距 —— 补内距挪不动 fixed 元素。
 *
 * 【怎么用】在锁之前调用，拿到还原函数；cleanup 里调用它。还原函数幂等：
 * 同一帧里既点关闭又卸载组件，不会互相把样式覆盖回去。
 */

/**
 * 锁住页面滚动，并保持布局视口宽度不变。
 * @returns 幂等的还原函数
 */
export function lockPageScroll(): () => void {
  const body = document.body;
  const previousOverflow = body.style.overflow;
  body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    body.style.overflow = previousOverflow;
  };
}
