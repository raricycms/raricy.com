'use client';

import { useEffect } from 'react';

// 全站滚轮平滑滚动：滚轮的一格一步换成 540ms 的缓动跟随。
// 曲线 cubic-bezier(0.16, 1, 0.3, 1) —— 起步快、收尾长距离减速。
//
// 覆盖任何滚轮滚动场景：整页滚动，以及代码块、表格、消息列表、虚拟滚动视图这些
// 内部滚动区域。两条冲突都由本文件处理：
//   · 自己接管滚轮的控件（行情图缩放、图片查看器）会 preventDefault，
//     这里看到 defaultPrevented 就直接退出；
//   · 键盘翻页与拖动滚动条要立刻生效，命中时停掉进行中的动画。
// 系统开启「减少动态效果」时完全不介入，保留浏览器原生滚动。
//
// 另有三条边界，改这里时容易踩：
//   · 锁滚看的是「视口还能不能被滚轮滚」：body{overflow:hidden} 只是把视口锁住，
//     根节点仍接受程序化写入，所以根节点兜底必须先和原生一样看视口的 overflow；
//   · Shift+滚轮在 Chromium 里仍报 deltaY，只是按横向解释；按轴选错就会把
//     窄表格 / HEX 查看器的横向滚动变成整页纵向滚动；
//   · 程序化平滑滚动（scrollTo / scrollIntoView）必须显式让位，见
//     releaseSmoothWheelScroll：一次 scrollTop 写入就会中止它。

const DURATION = 540;
const CURVE = [0.16, 1, 0.3, 1] as const;

type Axis = 'x' | 'y';

interface Anim {
  el: Element;
  axis: Axis;
  from: number;
  to: number;
  /** 本帧写下的位置：用来识别「位置被别的东西改了」 */
  written: number;
  /** 是否已经写过一帧：没写过时的位置偏差不说明「别人动了它」 */
  hasWritten: boolean;
  /** 最近一次输入的方向（±1）：反向输入要从当前可见位置重新起算 */
  direction: number;
  startedAt: number;
}

// 三次贝塞尔某一维在参数 t 处的坐标（两端固定为 0 和 1）
function bezierCoord(t: number, p1: number, p2: number): number {
  const rest = 1 - t;
  return 3 * rest * rest * t * p1 + 3 * rest * t * t * p2 + t * t * t;
}

// 时间进度 x → 位移比例。x 方向曲线单调，牛顿法几步就收敛。
function ease(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = CURVE;
  let t = x;
  for (let i = 0; i < 6; i += 1) {
    const diff = bezierCoord(t, x1, x2) - x;
    if (Math.abs(diff) < 1e-4) break;
    const slope = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (!(slope > 1e-4)) break;
    t = Math.min(1, Math.max(0, t - diff / slope));
  }
  return bezierCoord(t, y1, y2);
}

