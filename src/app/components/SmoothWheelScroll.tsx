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

// 从指针下的元素往上找第一个能朝这个方向滚动的区域，走到文档根用整页兜底。
// 遇到 overscroll-behavior: contain / none 的边界就停下 —— 滚动不往外交给外层。
function findTarget(start: EventTarget | null, axis: Axis, delta: number): Element | null {
  let node = start instanceof Element ? start : null;
  while (node) {
    if (acceptsWheel(node, axis)) {
      const { view, total } = offsetRange(node, axis);
      if (total - view > 1) {
        if (hasRoom(node, axis, delta)) return node;
        const style = getComputedStyle(node);
        const chain = axis === 'y' ? style.overscrollBehaviorY : style.overscrollBehaviorX;
        if (chain === 'contain' || chain === 'none') return null;
      }
    }
    node = node.parentElement;
  }
  const root = document.scrollingElement;
  return root && hasRoom(root, axis, delta) ? root : null;
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
        const progress = (now - anim.startedAt) / DURATION;
        if (progress >= 1) {
          writeOffset(el, anim.axis, anim.to);
          anims.delete(el);
          continue;
        }
        const value = anim.from + (anim.to - anim.from) * ease(progress);
        writeOffset(el, anim.axis, value);
        anim.written = value;
        alive = true;
      }
      if (alive) frame = requestAnimationFrame(step);
    };

    // 连续滚动时新输入从当前可见位置起算、目标在原目标上累加，
    // 手感是「追着走」而不是一格一停。
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented || reduce.matches) return;
      const start = event.target instanceof Element ? event.target : null;
      // 下拉框用滚轮改选项，那不是滚动
      if (start?.closest('select')) return;

      const axis: Axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'x' : 'y';
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? axis === 'y'
              ? window.innerHeight
              : window.innerWidth
            : 1;
      const delta = (axis === 'y' ? event.deltaY : event.deltaX) * unit;
      if (!delta) return;

      const el = findTarget(start, axis, delta);
      if (!el) return;
      event.preventDefault();

      const current = readOffset(el, axis);
      const pending = anims.get(el);
      const base = pending && pending.axis === axis ? pending.to : current;
      const { view, total } = offsetRange(el, axis);
      const to = Math.max(0, Math.min(total - view, base + delta));
      anims.set(el, { el, axis, from: current, to, written: current, startedAt: performance.now() });
      if (!frame) frame = requestAnimationFrame(step);
    };

    // 滚动位置被别人改了（锚点跳转、scrollIntoView、拖动滚动条、消息列表自动到底）：
    // 立刻让位，别用缓动的下一帧把新位置拽回去。整页滚动的事件目标是 document，
    // 内部容器是自己 —— 两种都要认。
    const onScroll = (event: Event) => {
      for (const [el, anim] of anims) {
        const sameOwner = event.target === el || (el === document.scrollingElement && event.target === document);
        if (!sameOwner) continue;
        if (Math.abs(readOffset(el, anim.axis) - anim.written) > 2) anims.delete(el);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (anims.size === 0) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (SCROLL_KEYS.has(event.key)) anims.clear();
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
      if (frame) cancelAnimationFrame(frame);
      anims.clear();
    };
  }, []);

  return null;
}
