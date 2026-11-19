'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOTION_MS } from '@/lib/motion';
import { lockPageScroll } from '@/lib/scroll-lock';

// 正文配图的查看层：图片从它在正文里的位置升到视口中央，下压一层深色遮罩。
// 不是弹窗 —— 没有卡片外壳与关闭钮，点图 / 点遮罩 / Esc 都收起。
//
// 【运动以页面为参考系】层内分成两节：`.image-zoom__track` 把坐标原点固定在文档上
// （行内给 -scrollX / -scrollY，滚动时立即改写，不参与过渡），图片的 left/top 与
// transform 全部是文档坐标。于是收起途中滚动，整张图跟着页面一起走；而「回到正文
// 那一格」的位移与缩放只发生在文档坐标系里 —— 屏幕上不会出现追着页面反向飘的运动。
//
// 【终点固定】收起的目标就是打开时量下的那一格（文档坐标），滚动不改它。
//
// 【可打断】缩小的过程中再点图就是重新放大：清掉收尾计时、锁回滚动、目标改回
// 视口中央（按当下的滚动换算成文档坐标），同一条过渡反向走完。

export type ImageZoomSource = {
  /** 正文里的那张图：既是图片来源，也是收起时的目标 */
  image: HTMLImageElement;
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
};

type Box = { left: number; top: number; width: number; height: number };
type Phase = 'enter' | 'open' | 'closing';

/** 视口坐标 → 文档坐标。层内的一切几何都用这一套。 */
const toDoc = (rect: DOMRect): Box => ({
  left: rect.left + window.scrollX,
  top: rect.top + window.scrollY,
  width: rect.width,
  height: rect.height,
});

/**
 * 顶栏底边（视口坐标）。放大的图按顶栏以下那块区域居中 —— 顶栏始终在层上面，
 * 图要是按整个视口居中，就会有一截钻进导航底下。
 */
function navbarBottom(): number {
  const navbar = document.querySelector('.site-navbar');
  const bottom = navbar?.getBoundingClientRect().bottom ?? 0;
  return bottom > 0 && bottom < window.innerHeight / 2 ? bottom : 0;
}

