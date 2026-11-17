/**
 * 锁住页面滚动，并把滚动条让出的宽度补回来。
 *
 * 【为什么需要】锁滚动用的是 `body { overflow: hidden }`，它会经 CSS 的 overflow
 * 传播落到视口上：经典滚动条的平台上（Windows / Linux 的桌面浏览器）那一条滚动条
 * 当场消失，视口宽出 10~15px，居中的正文整体右移半个滚动条 —— 读数就是「打开弹层，
 * 页面往右抖一下」，关掉再抖回来。用 padding-right 补上同样的宽度，宽度回到锁之前。
 *
 * 【怎么用】在锁之前调用，拿到还原函数；cleanup 里调用它。还原函数幂等：
 * 同一帧里既点关闭又卸载组件，不会互相把样式覆盖回去。
 *
 * 覆盖层本身是 fixed，不参与这层补偿；补偿的是它背后那一页。
 */

/**
 * 锁住页面滚动并补回滚动条宽度。
 * @returns 幂等的还原函数
 */
export function lockPageScroll(): () => void {
  const body = document.body;
  const previousOverflow = body.style.overflow;
  const previousPaddingRight = body.style.paddingRight;
  // 先量再加：此刻滚动条还在，量到的才是它真正的宽度。
  const gap = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = 'hidden';
  if (gap > 0) {
    const current = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + gap}px`;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    body.style.overflow = previousOverflow;
    body.style.paddingRight = previousPaddingRight;
  };
}
