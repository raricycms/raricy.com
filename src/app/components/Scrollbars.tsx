'use client';

import { useEffect } from 'react';

// 局部滚动容器的自绘滚动条。页面级那条见 SiteScrollbar（读 window），这里负责
// 页内所有 `overflow-y: auto / scroll` 的盒子：下拉列表、选择器面板、编辑器预览、
// 评论区、聊天区、后台侧栏……
//
// 【为什么注入而不是改结构】滑块是绝对定位的子元素，不占布局；滚动容器本身不包
// wrapper，类名与子结构都不动 —— e2e 与样式里那些「直接子元素」选择器才不受影响。
// 代价是滑块会跟着内容一起滚，所以每次 scroll 都要把它按 scrollTop 反向抵消一次。
//
// 原生那条由 `.scroll-port` 隐藏（CSS 见 base/_root.scss），剩下的全是这一层，
// 视觉与交互（悬停两倍宽、按下变二级色、默认指针）与页面级那条同参。

const MIN_THUMB = 32;
const SKIP = new Set(['HTML', 'BODY']);

type Port = {
  el: HTMLElement;
  thumb: HTMLDivElement;
  onScroll: () => void;
  observer: ResizeObserver;
  cleanup: () => void;
};

function isScrollPort(el: HTMLElement): boolean {
  if (SKIP.has(el.tagName)) return false;
  if (el.dataset.scrollPort) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll';
}

function mount(el: HTMLElement): Port | null {
  if (!isScrollPort(el)) return null;
  el.dataset.scrollPort = '1';
  el.classList.add('scroll-port');
  // 只有原本是 static 的容器才补定位上下文；absolute/fixed 的容器本身就是上下文，
  // 改它的 position 会把布局挪走。
  if (getComputedStyle(el).position === 'static') el.classList.add('scroll-port--static');

  const thumb = document.createElement('div');
  thumb.className = 'scroll-port__thumb is-hidden';
  el.appendChild(thumb);

  let dragging: { pointerId: number; startY: number; startScroll: number } | null = null;

  const sync = () => {
    const height = el.clientHeight;
    const scrollH = el.scrollHeight;
    if (scrollH <= height + 1 || height < MIN_THUMB) {
      thumb.classList.add('is-hidden');
      return;
    }
    thumb.classList.remove('is-hidden');
    const thumbH = Math.max(MIN_THUMB, Math.round((height * height) / scrollH));
    const offset = (el.scrollTop / (scrollH - height)) * (height - thumbH);
    thumb.style.height = `${thumbH}px`;
    // 抵消容器自身的滚动位移：滑块永远贴在可视区的这一格上。
    thumb.style.transform = `translateY(${(el.scrollTop + offset).toFixed(1)}px)`;
  };

  const onScroll = () => sync();

  const onPointerDown = (event: PointerEvent) => {
    const scrollH = el.scrollHeight;
    const travel = el.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = scrollH - el.clientHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    dragging = { pointerId: event.pointerId, startY: event.clientY, startScroll: el.scrollTop };
    thumb.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const travel = el.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    el.scrollTop = dragging.startScroll + ((event.clientY - dragging.startY) * maxScroll) / travel;
    event.preventDefault();
  };

  const onPointerUp = () => {
    dragging = null;
  };

  thumb.addEventListener('pointerdown', onPointerDown);
  thumb.addEventListener('pointermove', onPointerMove);
  thumb.addEventListener('pointerup', onPointerUp);
  thumb.addEventListener('pointercancel', onPointerUp);

  el.addEventListener('scroll', onScroll, { passive: true });

  const observer = new ResizeObserver(() => requestAnimationFrame(sync));
  observer.observe(el);
  // 内容变化（列表补数据、图片撑开）不改变容器尺寸，靠 MutationObserver 兜住。
  const mutation = new MutationObserver(() => requestAnimationFrame(sync));
  mutation.observe(el, { childList: true, subtree: true, characterData: true });

  requestAnimationFrame(sync);

  return {
    el,
    thumb,
    onScroll,
    observer,
    cleanup: () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      mutation.disconnect();
      thumb.remove();
      el.classList.remove('scroll-port', 'scroll-port--static');
      delete el.dataset.scrollPort;
    },
  };
}

export default function Scrollbars() {
  useEffect(() => {
    const ports = new Map<HTMLElement, Port>();

    const scan = () => {
      document.querySelectorAll<HTMLElement>('div, ul, ol, section, aside, article, nav, pre').forEach((el) => {
        if (ports.has(el)) return;
        const port = mount(el);
        if (port) ports.set(el, port);
      });
    };

    scan();
    // 弹层、下拉、消息都是后出现的：DOM 一变就补扫一次（同一帧只跑一次）。
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      ports.forEach((port) => port.cleanup());
      ports.clear();
    };
  }, []);

  return null;
}
