'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GomokuCanvas.tsx — 五子棋棋盘画布（本地对局与联机对战共用）
//
// 【为什么单独抽出来】DPR 缩放、resize 防抖、主题切换、以及最要命的
// 「点击像素 → 棋盘格」换算，是这个组件里最容易写错、也最难肉眼发现的部分。
// 本地与联机各写一份，迟早会在其中一份里把 margin 多加一次 —— 表现是
// 「点这儿落在隔壁」，不报错、不崩溃，只有玩的人感觉得到。
//
// 【受控组件，不持有棋局】棋盘以 props 传入，本组件只负责画与报点。
// 本地模式传 boardRef.current.grid，联机模式传服务端下发的 grid。
//
// 【version 是干什么的】GomokuBoard.grid 是**原地改的可变对象**，引用不变，
// React 的依赖比对看不出变化。故由调用方用一个「每次变化都自增」的计数器驱动
// 重绘。别把 version 从依赖里删掉 —— 删了棋盘就不刷新，而且是静默的。
//
// 【给 e2e 的两个不变量】logicalSize = cellSize * 16（margin = cellSize，
// 格数 = BOARD_SIZE - 1 = 14，故 margin*2 + 14*cellSize）。点击换算要用它，
// 见 tests/e2e/gomoku-online.spec.ts。canvas 上另挂了 data-cell-size / data-margin
// 供测试直接读，免得每次都手推。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from 'react';
import { BLACK, BOARD_SIZE, EMPTY, WHITE, type Cell, type Move } from '@/lib/gomoku-rules';

type Palette = {
  boardBg: string;
  gridLine: string;
  starPoint: string;
  stoneBlackHi: string;
  stoneBlackLo: string;
  stoneWhiteHi: string;
  stoneWhiteLo: string;
  lastMarker: string;
  winGlow: string;
};

const LIGHT: Palette = {
  boardBg: '#DEB887',
  gridLine: '#333',
  starPoint: '#333',
  stoneBlackHi: '#666',
  stoneBlackLo: '#111',
  stoneWhiteHi: '#fff',
  stoneWhiteLo: '#bbb',
  lastMarker: '#e74c3c',
  winGlow: 'rgba(255, 215, 0, 0.55)',
};
const DARK: Palette = {
  boardBg: '#5D4037',
  gridLine: '#aaa',
  starPoint: '#aaa',
  stoneBlackHi: '#666',
  stoneBlackLo: '#111',
  stoneWhiteHi: '#fff',
  stoneWhiteLo: '#bbb',
  lastMarker: '#ff6b6b',
  winGlow: 'rgba(255, 215, 0, 0.45)',
};

const STAR_POINTS: ReadonlyArray<readonly [number, number]> = [
  [3, 3],
  [3, 7],
  [3, 11],
  [7, 3],
  [7, 7],
  [7, 11],
  [11, 3],
  [11, 7],
  [11, 11],
];

type Sizing = { cellSize: number; margin: number; logicalSize: number };

function computeSizing(containerWidth: number): Sizing {
  const maxLogical = Math.min(containerWidth, 640);
  let cellSize = Math.floor(maxLogical / (BOARD_SIZE + 1));
  if (cellSize < 16) cellSize = 16;
  const margin = cellSize;
  const logicalSize = margin * 2 + cellSize * (BOARD_SIZE - 1);
  return { cellSize, margin, logicalSize };
}

