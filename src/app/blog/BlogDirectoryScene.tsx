'use client';

import { useEffect, useRef } from 'react';

/** 原创书页场景。不同景深连接展开的书页与纸飞机，文字和表单不跟着位移。 */
export default function BlogDirectoryScene() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const scene = ref.current;
    const hero = scene?.closest<HTMLElement>('.blogs-hero');
    if (!scene || !hero) return;
    const layers = Array.from(scene.querySelectorAll<SVGGElement>('[data-depth]'))
      .map((element) => ({ element, depth: Number(element.dataset.depth) }));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    let frame = 0;
    let visible = true;
    let targetX = 0;
    let targetY = 0;
    let targetScroll = 0;
    let x = 0;
    let y = 0;
    let scroll = 0;

    function schedule() {
      if (!frame && visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(animate);
    }
    function animate() {
      frame = 0;
      x += (targetX - x) * 0.09;
      y += (targetY - y) * 0.09;
      scroll += (targetScroll - scroll) * 0.09;
      const settling = Math.abs(targetX - x) + Math.abs(targetY - y) + Math.abs(targetScroll - scroll) > 0.001;
      if (!settling) { x = targetX; y = targetY; scroll = targetScroll; }
      for (const { element, depth } of layers) {
        element.style.transform = `translate(${x * depth * 14}px, ${y * depth * 9 - scroll * depth * 52}px) rotate(${x * depth * 0.8}deg)`;
      }
      if (settling) schedule();
    }
    function updateScroll() {
      const rect = hero!.getBoundingClientRect();
      const navbarHeight = parseFloat(getComputedStyle(document.body).paddingTop) || 62;
      targetScroll = Math.max(0, Math.min(1, (navbarHeight - rect.top) / rect.height));
      schedule();
    }
    function move(event: PointerEvent) {
      if (!finePointer.matches || event.pointerType !== 'mouse' || reduced.matches) return;
      const rect = hero!.getBoundingClientRect();
      targetX = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
      targetY = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
      schedule();
    }
    function resetPointer() { targetX = targetY = 0; schedule(); }
    function syncPreference() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (reduced.matches) {
        x = y = scroll = targetX = targetY = targetScroll = 0;
        for (const { element } of layers) element.style.removeProperty('transform');
      } else { resetPointer(); updateScroll(); }
    }
    function visibilityChange() {
      if (document.hidden) { if (frame) cancelAnimationFrame(frame); frame = 0; }
      else updateScroll();
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) updateScroll();
      else { if (frame) cancelAnimationFrame(frame); frame = 0; }
    });
    observer.observe(hero);
    hero.dataset.sceneReady = 'true';
    hero.addEventListener('pointermove', move, { passive: true });
    hero.addEventListener('pointerleave', resetPointer);
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', updateScroll, { passive: true });
    document.addEventListener('visibilitychange', visibilityChange);
    reduced.addEventListener('change', syncPreference);
    finePointer.addEventListener('change', resetPointer);
    updateScroll();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      delete hero.dataset.sceneReady;
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerleave', resetPointer);
      window.removeEventListener('scroll', updateScroll);
      window.removeEventListener('resize', updateScroll);
      document.removeEventListener('visibilitychange', visibilityChange);
      reduced.removeEventListener('change', syncPreference);
      finePointer.removeEventListener('change', resetPointer);
    };
  }, []);

  return (
    <svg className="blog-directory-scene" ref={ref} viewBox="0 0 720 380" aria-hidden="true" focusable="false">
      <g className="blog-directory-scene__layer" data-depth="0.2">
        <path d="M40 325c129-53 198-18 309-54 130-43 215-40 381 12v123H40Z" fill="var(--directory-art-ground)" />
        <path d="M390 215c-112-52-72-145 6-119s114 13 165-53" fill="none" stroke="var(--directory-art-line)" strokeWidth="1.5" strokeDasharray="4 8" opacity="0.55" />
        <path d="m629 146 5-9 5 9-5 9Zm-466 52 4-7 4 7-4 7Z" fill="var(--directory-art-accent)" opacity="0.7" />
      </g>
      <g className="blog-directory-scene__layer" data-depth="0.55">
        <path d="m340 83 74-27 32 12 35 109-100 32Z" fill="var(--directory-art-paper)" />
        <path d="m414 56 32 12-21 21Z" fill="var(--directory-art-paper-shade)" />
        <path d="m359 102 48-16m-43 31 66-22m-61 37 63-21m-58 36 39-13" fill="none" stroke="var(--directory-art-line)" strokeWidth="3" strokeLinecap="round" />
        <path d="m564 53 88-28-47 70-10-28Z" fill="var(--directory-art-cover)" />
        <path d="m564 53 88-28-57 42Z" fill="var(--directory-art-paper-light)" />
        <path d="m595 67 57-42-43 49-4 21Z" fill="var(--directory-art-cover-shade)" />
        <path d="m595 67-9 12 4-17Z" fill="var(--directory-art-accent)" />
      </g>
      <g className="blog-directory-scene__layer" data-depth="0.85">
        <ellipse cx="458" cy="321" rx="199" ry="17" fill="var(--directory-art-ground)" />
        <path d="m266 251 178 46 191-76 17 40-200 73-188-48Z" fill="var(--directory-art-cover)" />
        <path d="m444 297 8 37 200-73-17-40Z" fill="var(--directory-art-cover-shade)" />
        <path d="M273 242c61-15 123 10 170 35 62-48 125-60 185-69l9 39c-68 7-131 27-192 68-53-31-115-48-180-42Z" fill="var(--directory-art-paper-shade)" />
        <path d="M276 229c61-14 122 9 167 36 62-49 123-64 185-70l7 41c-65 6-128 23-191 65-54-31-116-51-177-40Z" fill="var(--directory-art-paper)" />
        <path d="M443 265c62-49 123-64 185-70l7 41c-65 6-128 23-191 65Z" fill="var(--directory-art-paper-light)" />
        <path d="m447 290 10 39 21-8-15-39Z" fill="var(--directory-art-accent)" />
        <path d="M282 269c51-5 104 8 154 33m22-1c58-34 113-49 171-54m-177 62c61-36 123-50 184-55" fill="none" stroke="var(--directory-art-line)" strokeWidth="1.2" opacity="0.6" />
        <path d="M296 242c40-2 78 9 112 26m-110-15c39 0 75 11 109 28m75-32c36-20 77-34 119-40m-117 54c37-20 77-32 119-39" fill="none" stroke="var(--directory-art-line)" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      <g className="blog-directory-scene__layer" data-depth="1.25">
        <path d="m210 312 74-19 6 8-76 20-13-1Z" fill="var(--directory-art-cover)" />
        <path d="m210 312 4 9-13-1Z" fill="var(--directory-art-accent)" />
        <path d="m277 295 7-2 6 8-7 2Z" fill="var(--directory-art-paper-light)" />
      </g>
    </svg>
  );
}
