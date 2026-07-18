// ─────────────────────────────────────────────────────────────────────────────
// ATÅMAS — 画布渲染（忠实移植 core.js 的 drawCanvas）
//
// 绘制：圆环、点击区指示环、连线、圆盘元素（数字 / 普通加号 / 黑金加号）、
// 合并高亮闪光、悬停间隙指示、中心待放置元素（脉冲）、游戏结束遮罩。
// 颜色与字体逐字对齐原实现，画布尺寸取 canvas.width（原站固定 500）。
// ─────────────────────────────────────────────────────────────────────────────

import { BASECOLORS, FRONTCOLORS } from './constants';
import type { GameState } from './engine';

interface DrawOptions {
  gameOverAnimProgress: number;
  getTranslation: (key: string) => string;
}

const TAU = 2 * Math.PI;

export function drawAtamas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: GameState,
  opts: DrawOptions
): void {
  const { getTranslation, gameOverAnimProgress } = opts;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const radius = w * 0.35;
  const dotRadius = w * 0.045;

  // 圆环
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.strokeStyle = '#3c6080';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 可点击区指示环
  const innerRadius = radius * 0.65;
  const outerRadius = radius * 1.1;
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, TAU);
  ctx.strokeStyle = 'rgba(60, 96, 128, 0.15)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius, 0, TAU);
  ctx.strokeStyle = 'rgba(60, 96, 128, 0.15)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 连线
  if (state.elements.length > 1) {
    ctx.beginPath();
    state.elements.forEach((el, idx) => {
      const x = cx + radius * Math.cos(el.angle);
      const y = cy + radius * Math.sin(el.angle);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const first = state.elements[0];
    const fx = cx + radius * Math.cos(first.angle);
    const fy = cy + radius * Math.sin(first.angle);
    ctx.lineTo(fx, fy);
    ctx.strokeStyle = 'rgba(60, 96, 128, 0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 圆环上的元素
  state.elements.forEach((el) => {
    const progress = el.isAnimating ? el.animProgress ?? 0 : 1;
    const scale = el.isAnimating ? 0.6 + 0.4 * progress : 1;
    const drawRadius = el.isNew ? radius * progress : radius;
    const x = cx + drawRadius * Math.cos(el.angle);
    const y = cy + drawRadius * Math.sin(el.angle);

    if (el.type === 'number') {
      const colorIndex = ((el.value ?? 1) - 1) % BASECOLORS.length;
      const baseColor = BASECOLORS[colorIndex];
      const frontColor = FRONTCOLORS[colorIndex];

      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 1.2 * scale, 0, TAU);
      ctx.fillStyle = baseColor;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = frontColor;
      ctx.font = `600 ${w * 0.06 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(el.value), x, y);
    } else if (el.isBlackGolden) {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 1.2 * scale, 0, TAU);
      ctx.fillStyle = '#1a1a1a';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffd700';
      ctx.font = `600 ${w * 0.07 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', x, y);
    } else {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 1.2 * scale, 0, TAU);
      ctx.fillStyle = '#ffd700';
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#1e2f44';
      ctx.font = `600 ${w * 0.07 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', x, y);
    }
  });

  // 合并闪光
  state.mergeFlash.forEach((idx) => {
    const el = state.elements[idx];
    if (!el) return;
    const fx = cx + radius * Math.cos(el.angle);
    const fy = cy + radius * Math.sin(el.angle);
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 25;
    ctx.beginPath();
    ctx.arc(fx, fy, dotRadius * 1.8, 0, TAU);
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  // 悬停间隙指示
  if (
    state.hoverGapIndex >= 0 &&
    state.pendingElement &&
    !state.animating &&
    !state.gameOver
  ) {
    const len = state.elements.length;
    const hoverIndex = state.hoverGapIndex >= len ? len : state.hoverGapIndex;

    let hoverAngle: number;
    if (len === 0) {
      hoverAngle = 0;
    } else {
      const prevIndex = (hoverIndex - 1 + len) % len;
      const nextIndex = hoverIndex % len;
      let prevAngle = state.elements[prevIndex].angle % TAU;
      if (prevAngle < 0) prevAngle += TAU;
      let nextAngle = state.elements[nextIndex].angle % TAU;
      if (nextAngle < 0) nextAngle += TAU;

      if (nextAngle > prevAngle) {
        hoverAngle = (prevAngle + nextAngle) / 2;
      } else {
        hoverAngle = (prevAngle + nextAngle + TAU) / 2;
        if (hoverAngle >= TAU) hoverAngle -= TAU;
      }
    }

    const hoverX = cx + radius * Math.cos(hoverAngle);
    const hoverY = cy + radius * Math.sin(hoverAngle);

    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(hoverX, hoverY, dotRadius * 1.8, 0, TAU);
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.moveTo(hoverX, hoverY);
    const arrowX = cx + radius * 0.8 * Math.cos(hoverAngle);
    const arrowY = cy + radius * 0.8 * Math.sin(hoverAngle);
    ctx.lineTo(arrowX, arrowY);
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 中心待放置元素（脉冲）
  drawCenter(ctx, canvas, state, getTranslation);

  // 游戏结束遮罩
  if (state.gameOver) {
    const progress = Math.min(gameOverAnimProgress, 1);
    const easeProgress = 1 - Math.pow(1 - progress, 3);

    ctx.fillStyle = `rgba(0,0,0,${0.6 * easeProgress})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10 * easeProgress, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#ffb3b3';
    ctx.font = `700 ${w * 0.1}px 'Bahnschrift Condensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = easeProgress;
    ctx.fillText('GAME OVER', cx, cy);
    ctx.globalAlpha = 1;
  }
}

function drawCenter(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: GameState,
  getTranslation: (key: string) => string
): void {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  if (state.pendingElement) {
    const pulse = Math.sin(Date.now() / 400) * 0.2 + 0.8;
    const scale = pulse;

    if (state.pendingElement.type === 'number') {
      const value = state.pendingElement.value ?? 1;
      const colorIndex = (value - 1) % BASECOLORS.length;
      const baseColor = BASECOLORS[colorIndex];
      const frontColor = FRONTCOLORS[colorIndex];

      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 40 * pulse;
      const size = w * 0.1 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, TAU);
      ctx.fillStyle = baseColor;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = frontColor;
      ctx.font = `600 ${w * 0.1 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(value), cx, cy);

      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
      ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);
    } else {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 40 * pulse;
      const size = w * 0.1 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, TAU);

      if (state.pendingElement.isBlackGolden) {
        ctx.fillStyle = '#1a1a1a';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffd700';
        ctx.font = `600 ${w * 0.1 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', cx, cy);

        ctx.fillStyle = 'rgba(255,215,0,0.3)';
        ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
        ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);
      } else {
        ctx.fillStyle = '#ffd700';
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#1e2f44';
        ctx.font = `600 ${w * 0.1 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', cx, cy);

        ctx.fillStyle = 'rgba(255,215,0,0.3)';
        ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
        ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);
      }
    }
  } else if (state.elements.length > 0 && !state.animating) {
    ctx.fillStyle = 'rgba(86, 125, 159, 0.15)';
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.03, 0, TAU);
    ctx.fill();
  }
}
