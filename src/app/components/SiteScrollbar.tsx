'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { usePathname } from 'next/navigation';

// 自绘滚动条。原生那条在经典滚动条的平台上要占掉 10~15px：长页面有、短页面没有，
// 锁滚动前后也没有 —— 布局视口宽度因此会变，`position: fixed` 的顶栏与居中内容跟着
// 横移半个滚动条。把原生那条藏掉（见 layout/_scrollbar.scss）之后宽度恒定，
// 这条自绘的从顶栏下沿开始、到视口底部结束；首页整屏是画，不显示。

const MIN_THUMB = 36;
/** 首页不显示滚动条：那一屏是整幅画面，条子会切在画面右缘。 */
const HIDE_ON = '/';

export default function SiteScrollbar() {
  const pathname = usePathname();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startScroll: number } | null>(null);
  const [scrollable, setScrollable] = useState(false);

  const sync = useCallback(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const viewport = window.innerHeight;
    const scrollH = document.documentElement.scrollHeight;
    const trackH = track.clientHeight;
    const maxScroll = scrollH - viewport;
    const next = maxScroll > 1 && trackH > MIN_THUMB;
    setScrollable((prev) => (prev === next ? prev : next));
    if (!next) return;
    const thumbH = Math.max(MIN_THUMB, Math.round((trackH * viewport) / scrollH));
    const offset = (window.scrollY / maxScroll) * (trackH - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${offset.toFixed(1)}px)`;
  }, []);

  useEffect(() => {
    sync();
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    // 内容长度会在首屏之后变化（列表补数据、图片撑开、详情展开），跟着重算。
    const observer = new ResizeObserver(onMove);
    const main = document.querySelector('main');
    if (main) observer.observe(main);
    // 字体换好之后行高会变一次。
    void document.fonts?.ready.then(onMove);
    // 首帧之后还有一次延迟很长的补算（骨架换真数据）。
    const settle = window.setTimeout(onMove, 600);
    return () => {
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
      observer.disconnect();
      window.clearTimeout(settle);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sync, pathname]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const travel = track.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startScroll: window.scrollY };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!state || !track || !thumb || state.pointerId !== event.pointerId) return;
    const travel = track.clientHeight - thumb.getBoundingClientRect().height;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    const next = state.startScroll + ((event.clientY - state.startY) * maxScroll) / travel;
    window.scrollTo(0, Math.max(0, Math.min(maxScroll, next)));
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  if (pathname === HIDE_ON) return null;

  return (
    <div className="site-scrollbar" ref={trackRef} aria-hidden="true">
      <div
        className={`site-scrollbar__thumb${scrollable ? '' : ' is-hidden'}`}
        ref={thumbRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
}