function drawBoard(
  canvas: HTMLCanvasElement,
  sizing: Sizing,
  palette: Palette,
  grid: Cell[][],
  lastMove: Move | null,
  winningLine: Array<[number, number]> | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { cellSize, margin, logicalSize } = sizing;
  const P = palette;

  // 背景
  ctx.fillStyle = P.boardBg;
  ctx.fillRect(0, 0, logicalSize, logicalSize);

  // 网格线
  ctx.strokeStyle = P.gridLine;
  ctx.lineWidth = 1;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const pos = margin + i * cellSize;
    ctx.beginPath();
    ctx.moveTo(margin, pos);
    ctx.lineTo(margin + (BOARD_SIZE - 1) * cellSize, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, margin);
    ctx.lineTo(pos, margin + (BOARD_SIZE - 1) * cellSize);
    ctx.stroke();
  }

  // 星位
  ctx.fillStyle = P.starPoint;
  for (const [sr, sc] of STAR_POINTS) {
    const sx = margin + sc * cellSize;
    const sy = margin + sr * cellSize;
    ctx.beginPath();
    ctx.arc(sx, sy, cellSize * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // 胜利连线集合
  let winSet: Set<number> | null = null;
  if (winningLine && winningLine.length > 0) {
    winSet = new Set<number>();
    for (const [wr, wc] of winningLine) {
      winSet.add(wr * BOARD_SIZE + wc);
    }
  }

  // 棋子
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = grid[r][c];
      if (cell === EMPTY) continue;

      const cx = margin + c * cellSize;
      const cy = margin + r * cellSize;
      const radius = cellSize * 0.44;

      if (winSet && winSet.has(r * BOARD_SIZE + c)) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = P.winGlow;
        ctx.fill();
      }

      const grad = ctx.createRadialGradient(
        cx - radius * 0.3,
        cy - radius * 0.3,
        radius * 0.1,
        cx,
        cy,
        radius
      );
      if (cell === BLACK) {
        grad.addColorStop(0, P.stoneBlackHi);
        grad.addColorStop(1, P.stoneBlackLo);
      } else {
        grad.addColorStop(0, P.stoneWhiteHi);
        grad.addColorStop(1, P.stoneWhiteLo);
      }

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      if (cell === WHITE) {
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }

  // 最后一手标记
  if (lastMove) {
    const mx = margin + lastMove.col * cellSize;
    const my = margin + lastMove.row * cellSize;
    ctx.beginPath();
    ctx.arc(mx, my, cellSize * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = P.lastMarker;
    ctx.fill();
  }
}

// ─── 画布组件 ────────────────────────────────────────────────────────────────

export interface GomokuCanvasProps {
  grid: Cell[][];
  lastMove: Move | null;
  winningLine: Array<[number, number]> | null;
  /** 每次棋盘变化都自增；本组件靠它重绘（理由见文件头）。 */
  version: number;
  /** 点击某个交叉点。不传即为只读（观战）。 */
  onCellClick?: (row: number, col: number) => void;
  /** 禁止点击（轮不到你 / 已终局 / 连接中断）。 */
  disabled?: boolean;
}

export default function GomokuCanvas({
  grid,
  lastMove,
  winningLine,
  version,
  onCellClick,
  disabled = false,
}: GomokuCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sizingRef = useRef<Sizing>(computeSizing(480));
  const darkRef = useRef<boolean>(false);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawBoard(canvas, sizingRef.current, darkRef.current ? DARK : LIGHT, grid, lastMove, winningLine);
    // version 只用来触发重绘，本身不参与绘制
    void version;
  }, [grid, lastMove, winningLine, version]);

  // 尺寸调整（对齐 renderer.resize，含 devicePixelRatio）
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const parent = wrapRef.current;
    const containerWidth = parent
      ? parent.clientWidth - 32
      : Math.min(window.innerWidth - 32, 600);

    const sizing = computeSizing(containerWidth);
    sizingRef.current = sizing;

    canvas.width = Math.floor(sizing.logicalSize * dpr);
    canvas.height = Math.floor(sizing.logicalSize * dpr);
    canvas.style.width = `${sizing.logicalSize}px`;
    canvas.style.height = `${sizing.logicalSize}px`;
    // 直接写 dataset 而不是走 state：resize 本来就要碰 DOM，不必为此多一次渲染。
    canvas.dataset.cellSize = String(sizing.cellSize);
    canvas.dataset.margin = String(sizing.margin);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }
    render();
  }, [render]);

  // 初始化 + 监听 resize / 主题
  useEffect(() => {
    darkRef.current =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark';

    resize();

    let timer: number | null = null;
    const onResize = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        resize();
      }, 150);
    };
    window.addEventListener('resize', onResize);

    // 主题切换观察者（同步暗色调色板并重绘）
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark !== darkRef.current) {
        darkRef.current = dark;
        render();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
    // 仅挂载时执行：resize 句柄随 render 变，重挂会重建监听与观察者
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 棋盘 / 最后一手 / 获胜连线 / 版本号变化 → 重绘
  useEffect(() => {
    render();
  }, [render]);

  // 画布点击 → 像素转格。**整个组件最需要小心的一段**：缩放、margin、格心
  // 距离阈值任一算错，表现都是「点偏了」而不是报错。
  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (disabled || !onCellClick) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { cellSize, margin, logicalSize } = sizingRef.current;
      const rect = canvas.getBoundingClientRect();
      const scaleX = logicalSize / rect.width;
      const scaleY = logicalSize / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const col = Math.round((x - margin) / cellSize);
      const row = Math.round((y - margin) / cellSize);
      if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;

      const cx = margin + col * cellSize;
      const cy = margin + row * cellSize;
      const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (dist > cellSize * 0.45) return;

      onCellClick(row, col);
    },
    [disabled, onCellClick]
  );

  return (
    <div className="gomoku-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`gomoku-canvas${disabled ? ' gomoku-canvas--disabled' : ''}`}
        onClick={onCanvasClick}
        role="img"
        aria-label="五子棋棋盘"
      />
    </div>
  );
}
