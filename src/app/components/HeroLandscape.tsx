'use client';

import { useEffect, useId, useRef } from 'react';
import { MOTION_MS } from '@/lib/motion';

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

// 镜头推进：每层放大率 = 1 + depth × LENS_ZOOM，近层大、远层小 —— 读起来是相机
// 朝山的方向推过去，而不是整幅画被均匀拉近。
const LENS_ZOOM = 1.8;
// 横移、纵移都乘上各自的放大率：主峰到画幅中心的距离正好是 430，所以不论哪层、
// 不论放多大，峰顶都钉在屏幕中央；近层因为放大率高，位移也更大，纵深由此出来。
const LENS_SHIFT_X = -430;
const LENS_SHIFT_Y = 20.5;
const LENS_MS = MOTION_MS;

// 与 $motion-easing 同一条 cubic-bezier(0.16, 1, 0.3, 1)。CSS 那边拿不到曲线求值，
// 这里用牛顿法由 x 解 t 再取 y。
const easeMotion = (() => {
  const x1 = 0.16;
  const y1 = 1;
  const x2 = 0.3;
  const y2 = 1;
  const curve = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (p: number) => {
    let t = p;
    for (let i = 0; i < 5; i += 1) {
      const dx = curve(x1, x2, t) - p;
      if (Math.abs(dx) < 1e-4) break;
      const slope = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t ** 2;
      if (Math.abs(slope) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - dx / slope));
    }
    return curve(y1, y2, t);
  };
})();

