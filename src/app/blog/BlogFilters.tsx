'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** 筛选条位于右栏，蒙版仍以视口两边为边界，包含滚动条宽度的变化。 */
export default function BlogFilters({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = host.current!;
    let frame = 0;
    function updateSticky() {
      frame = 0;
      element.classList.toggle('is-stuck', element.getBoundingClientRect().top <= parseFloat(getComputedStyle(element).top) + .5);
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(updateSticky);
    }
    function measure() {
      element.style.setProperty('--filters-left', `${element.getBoundingClientRect().left}px`);
      element.style.setProperty('--filters-viewport', `${document.documentElement.clientWidth}px`);
      updateSticky();
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(document.documentElement);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={host} className="blog-filters" aria-label="文章筛选">{children}</div>;
}