export default function ImageZoom({ source, onDone }: { source: ImageZoomSource; onDone: () => void }) {
  const [base, setBase] = useState<Box | null>(null);
  const [phase, setPhase] = useState<Phase>('enter');
  const [transform, setTransform] = useState('none');
  const baseRef = useRef<Box | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const releaseScroll = useRef<(() => void) | null>(null);
  const finishTimer = useRef<number | null>(null);
  const enterFrame = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 顶栏以下那块区域的中央，换算成文档坐标：长边取这块区域的九成，且不超过原图像素。
  const centerDoc = useCallback((start: Box): Box => {
    const ratio = start.width && start.height ? start.width / start.height : 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = navbarBottom();
    const area = Math.max(1, vh - top);
    let width = Math.min(source.naturalWidth || vw * 0.92, vw * 0.92);
    let height = width / ratio;
    if (height > area * 0.88) {
      height = area * 0.88;
      width = height * ratio;
    }
    return {
      left: (vw - width) / 2 + window.scrollX,
      top: top + (area - height) / 2 + window.scrollY,
      width,
      height,
    };
  }, [source.naturalWidth]);

  const moveTo = useCallback((target: Box) => {
    const start = baseRef.current;
    if (!start || !start.width) return;
    const scale = target.width / start.width;
    setTransform(
      `translate(${(target.left - start.left).toFixed(2)}px, ${(target.top - start.top).toFixed(2)}px) scale(${scale.toFixed(4)})`,
    );
  }, []);

  const clearFinish = useCallback(() => {
    if (finishTimer.current !== null) {
      window.clearTimeout(finishTimer.current);
      finishTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    if (phase === 'closing') return;
    // 入场那一帧（rAF 里才走向中央）还没跑：取消它，否则它会把 phase 改回 open，
    // 而滚动已经放开 —— 画面会在关闭中跳回放大态。
    if (enterFrame.current !== null) {
      cancelAnimationFrame(enterFrame.current);
      enterFrame.current = null;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDoneRef.current();
      return;
    }
    // 先把页面还回去：遮罩与图片还在收动画，滚动与点击不再被它们挡住。
    releaseScroll.current?.();
    releaseScroll.current = null;
    setPhase('closing');
    // 终点是文档坐标，滚动不改它 —— 图随页面走，位移只发生在文档坐标系里。
    if (baseRef.current) moveTo(baseRef.current);
    clearFinish();
    finishTimer.current = window.setTimeout(() => onDoneRef.current(), MOTION_MS);
  }, [phase, moveTo, clearFinish]);

  const reopen = useCallback(() => {
    if (phase !== 'closing') return;
    const start = baseRef.current;
    if (!start) return;
    clearFinish();
    releaseScroll.current = lockPageScroll();
    setPhase('open');
    moveTo(centerDoc(start));
  }, [phase, clearFinish, centerDoc, moveTo]);

  // 起始：量下正文里的那一格（文档坐标）作为几何基准，下一帧再走向中央。
  useEffect(() => {
    const box = toDoc(source.image.getBoundingClientRect());
    baseRef.current = box;
    setBase(box);
    enterFrame.current = requestAnimationFrame(() => {
      enterFrame.current = null;
      moveTo(centerDoc(box));
      setPhase('open');
    });
    return () => {
      if (enterFrame.current !== null) {
        cancelAnimationFrame(enterFrame.current);
        enterFrame.current = null;
      }
    };
  }, [source.image, centerDoc, moveTo]);

  // 焦点进这一层：原图被临时隐藏（visibility: hidden 不可聚焦），不接住的话键盘用户
  // 会掉回 body，读屏也听不到「这里打开了一张图」。关闭时焦点由父级还给正文那张图。
  useEffect(() => {
    layerRef.current?.focus({ preventScroll: true });
  }, []);

  // 打开期间锁滚动；收起时由 close 立刻放开。宽度不会变（桌面端原生条已换成自绘条），
  // 所以这里只锁 overflow，不补内距（见 lib/scroll-lock）。
  useEffect(() => {
    releaseScroll.current = lockPageScroll();
    return () => {
      releaseScroll.current?.();
      releaseScroll.current = null;
    };
  }, []);

  // 轨道：把层内坐标固定在文档上。滚动时立即跟随 —— 这段位移不参与过渡，
  // 所以图片在屏幕上随页面移动，不会有追着反向飘的读数。
  useEffect(() => {
    const sync = () => {
      const track = trackRef.current;
      if (!track) return;
      track.style.transform = `translate(${-window.scrollX}px, ${-window.scrollY}px)`;
    };
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  // 打开期间：地址栏收放、转屏都会改变中央那一格。
  useEffect(() => {
    if (phase !== 'open') return;
    const onResize = () => {
      const start = baseRef.current;
      if (start) moveTo(centerDoc(start));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase, centerDoc, moveTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // 卸载时清掉收尾计时。单独一个 effect：挂在 close 上会让每次阶段变化都清一次，
  // 把刚设好的收尾计时一起清掉，层就永远留在页面上。
  useEffect(() => () => {
    if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
  }, []);

  const className = ['image-zoom', phase === 'open' ? 'is-open' : '', phase === 'closing' ? 'is-closing' : '']
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div
      className={className}
      ref={layerRef}
      role="dialog"
      aria-modal="true"
      aria-label={source.alt ? `查看图片：${source.alt}` : '查看图片'}
      tabIndex={-1}
      onClick={close}
    >
      <div className="image-zoom__scrim" aria-hidden="true" />
      <div
        className="image-zoom__track"
        ref={trackRef}
        style={{ transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` }}
      >
        <img
          className="image-zoom__img"
          src={source.src}
          alt={source.alt}
          style={{
            left: base?.left ?? 0,
            top: base?.top ?? 0,
            width: base?.width ?? 0,
            height: base?.height ?? 0,
            transform,
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (phase === 'closing') reopen();
            else close();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
