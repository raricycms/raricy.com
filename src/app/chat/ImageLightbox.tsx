'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ImageLightbox.tsx — 聊天图片原位放大（覆盖层）+ 缩放
//
// 点消息里的图片不再新开窗口：在当前页盖一层黑底把图放大。交互对齐常见看图器：
//   • 缩放：控件 −/+ / 滚轮 / 双击 / 双指捏合；比例固定档位（1×/1.5×/2×/3×/4×）
//     —— 连续缩放没有意义，档位到位更好点，也让「百分比」有个准数。
//   • 平移：放大后按住拖动（鼠标 / 单指）；也可以直接滚动列表看超出的部分。
//   • 复位：点百分比按钮回 100%；缩放到 1× 时自动居中并关闭拖动。
//   • 关闭：点黑底 / Esc / 右上角 ×。拖动过的松手不触发关闭（见下面 onPointerUp）。
//
// 【为什么不用 pointer events 做捏合】触屏的 `touchstart` 给的是全部触点，
// pointer events 只有主指针 —— 双指捏合只能靠 touch 事件读两指距离。鼠标端则
// 分成滚轮与拖动两条独立路径（pointerdown/move/up）。两套事件各管各的场景，
// 互不冲突（触摸时浏览器不会同时发 wheel）。
//
// 观感对齐博客正文与云剪贴板的图片放大（MarkdownRenderer / ClipDetailClient 的
// 内联覆盖层）；那两处是给 innerHTML 挂 onclick，只能手搓 DOM 节点 —— 聊天消息
// 本来就是 React 渲染的，用状态开关更省事：Esc 监听与卸载清理都归组件管。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

/**
 * 缩放档位（倍率）。刻意离散：用户要的是「大一点 / 再大一点」，不是精确到小数；
 * 档位也让两个按钮的禁用边界（最小/最大）一目了然。
 */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
/** 双指捏合：两指距离变化多少像素 = 一档（免得捏到手酸才动一格）。 */
const PINCH_STEP_PX = 80;
/** 双击放大到的档位（1× ↔ 2×，与多数看图器一致）。 */
const DOUBLE_CLICK_ZOOM = 2;

type Offset = { x: number; y: number };

export default function ImageLightbox({
  src,
  alt = '图片',
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  /** 档位下标（用在 ZOOM_STEPS 上）。缩放比例由它算，避免浮点累积误差。 */
  const [step, setStep] = useState(0);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  /** 拖动中（抑制过渡动画，否则每帧都在追一个动画目标，拖起来发飘）。 */
  const [dragging, setDragging] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  /** 拖动起点（指针位置）与起点的平移量。 */
  const dragStartRef = useRef<{ px: number; py: number } & Offset>({ px: 0, py: 0, x: 0, y: 0 });
  /** 本次按下有没有真的拖动过 —— 决定松手时算不算「点了黑底」→ 关不关。 */
  const movedRef = useRef(false);
  /** 每个视图各自记住自己的缩放：切图（改 src）时复位。 */
  const lastSrcRef = useRef(src);

  const zoom = ZOOM_STEPS[step];
  const canZoomOut = step > 0;
  const canZoomIn = step < ZOOM_STEPS.length - 1;
  const zoomed = step > 0;

  const resetView = useCallback(() => {
    setStep(0);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 换了一张图 → 缩放与平移复位（否则新图会带着上一张的放大倍数出现）
  if (lastSrcRef.current !== src) {
    lastSrcRef.current = src;
    if (step !== 0 || offset.x !== 0 || offset.y !== 0) {
      setStep(0);
      setOffset({ x: 0, y: 0 });
    }
  }

  /** 增减一档。回到 1× 时归位，免得留着一个看不见的位移。 */
  const changeStep = useCallback((delta: number) => {
    setStep((prev) => {
      const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, prev + delta));
      if (next === 0) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // ── 键盘：Esc 关闭，+/-/0 缩放 ─────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === '+' || e.key === '=') changeStep(1);
      else if (e.key === '-' || e.key === '_') changeStep(-1);
      else if (e.key === '0') resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, changeStep, resetView]);

  // ── 滚轮缩放（挂在覆盖层上，且必须非 passive 才能 preventDefault）──────
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 别让页面跟着滚
      changeStep(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [changeStep]);

  // ── 双指捏合 ──────────────────────────────────────────────────────────
  const pinchRef = useRef<{ distance: number; step: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    pinchRef.current = {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      step,
    };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const pinch = pinchRef.current;
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const delta = Math.floor((distance - pinch.distance) / PINCH_STEP_PX);
    const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, pinch.step + delta));
    setStep(next);
    if (next === 0) setOffset({ x: 0, y: 0 });
  };
  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  // ── 拖动平移（仅在放大后）──────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed) return;
    draggingRef.current = true;
    movedRef.current = false;
    dragStartRef.current = { px: e.clientX, py: e.clientY, x: offset.x, y: offset.y };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.px;
    const dy = e.clientY - dragStartRef.current.py;
    // 3px 容差：手指/鼠标按下时总会有零点几像素的抖动，别把它当成拖动
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    setOffset({ x: dragStartRef.current.x + dx, y: dragStartRef.current.y + dy });
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
  };

  /** 点黑底关闭；拖动过就不关（用户是在看图，不是在关窗）。 */
  const onOverlayClick = () => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    onClose();
  };

  /** 双击图片：1× ↔ 2×（对齐多数看图器）。拖动的两次 click 不算双击。 */
  const onImageClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    if (step === 0) {
      setStep(ZOOM_STEPS.indexOf(DOUBLE_CLICK_ZOOM));
      setOffset({ x: 0, y: 0 });
    } else {
      resetView();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onOverlayClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 点图片本身不关闭（只有点黑底才关），否则想细看时会误关 */}
      <img
        className={`chat-lightbox__img${dragging ? ' is-dragging' : ''}${zoomed ? ' is-zoomed' : ''}`}
        src={src}
        alt={alt}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        }}
        draggable={false}
        onClick={onImageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />

      {/* 缩放控件：贴在底部居中。+- 到边界时禁用，百分比按钮 = 复位。
          整体 stopPropagation：在控件上点一下不该把图关了。 */}
      <div
        className="chat-lightbox__zoom"
        role="group"
        aria-label="缩放"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="chat-lightbox__zoom-btn"
          onClick={() => changeStep(-1)}
          disabled={!canZoomOut}
          aria-label="缩小"
          title="缩小（-）"
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-lightbox__zoom-level"
          onClick={resetView}
          disabled={!zoomed}
          title="恢复原始大小（0 / 双击）"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="chat-lightbox__zoom-btn"
          onClick={() => changeStep(1)}
          disabled={!canZoomIn}
          aria-label="放大"
          title="放大（+）"
        >
          <Plus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-lightbox__zoom-btn"
          onClick={resetView}
          disabled={!zoomed && offset.x === 0 && offset.y === 0}
          aria-label="适应窗口"
          title="适应窗口"
        >
          <Maximize aria-hidden="true" />
        </button>
      </div>

      <button type="button" className="chat-lightbox__close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
