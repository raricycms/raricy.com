'use client';

import { useEffect, useId, useRef } from 'react';

// 原创矢量山景：各层共享同一画幅，远山移动最少，近景移动和放大最多。
// SVG 本身参与 SSR；无 JS、触屏与减少动态效果偏好下仍是一幅完整的插画。
export default function HeroLandscape() {
  const ref = useRef<SVGSVGElement>(null);
  const pineId = useId();
  const moonMaskId = useId();

  useEffect(() => {
    const scene = ref.current;
    const hero = scene?.closest<HTMLElement>('.hero-section');
    if (!scene || !hero) return;

    const layers = Array.from(scene.querySelectorAll<SVGGElement>('[data-depth]'))
      .map((element) => ({ element, depth: Number(element.dataset.depth) }));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    let frame = 0;
    let visible = true;
    let targetX = 0;
    let targetY = 0;
    let targetScroll = 0;
    let x = 0;
    let y = 0;
    let scroll = 0;
    let currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    let orbitAngle = currentTheme === 'dark' ? -180 : 0;
    hero.style.setProperty('--hero-orbit-angle', `${orbitAngle}deg`);
    // 每次切换都逆时针续转半圈，避免切回浅色时沿原轨迹倒放。
    const themeObserver = new MutationObserver(() => {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      if (nextTheme === currentTheme) return;
      currentTheme = nextTheme;
      orbitAngle -= 180;
      hero.style.setProperty('--hero-orbit-angle', `${orbitAngle}deg`);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    function animate() {
      frame = 0;
      x += (targetX - x) * 0.085;
      y += (targetY - y) * 0.085;
      scroll += (targetScroll - scroll) * 0.085;
      const settling = Math.abs(targetX - x) + Math.abs(targetY - y) + Math.abs(targetScroll - scroll) > 0.001;
      if (!settling) {
        x = targetX;
        y = targetY;
        scroll = targetScroll;
      }
      for (const { element, depth } of layers) {
        const scale = 1 + scroll * depth * 0.085;
        // 页面向下滚动时景物上移，近景的位移和放大都比远景明显。
        element.style.transform = `translate(${x * depth * 22}px, ${y * depth * 14 - scroll * depth * 260}px) scale(${scale})`;
      }
      // 只在输入变化或缓动尚未收敛时画下一帧，静止时不占用动画循环。
      if (settling) schedule();
    }

    function schedule() {
      if (!frame && visible && !document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(animate);
    }

    function updateScroll() {
      const rect = hero!.getBoundingClientRect();
      targetScroll = Math.max(0, Math.min(1, -rect.top / rect.height));
      schedule();
    }

    function onPointerMove(event: PointerEvent) {
      if (!finePointer.matches || event.pointerType !== 'mouse' || reducedMotion.matches) return;
      const rect = hero!.getBoundingClientRect();
      targetX = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
      targetY = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
      schedule();
    }

    function resetPointer() {
      targetX = 0;
      targetY = 0;
      schedule();
    }

    function syncMotionPreference() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (reducedMotion.matches) {
        x = y = scroll = targetX = targetY = 0;
        for (const { element } of layers) element.style.removeProperty('transform');
      } else {
        resetPointer();
        updateScroll();
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      } else updateScroll();
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) updateScroll();
      else {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    observer.observe(hero);
    hero.dataset.sceneReady = 'true';
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', resetPointer);
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', updateScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotion.addEventListener('change', syncMotionPreference);
    finePointer.addEventListener('change', resetPointer);
    updateScroll();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      hero.style.removeProperty('--hero-orbit-angle');
      delete hero.dataset.sceneReady;
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', resetPointer);
      window.removeEventListener('scroll', updateScroll);
      window.removeEventListener('resize', updateScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotion.removeEventListener('change', syncMotionPreference);
      finePointer.removeEventListener('change', resetPointer);
    };
  }, []);

  return (
    <svg className="hero-scene" ref={ref} viewBox="0 0 1800 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <path id={pineId} d="M0 0 12 23 7 23 20 42 12 42 28 65 17 65 34 91 5 91 5 105 -5 105 -5 91 -34 91 -17 65 -28 65 -12 42 -20 42 -7 23 -12 23Z" />
        <mask id={moonMaskId} maskUnits="userSpaceOnUse" x="1245" y="55" width="260" height="260">
          <circle cx="1375" cy="185" r="103" fill="white" />
          <circle cx="1418" cy="144" r="99" fill="black" />
        </mask>
      </defs>

      <g className="hero-scene__layer" data-depth="0.12">
        <path d="M825-80H1260L870 665H570Z" fill="var(--hero-ray)" opacity="0.45" />
        <g className="hero-scene__sun">
          <circle cx="1375" cy="185" r="103" fill="var(--hero-sun)" />
          <circle cx="1375" cy="185" r="126" fill="none" stroke="var(--hero-sun)" strokeWidth="1" opacity="0.3" />
        </g>
        <g className="hero-scene__moon">
          <circle cx="1375" cy="185" r="103" fill="var(--hero-moon)" mask={`url(#${moonMaskId})`} />
          <circle cx="1375" cy="185" r="126" fill="none" stroke="var(--hero-moon)" strokeWidth="1" opacity="0.2" />
        </g>
        <path d="M994 216h83m-41-41v83M1580 133h45m-22-22v45" fill="none" stroke="var(--hero-line)" strokeWidth="1" opacity="0.3" />
        <path d="m1655 220 13-7 13 7m-58 15 9-5 9 5" fill="none" stroke="var(--hero-ink)" strokeWidth="2" opacity="0.4" />
      </g>

      <g className="hero-scene__layer" data-depth="0.24">
        <path d="M-120 695 70 575 160 605 275 544 380 590 455 535 565 610 695 543 770 568 920 402 980 470 1090 362 1160 449 1260 410 1370 480 1510 360 1590 420 1730 315 1940 536V1020H-120Z" fill="var(--hero-far)" />
        <path d="m70 575 90 30 115-61-44 78-84-2Zm385-40 110 75-117-33Zm465-133 60 68-41-12-36 28-41-2Zm170-40 70 87-70-39-73 51Zm640-47 107 113-106-51-86 69Z" fill="var(--hero-snow)" opacity="0.75" />
        <path d="M-80 763 155 659 353 714 600 636 742 668 970 545 1220 598 1450 489 1655 552 1900 454V1020H-80Z" fill="var(--hero-far-shade)" />
      </g>

      <g className="hero-scene__layer" data-depth="0.46">
        <path d="M495 753 695 655 835 583 970 408 1030 461 1143 350 1200 409 1330 221 1415 337 1468 316 1550 447 1610 403 1800 577 1920 654V1020H495Z" fill="var(--hero-mountain)" />
        <path d="m1330 221-49 105-35 31-49 72 35-19 30 21 35-62 16 38 36-12 49 45 17-31 49 22-49-84-31-8Z" fill="var(--hero-snow)" />
        <path d="m1330 221 18 114 31 8 49 84-52-29-26-53-25 13-12-27Z" fill="var(--hero-snow-shade)" />
        <path d="m1330 221-102 287-85 114 78-31 34-77 77-130-19-53Z" fill="var(--hero-mountain-light)" />
        <path d="m1330 221 83 156-18 31 78 61 77-22-82-131-53 21Z" fill="var(--hero-mountain-shade)" opacity="0.55" />
        <path d="m1143 350-90 133 55-34 22 18 25-51 45 35 32-41-32-1Z" fill="var(--hero-snow)" />
        <path d="m1143 350 12 66 45 35-40 67 68-10-28-99Z" fill="var(--hero-snow-shade)" />
        <path d="m970 408-78 107 49-19 28 12 22-28 39 19-3-33Z" fill="var(--hero-snow)" />
        <path d="m970 408-35 180-100 76 161-48 34-155Z" fill="var(--hero-mountain-light)" />
        <path d="m1468 316 25 87 57 44-71-17-29-48-32 27-23-32Z" fill="var(--hero-snow)" />
        <path d="m1610 403-82 101 56-26 23 17 28-29 48 30Z" fill="var(--hero-snow)" />
        <path d="m1143 518 112-4-81 113-200 83Zm189-134 80 114-158 120 27-94Zm218 63 66 128-214 65 71-171Z" fill="var(--hero-mountain-shade)" />
        <path d="m970 588 173-70-115 105-107 62Zm442-90 61-29-71 171-136 43Zm204 77 117-59 100 123-218 73Z" fill="var(--hero-mountain-light)" />
        <path d="M600 755 947 655 1137 676 1322 619 1500 674 1776 614 1900 710V1020H600Z" fill="var(--hero-valley)" />
        <path d="m947 655 190 21-283 124-254-45Zm375-36 178 55-196 82-217 10Z" fill="var(--hero-valley-light)" />
      </g>

      <g className="hero-scene__layer" data-depth="0.65">
        <path d="M-120 812 406 750 896 737 1240 727 1390 756 1224 799 978 827 1294 907 1400 1020H-120Z" fill="var(--hero-lake)" />
        <path d="m406 750 490-13 344-10-410 38Z" fill="var(--hero-snow)" opacity="0.5" />
        <path d="m680 814 544-15-246 28 316 80-455-37Z" fill="var(--hero-lake-shade)" />
        <path d="M478 786h204m65-12h273M875 804h115m-700 66h265m158-23h146" fill="none" stroke="var(--hero-snow)" strokeWidth="2" opacity="0.5" />
        <path d="m1260 749 92-10 73 17-117 20-84 23-176 10Z" fill="var(--hero-hill)" />
      </g>

      <g className="hero-scene__layer" data-depth="0.85">
        <path d="M-120 752 98 734 304 818 515 841 662 925 390 1020H-120Z" fill="var(--hero-hill)" />
        <path d="m-120 752 218-18 206 84-294-15Z" fill="var(--hero-hill-light)" />
        <path d="M828 1020 1060 894 1241 845 1380 741 1494 763 1630 671 1760 614 1920 642V1020Z" fill="var(--hero-hill)" />
        <path d="m1380 741 114 22 136-92 130-57-138 156-280 99-282 25Z" fill="var(--hero-hill-light)" />
        {[[-10, 741, 0.45], [58, 740, 0.6], [119, 754, 0.48], [194, 781, 0.55], [267, 806, 0.42], [1360, 761, 0.58], [1415, 753, 0.72], [1480, 746, 0.48], [1550, 704, 0.75], [1622, 677, 0.65], [1700, 636, 0.8], [1780, 609, 1]].map(([tx, ty, scale], i) => (
          <use key={i} href={`#${pineId}`} transform={`translate(${tx} ${ty}) scale(${scale})`} fill="var(--hero-forest-far)" />
        ))}
      </g>

      <g className="hero-scene__layer" data-depth="1.3">
        {/* 地面延伸到画幅外，强滚动视差上移时仍能覆盖底边。 */}
        <path d="M-120 884 105 848 331 913 533 932 786 1005 1033 946 1320 929 1497 837 1643 784 1780 736 1940 760V1400H-120Z" fill="var(--hero-forest)" />
        <path d="m1320 929 177-92 146-53 137-48-161 167-299 116H993Z" fill="var(--hero-forest-light)" />
        {[[-10, 798, 1.25], [77, 815, 0.84], [166, 849, 1], [267, 879, 0.65], [365, 913, 0.48], [1280, 866, 0.7], [1378, 798, 1.15], [1465, 819, 0.65], [1556, 711, 1.5], [1658, 738, 0.96], [1774, 581, 2.05], [1870, 610, 1.4]].map(([tx, ty, scale], i) => (
          <use key={i} href={`#${pineId}`} transform={`translate(${tx} ${ty}) scale(${scale})`} fill="var(--hero-forest)" />
        ))}
        <path d="m1556 711 0 136 34 0-13-39-12 0 14-23-12 0 9-19-10 0Zm218-130v185h42l-19-53h-14l22-36h-20l17-29h-14Z" fill="var(--hero-forest-light)" opacity="0.45" />
      </g>
    </svg>
  );
}