// 原创矢量山景：各层共享同一画幅，远山移动最少，近景移动和放大最多。
// SVG 本身参与 SSR；无 JS 或减少动态效果偏好下仍是一幅完整的插画。
export default function HeroLandscape() {
  const ref = useRef<SVGSVGElement>(null);
  const pineId = useId();
  const moonMaskId = useId();

  useEffect(() => {
    const scene = ref.current;
    const hero = scene?.closest<HTMLElement>('.hero-section');
    // sticky 那一层：视差行程的终点就是它不再固定在视口里的位置，所以行程要减它的高度。
    const layer = scene?.closest<HTMLElement>('.home-stage__viewport');
    if (!scene || !hero || !layer) return;

    const layers = Array.from(scene.querySelectorAll<SVGGElement>('[data-depth]'))
      .map((element) => ({
        element,
        depth: Number(element.dataset.depth),
        // 天空层（含日月）包在世界层之外，不参与镜头推进 —— 天体在远处，不会跟着变大。
        inWorld: Boolean(element.closest('.hero-scene__world')),
      }));
    // 触屏倾斜的位移上限刻意比鼠标视差大一档：窄屏把整幅画按 940/1800 缩到一半，
    // 用户单位换算成屏幕像素后又打对折，而手持可倾斜的角度也远小于鼠标的横扫范围 ——
    // 两样一叠，沿用鼠标那套幅度时层与层只差几个像素，分层就看不出来了。
    const TILT_GAIN = 2.5;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const orientationEvent = window.DeviceOrientationEvent as OrientationEventConstructor | undefined;
    const tiltSupported = window.isSecureContext && !!orientationEvent;
    let disposed = false;
    let tiltGranted = false;
    let tiltAttempted = false;
    let tiltClickListening = false;
    let tiltListening = false;
    let neutralTilt: { beta: number; gamma: number; angle: number } | null = null;
    let frame = 0;
    let visible = true;
    let targetX = 0;
    let targetY = 0;
    let targetScroll = 0;
    let x = 0;
    let y = 0;
    let scroll = 0;
    // 视差的滚动基准：展开瞬间把当前滚动位置记成零点，之后只算增量 ——
    // 点「开始探索」会一次性跳半屏，若按绝对位置算，层会被这一跳顶飞。
    let scrollBaseY = 0;
    let scrollSpanY = 1;
    // 镜头推进进度 0→1：由 .home-stage 的 is-expanded 触发，时间驱动，走 720ms 贝塞尔。
    let lens = 0;
    let lensTarget = 0;
    let lensFrom = 0;
    let lensStart = -Infinity;
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

    function paint() {
      for (const { element, depth, inWorld } of layers) {
        const push = inWorld ? lens : 0;
        // 视差（滚动/指针）与镜头推进共用同一个缩放，横向位移按放大率等比放大，
        // 峰顶因此在任何倍率下都落在画面中央。
        const scale = 1 + scroll * depth * 0.085 + depth * LENS_ZOOM * push;
        const shiftX = LENS_SHIFT_X * scale * push;
        const shiftY = LENS_SHIFT_Y * scale * push;
        element.style.transform =
          `translate(${x * depth * 12 + shiftX}px, ${y * depth * 8 - scroll * depth * 70 + shiftY}px) scale(${scale})`;
      }
    }

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
      if (lens !== lensTarget) {
        const t = Math.min(1, (performance.now() - lensStart) / LENS_MS);
        lens = lensFrom + (lensTarget - lensFrom) * easeMotion(t);
        if (t >= 1) lens = lensTarget;
      }
      paint();
      // 只在输入变化或缓动尚未收敛时画下一帧，静止时不占用动画循环。
      if (settling || lens !== lensTarget) schedule();
    }

    function schedule() {
      if (!frame && visible && !document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(animate);
    }

    function updateScroll() {
      const rect = hero!.getBoundingClientRect();
      // 行程 = 这一段的总高 − sticky 层高：层高一旦追平，这一层就不再固定在视口里，
      // 视差正该在这条边界上走满。两个高度都是布局高度（段高含 svh、层高是 lvh），
      // 地址栏收放不改它们；若拿 window.innerHeight 当减数，地址栏一收行程就变，
      // 山景会在滚动中途被重新映射一次位置。
      scrollSpanY = Math.max(1, rect.height - layer!.getBoundingClientRect().height);
      targetScroll = Math.max(0, Math.min(1, (window.scrollY - scrollBaseY) / scrollSpanY));
      schedule();
    }

    // 窄屏日月用「屏幕百分比」定位：目标点取视口 (70%, 13%)，再用 SVG 的坐标变换
    // 反算回用户单位，尺寸按屏宽比例给 —— 不再写死 translate 的数字，换机型也落在
    // 同一处。换算用 scene 的 CTM（不含天空层自身的位移），所以是纯粹的
    // 「屏幕坐标 → 画幅坐标」反解。
    const sky = scene.querySelector<SVGGElement>('.hero-scene__layer[data-depth="0.12"]');
    function layoutSky() {
      if (!scene || !sky) return;
      if (!window.matchMedia('(max-width: 1024px)').matches) {
        sky.style.removeProperty('translate');
        sky.querySelectorAll('circle').forEach((c) => c.style.removeProperty('scale'));
        return;
      }
      const ctm = scene.getScreenCTM();
      if (!ctm) return;
      const target = scene.createSVGPoint();
      // 目标点按画幅盒的比例给：右侧 78%、纵向 27% —— 位于标题右侧那片空白的正中，
      // 不再挤在顶栏下面。基准取画幅盒而不是 window.innerWidth/innerHeight：
      // 盒高按 svh 定（地址栏收放不动它），日月才不会在滚动中跟着可见高度挪位置。
      const box = scene.getBoundingClientRect();
      target.x = box.right * 0.78;
      target.y = box.bottom * 0.27;
      const local = target.matrixTransform(ctm.inverse());
      // 日月的圆心在画幅坐标 (1375, 185)：位移就是「目标点 − 圆心」。
      sky.style.translate = `${(local.x - 1375).toFixed(1)}px ${(local.y - 185).toFixed(1)}px`;
      // 一个用户单位等于多少屏幕像素（CTM 的线性部分），直径目标按屏宽给。
      const unit = Math.hypot(ctm.a, ctm.b) || 1;
      const diameter = Math.min(128, box.width * 0.33);
      const scale = (diameter / (252 * unit)).toFixed(3);
      sky.querySelectorAll('circle').forEach((c) => {
        c.style.scale = scale;
      });
    }

    function onResize() {
      updateScroll();
      layoutSky();
    }

    // 展开态只由 HomeStage 的 .home-stage.is-expanded 表示 —— 这里观察到类变化就推进/退回，
    // 不重复实现滚动阈值（点「开始探索」时页面并不滚动，光靠 scroll 判断会漏掉）。
    const stage = hero.parentElement;
    function syncLens() {
      const next = stage?.classList.contains('is-expanded') ? 1 : 0;
      if (next === lensTarget) return;
      lensFrom = lens;
      lensTarget = next;
      lensStart = performance.now();
      if (next === 1) {
        // 把当前滚动与当前视差对齐成新的零点：点击时那次半屏跳转不会让层先飞一下。
        scrollBaseY = window.scrollY - scroll * scrollSpanY;
      } else {
        scrollBaseY = 0;
      }
      if (reducedMotion.matches) {
        lens = next;
        paint();
        return;
      }
      schedule();
    }
    const stageObserver = new MutationObserver(syncLens);
    if (stage) stageObserver.observe(stage, { attributes: true, attributeFilter: ['class'] });

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

    function onPointerLeave(event: PointerEvent) {
      if (event.pointerType === 'mouse') resetPointer();
    }

    function resetTilt() {
      neutralTilt = null;
      resetPointer();
    }

    function onDeviceOrientation(event: DeviceOrientationEvent) {
      if (!tiltListening || reducedMotion.matches || document.hidden || !visible) return;
      const { beta, gamma } = event;
      if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;
      const angle = window.screen.orientation?.angle
        ?? (window as Window & { orientation?: number }).orientation ?? 0;
      // 以当前握持姿势为中心；旋转屏幕后重新校准，避免角度跳变。
      if (!neutralTilt || neutralTilt.angle !== angle) {
        neutralTilt = { beta, gamma, angle };
        resetPointer();
        return;
      }
      const deltaBeta = (beta - neutralTilt.beta + 540) % 360 - 180;
      const deltaGamma = gamma - neutralTilt.gamma;
      const rotation = angle * Math.PI / 180;
      // 传感器轴固定在设备上，转到屏幕坐标后横竖屏都能左右、上下倾斜。
      // 先按 ±25° 归一化并限幅，再乘倾斜专属的位移增益。
      targetX = TILT_GAIN * Math.max(-1, Math.min(1, (deltaGamma * Math.cos(rotation) + deltaBeta * Math.sin(rotation)) / 25));
      targetY = TILT_GAIN * Math.max(-1, Math.min(1, (deltaBeta * Math.cos(rotation) - deltaGamma * Math.sin(rotation)) / 25));
      schedule();
    }

    function syncTiltInput() {
      const available = tiltSupported && coarsePointer.matches && !reducedMotion.matches;
      const waitForClick = available && !tiltAttempted && !document.hidden;
      if (waitForClick !== tiltClickListening) {
        tiltClickListening = waitForClick;
        // 捕获页面任意位置的真实点击，同时让原本的导航、按钮操作继续执行。
        if (waitForClick) document.addEventListener('click', onFirstClick, { capture: true, passive: true });
        else document.removeEventListener('click', onFirstClick, true);
      }
      const listen = available && tiltGranted && visible && !document.hidden;
      if (listen !== tiltListening) {
        tiltListening = listen;
        resetTilt();
        if (listen) window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
        else window.removeEventListener('deviceorientation', onDeviceOrientation);
      }
    }

    async function onFirstClick(event: MouseEvent) {
      if (!event.isTrusted || disposed || tiltAttempted || !tiltSupported || !coarsePointer.matches || reducedMotion.matches) return;
      tiltAttempted = true;
      syncTiltInput();
      try {
        // iOS 必须直接在点击回调内请求，不能移到 effect 或定时器中。
        const permission = orientationEvent?.requestPermission
          ? await orientationEvent.requestPermission() : 'granted';
        if (disposed) return;
        tiltGranted = permission === 'granted';
        syncTiltInput();
      } catch {
        // 装饰性效果的授权拒绝或异常静默降级，后续点击不再重复申请。
      }
    }

    function onInputChange() {
      resetTilt();
      syncTiltInput();
    }

    function syncMotionPreference() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (reducedMotion.matches) {
        x = y = scroll = targetX = targetY = targetScroll = 0;
        // 位置与缩放直接落到当前状态：镜头该推到位就推到位，只是不再有过渡。
        lens = lensTarget;
        paint();
      } else {
        resetPointer();
        updateScroll();
      }
      syncTiltInput();
    }

    function onVisibilityChange() {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      } else updateScroll();
      syncTiltInput();
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) updateScroll();
      else {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      }
      syncTiltInput();
    });
    observer.observe(hero);
    hero.dataset.sceneReady = 'true';
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotion.addEventListener('change', syncMotionPreference);
    finePointer.addEventListener('change', onInputChange);
    coarsePointer.addEventListener('change', onInputChange);
    window.addEventListener('orientationchange', resetTilt);
    window.screen.orientation?.addEventListener('change', resetTilt);
    syncTiltInput();
    updateScroll();
    layoutSky();

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      stageObserver.disconnect();
      hero.style.removeProperty('--hero-orbit-angle');
      delete hero.dataset.sceneReady;
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', updateScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotion.removeEventListener('change', syncMotionPreference);
      finePointer.removeEventListener('change', onInputChange);
      coarsePointer.removeEventListener('change', onInputChange);
      window.removeEventListener('deviceorientation', onDeviceOrientation);
      document.removeEventListener('click', onFirstClick, true);
      window.removeEventListener('orientationchange', resetTilt);
      window.screen.orientation?.removeEventListener('change', resetTilt);
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

      {/* 镜头推进只作用在这层：山、湖、地面整体靠近并居中，天空层（含日月）留在原位 ——
          天体在远处，镜头推进时不会跟着变大。 */}
      <g className="hero-scene__world">
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
      </g>
    </svg>
  );
}