function readOffset(el: Element, axis: Axis): number {
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

function writeOffset(el: Element, axis: Axis, value: number): void {
  if (axis === 'y') el.scrollTop = value;
  else el.scrollLeft = value;
}

function offsetRange(el: Element, axis: Axis): { view: number; total: number } {
  return axis === 'y'
    ? { view: el.clientHeight, total: el.scrollHeight }
    : { view: el.clientWidth, total: el.scrollWidth };
}

// 这个元素在这一方向上是否允许用户滚动。overflow: hidden 的容器只接受程序化赋值，
// 滚轮不该在这里吞掉事件。
function acceptsWheel(el: Element, axis: Axis): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

// 还能不能朝 delta 的方向继续滚（正数向下/向右，负数向上/向左）
function hasRoom(el: Element, axis: Axis, delta: number): boolean {
  const { view, total } = offsetRange(el, axis);
  if (total - view <= 1) return false;
  return delta > 0 ? readOffset(el, axis) + view < total - 1 : readOffset(el, axis) > 1;
}

// 视口这一轴还能不能被滚轮滚动。html 的 overflow 不是 visible 时由它决定；否则
// body 的 overflow 会传给视口 —— DailyQuoteModal 与窄屏博客侧栏正是靠
// body{overflow:hidden} 锁滚，原生滚轮此时什么都不做，本组件也不能写 scrollTop。
function viewportScrollable(axis: Axis): boolean {
  const html = getComputedStyle(document.documentElement);
  let overflow = axis === 'y' ? html.overflowY : html.overflowX;
  if (overflow === 'visible' && document.body) {
    const body = getComputedStyle(document.body);
    overflow = axis === 'y' ? body.overflowY : body.overflowX;
  }
  return overflow !== 'hidden' && overflow !== 'clip';
}

// 从指针下的元素往上找第一个能朝这个方向滚动的区域，走到文档根用整页兜底。
// 遇到 overscroll-behavior: contain / none 的边界就停下 —— 滚动不往外交给外层。
// 边界检查不依赖「内容是否溢出」：HEX 查看器载入短文件时同样没有可滚距离，
// Chromium 仍会在它这里截住滚动链。
function findTarget(start: EventTarget | null, axis: Axis, delta: number): Element | null {
  let node = start instanceof Element ? start : null;
  while (node) {
    if (acceptsWheel(node, axis)) {
      if (hasRoom(node, axis, delta)) return node;
      const style = getComputedStyle(node);
      const chain = axis === 'y' ? style.overscrollBehaviorY : style.overscrollBehaviorX;
      if (chain === 'contain' || chain === 'none') return null;
    }
    node = node.parentElement;
  }
  const root = document.scrollingElement;
  return root && viewportScrollable(axis) && hasRoom(root, axis, delta) ? root : null;
}

// 键盘翻页用的键：命中时把滚动权立刻交还浏览器
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

// 让位入口的当前实现（组件挂载时填）。模块级是为了让组件外的按钮 / 自动到底
// 不用拿到组件实例就能先清掉动画。
let releaseImpl: ((target: Element | null) => void) | null = null;

/**
 * 让滚轮缓动给程序化滚动让位。
 *
 * 【为什么需要】scrollTo({behavior:'smooth'}) 还没更新出第一帧时，本组件一次
 * scrollTop 写入就会中止它（程序化赋值按规范会取消平滑滚动），而此时列表还没
 * 移动过，onScroll 的位置偏差识别也看不到任何异常 —— 讨论页「回到最新」就会
 * 停在半路，提示却已经消失。所以发起这类滚动之前先调这里清掉相关动画。
 * 不传 target 清全部（scrollIntoView 会滚到祖先滚动区，无法事先知道是谁）。
 */
export function releaseSmoothWheelScroll(target?: Element | null): void {
  releaseImpl?.(target ?? null);
}

export default function SmoothWheelScroll() {
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    // 一个元素同时只保留一条动画；跨方向的新输入接管旧的。
    const anims = new Map<Element, Anim>();
    let frame = 0;

    const step = (now: number) => {
      frame = 0;
      let alive = false;
      for (const [el, anim] of anims) {
        if (!el.isConnected) {
          anims.delete(el);
          continue;
        }
        // 两次写入之间位置被别的东西改了（原生平滑滚动、锚点、拖动滚动条、
        // 列表自动到底）：立刻让位，别用下一帧把新位置拽回去。
        // 自己还没写过一帧时不做这个判定：那说明外部滚动在首帧前就动了位置，
        // 此时删动画等于吞掉这一格、还不会写一下去取消对方（见 hasWritten）。
        if (anim.hasWritten && Math.abs(readOffset(el, anim.axis) - anim.written) > 2) {
          anims.delete(el);
          continue;
        }
        // 动画进行中视口被锁（弹窗 / 窄屏侧栏把 body 设为 overflow:hidden）：
        // 根节点仍接受程序化写入，继续写就是绕过锁滚滚背景。
        if (el === document.scrollingElement && !viewportScrollable(anim.axis)) {
          anims.delete(el);
          continue;
        }
        const progress = (now - anim.startedAt) / DURATION;
        if (progress >= 1) {
          writeOffset(el, anim.axis, anim.to);
          anims.delete(el);
          continue;
        }
        const value = anim.from + (anim.to - anim.from) * ease(progress);
        writeOffset(el, anim.axis, value);
        anim.written = value;
        anim.hasWritten = true;
        alive = true;
      }
      if (alive) frame = requestAnimationFrame(step);
    };

    // 连续滚动时新输入从当前可见位置起算、同向目标在原目标上累加，
    // 手感是「追着走」而不是一格一停。
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented || reduce.matches) return;
      const start = event.target instanceof Element ? event.target : null;
      // 下拉框用滚轮改选项，那不是滚动
      if (start?.closest('select')) return;

      // Shift+滚轮：Chromium 不交换 delta，只把 deltaY 解释成横向。按轴选错就会把
      // 横向容器（窄表格、HEX 查看器）的滚动变成整页纵向滚动。
      const shifted = event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY);
      const axis: Axis = shifted || Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'x' : 'y';
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? axis === 'y'
              ? window.innerHeight
              : window.innerWidth
            : 1;
      // 取主分量：Shift+斜向输入时 Chromium 仍只给 deltaY，但力度小/带倾斜的
      // 设备可能同时给一个很小的 deltaX —— 用 `deltaX || deltaY` 会把它当整次输入。
      const raw =
        axis === 'y'
          ? event.deltaY
          : Math.abs(event.deltaX) >= Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
      const delta = raw * unit;
      if (!delta) return;

      const el = findTarget(start, axis, delta);
      if (!el) return;
      event.preventDefault();

      const current = readOffset(el, axis);
      const pending = anims.get(el);
      // 同向输入在旧目标上累加；反向输入从当前可见位置重新起算，否则旧目标会把
      // 页面继续朝原方向拽（实测：下滚到 278px 后上滚 100px，仍走到 500px）。
      const sameDirection =
        pending !== undefined && pending.axis === axis && Math.sign(delta) === pending.direction;
      const base = sameDirection ? pending.to : current;
      const { view, total } = offsetRange(el, axis);
      const to = Math.max(0, Math.min(total - view, base + delta));
      anims.set(el, {
        el,
        axis,
        from: current,
        to,
        written: current,
        hasWritten: false,
        direction: Math.sign(delta),
        startedAt: performance.now(),
      });
      if (!frame) frame = requestAnimationFrame(step);
    };

    // 滚动位置被别人改了（锚点跳转、scrollIntoView、拖动滚动条、消息列表自动到底）：
    // 立刻让位，别用缓动的下一帧把新位置拽回去。整页滚动的事件目标是 document，
    // 内部容器是自己 —— 两种都要认。
    const onScroll = (event: Event) => {
      for (const [el, anim] of anims) {
        const sameOwner = event.target === el || (el === document.scrollingElement && event.target === document);
        if (!sameOwner) continue;
        if (anim.hasWritten && Math.abs(readOffset(el, anim.axis) - anim.written) > 2) anims.delete(el);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (anims.size === 0) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (SCROLL_KEYS.has(event.key)) anims.clear();
    };

    const release = (target: Element | null) => {
      if (!target) {
        anims.clear();
        return;
      }
      anims.delete(target);
    };
    releaseImpl = release;

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
      if (frame) cancelAnimationFrame(frame);
      anims.clear();
      if (releaseImpl === release) releaseImpl = null;
    };
  }, []);

  return null;
}
