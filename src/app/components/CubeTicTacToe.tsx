'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 立方棋（4×4×4 Cube Tic-Tac-Toe）— 从 Flask 侧 app/static/js/game/cubetictactoe.js
// 忠实移植到 React 客户端组件。纯前端逻辑，无服务端依赖、无 AI（本地双人对战）。
//
// 规则要点（与原实现一一对应）：
//   • 4×4×4 = 64 个小立方体；红方（red）先手，红蓝交替落子。
//   • 13 个方向向量覆盖全 76 条连线，任一方向连成 4 子即获胜。
//   • 总步数达 64 步仍无胜负则平局。
//   • 悔棋：撤销 1 步（Ctrl/Cmd+Z 或按钮）；重新开始。
//   • 绿框标记最后一步；金框高亮获胜连线；空格悬停黄色高亮。
//
// 3D 视角（与原 CSS transform 体系一致）：
//   • 场景 perspective 1200px；立方体系统 preserve-3d，可拖拽 / 滑动旋转。
//   • rotationX/rotationY 初始 -15° / 25°，scaleFactor 依场景尺寸自适应。
//   • 爆炸视图：A/S/D 键或按钮沿 Z/Y/X 轴展开（每格偏移 (i-1.5)*60px）。
//
// 旋转/缩放高频变化 → 直接写 cubeSystem 元素的 transform（命令式，绕过 React 渲染）；
// 落子/悔棋/爆炸等离散状态 → React state 驱动 64 个立方体重绘（带 CSS 0.5s 过渡）。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Player = 'red' | 'blue';
type Axis = 'x' | 'y' | 'z';

// 13 个方向向量，覆盖 4×4×4 网格上全部 76 条获胜连线
const WIN_DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 1, 0], [1, -1, 0],
  [1, 0, 1], [1, 0, -1],
  [0, 1, 1], [0, 1, -1],
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1],
];

const SIZE = 4;
const STEP = 60; // 每格间距（px），与原 (x-1.5)*60 一致
const HALF = (SIZE - 1) / 2; // 1.5

const FACE_NAMES = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const;

/** 坐标 → 一维索引（x 最高位，与遍历顺序无关，仅需一致） */
function idx(x: number, y: number, z: number): number {
  return x * 16 + y * 4 + z;
}

type Move = { x: number; y: number; z: number; player: Player };

/** 检查 player 是否形成四子连线；返回连线的索引数组，或 null。对齐 checkWin。 */
function checkWin(cells: (Player | null)[], player: Player): number[] | null {
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      for (let z = 0; z < SIZE; z++) {
        for (const [dx, dy, dz] of WIN_DIRECTIONS) {
          const line: number[] = [];
          let valid = true;
          for (let i = 0; i < SIZE; i++) {
            const nx = x + dx * i;
            const ny = y + dy * i;
            const nz = z + dz * i;
            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || nz < 0 || nz >= SIZE) {
              valid = false;
              break;
            }
            if (cells[idx(nx, ny, nz)] !== player) {
              valid = false;
              break;
            }
            line.push(idx(nx, ny, nz));
          }
          if (valid && line.length === SIZE) {
            return line;
          }
        }
      }
    }
  }
  return null;
}

type CubeMeta = { x: number; y: number; z: number; baseX: number; baseY: number; baseZ: number };

// 预生成 64 个立方体的坐标与基准位置（顺序：x→y→z，与原 createCubes 一致）
const CUBE_METAS: CubeMeta[] = (() => {
  const list: CubeMeta[] = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      for (let z = 0; z < SIZE; z++) {
        list.push({
          x,
          y,
          z,
          baseX: (x - HALF) * STEP,
          baseY: (y - HALF) * STEP,
          baseZ: (z - HALF) * STEP,
        });
      }
    }
  }
  return list;
})();

export default function CubeTicTacToe() {
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const systemRef = useRef<HTMLDivElement | null>(null);

  // ── 视角状态（高频，走 ref + 命令式写 transform）─────────────────────────────
  const rotationXRef = useRef(-15);
  const rotationYRef = useRef(25);
  const scaleRef = useRef(1);
  const isDraggingRef = useRef(false);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const rotationStartRef = useRef({ x: 0, y: 0 });

  // ── 棋局状态（离散，走 React state）─────────────────────────────────────────
  const [cells, setCells] = useState<(Player | null)[]>(() => Array(64).fill(null));
  const [currentPlayer, setCurrentPlayer] = useState<Player>('red');
  const [gameEnded, setGameEnded] = useState(false);
  const [winner, setWinner] = useState<Player | null>(null);
  const [isDraw, setIsDraw] = useState(false);
  const [winningSet, setWinningSet] = useState<Set<number>>(() => new Set());
  const [lastMoveIndex, setLastMoveIndex] = useState<number | null>(null);
  const [explode, setExplode] = useState<{ x: boolean; y: boolean; z: boolean }>({
    x: false,
    y: false,
    z: false,
  });

  const moveHistoryRef = useRef<Move[]>([]);
  const gameEndedRef = useRef(false);
  gameEndedRef.current = gameEnded;

  const redCount = useMemo(() => cells.filter((c) => c === 'red').length, [cells]);
  const blueCount = useMemo(() => cells.filter((c) => c === 'blue').length, [cells]);
  const totalMoves = redCount + blueCount;

  // ── 视角 transform 命令式写入 ───────────────────────────────────────────────
  const applyRotation = useCallback(() => {
    const sys = systemRef.current;
    if (!sys) return;
    sys.style.transform = `scale(${scaleRef.current}) rotateX(${rotationXRef.current}deg) rotateY(${rotationYRef.current}deg)`;
  }, []);

  const updateScale = useCallback(() => {
    const scene = sceneRef.current;
    const minDim = scene
      ? Math.min(scene.clientWidth, scene.clientHeight)
      : Math.min(typeof window !== 'undefined' ? window.innerWidth : 480, 480);
    const baseSize = 230;
    const targetSize = minDim * 0.8;
    const s = targetSize / baseSize;
    scaleRef.current = Math.max(0.6, Math.min(1.6, s));
    applyRotation();
  }, [applyRotation]);

  // ── 落子（对齐 placePiece）──────────────────────────────────────────────────
  const placePiece = useCallback(
    (i: number) => {
      if (gameEndedRef.current) return;
      if (cells[i] !== null) return;

      const meta = CUBE_METAS[i];
      const player = currentPlayer;

      moveHistoryRef.current.push({ x: meta.x, y: meta.y, z: meta.z, player });

      const next = cells.slice();
      next[i] = player;
      setCells(next);
      setLastMoveIndex(i);

      const winningLine = checkWin(next, player);
      if (winningLine) {
        setWinningSet(new Set(winningLine));
        setWinner(player);
        setIsDraw(false);
        setGameEnded(true);
        return;
      }

      // 平局：总步数达 64
      if (next.filter((c) => c !== null).length >= 64) {
        setIsDraw(true);
        setWinner(null);
        setGameEnded(true);
        return;
      }

      setCurrentPlayer(player === 'red' ? 'blue' : 'red');
    },
    [cells, currentPlayer]
  );

  // ── 悔棋（对齐 undoMove）────────────────────────────────────────────────────
  const undoMove = useCallback(() => {
    if (moveHistoryRef.current.length === 0 || gameEndedRef.current) return;

    const last = moveHistoryRef.current.pop();
    if (!last) return;
    const i = idx(last.x, last.y, last.z);

    setCells((prev) => {
      const next = prev.slice();
      next[i] = null;
      return next;
    });

    setCurrentPlayer(last.player);
    setWinningSet(new Set());
    setWinner(null);
    setIsDraw(false);
    setGameEnded(false);

    const hist = moveHistoryRef.current;
    if (hist.length > 0) {
      const prevMove = hist[hist.length - 1];
      setLastMoveIndex(idx(prevMove.x, prevMove.y, prevMove.z));
    } else {
      setLastMoveIndex(null);
    }
  }, []);

  // ── 重新开始（对齐 resetGame）───────────────────────────────────────────────
  const resetGame = useCallback(() => {
    moveHistoryRef.current = [];
    setCells(Array(64).fill(null));
    setCurrentPlayer('red');
    setGameEnded(false);
    setWinner(null);
    setIsDraw(false);
    setWinningSet(new Set());
    setLastMoveIndex(null);
  }, []);

  // ── 爆炸视图切换（对齐 toggleExplode）───────────────────────────────────────
  const toggleExplode = useCallback((axis: Axis) => {
    setExplode((prev) => ({ ...prev, [axis]: !prev[axis] }));
  }, []);

  // ── 每个立方体的 transform（含爆炸偏移，React 驱动，带 CSS 0.5s 过渡）───────
  const cubeTransform = useCallback(
    (meta: CubeMeta): string => {
      let offX = 0;
      let offY = 0;
      let offZ = 0;
      if (explode.x) offX = (meta.x - HALF) * STEP;
      if (explode.y) offY = (meta.y - HALF) * STEP;
      if (explode.z) offZ = (meta.z - HALF) * STEP;
      return `translate3d(${meta.baseX + offX}px, ${meta.baseY + offY}px, ${meta.baseZ + offZ}px)`;
    },
    [explode]
  );

  // ── 视角旋转：指针拖拽（鼠标 + 触摸）────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const inPanel = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!(el && (el.closest('.cubettt-info') || el.closest('.cubettt-controls')));
    };

    const startDrag = (clientX: number, clientY: number) => {
      isDraggingRef.current = true;
      pointerStartRef.current = { x: clientX, y: clientY };
      rotationStartRef.current = { x: rotationXRef.current, y: rotationYRef.current };
    };

    const moveDrag = (clientX: number, clientY: number) => {
      if (!isDraggingRef.current) return;
      const deltaX = clientX - pointerStartRef.current.x;
      const deltaY = clientY - pointerStartRef.current.y;
      rotationYRef.current = rotationStartRef.current.y + deltaX * 0.5;
      rotationXRef.current = rotationStartRef.current.x - deltaY * 0.5;
      rotationXRef.current = Math.max(-90, Math.min(90, rotationXRef.current));
      applyRotation();
    };

    const onMouseDown = (e: MouseEvent) => {
      if (inPanel(e.target)) return;
      startDrag(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => moveDrag(e.clientX, e.clientY);
    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (inPanel(e.target)) return;
      const t = e.touches[0];
      startDrag(t.clientX, t.clientY);
      e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return;
      const t = e.touches[0];
      moveDrag(t.clientX, t.clientY);
      e.preventDefault();
    };
    const onTouchEnd = () => {
      isDraggingRef.current = false;
    };

    scene.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    scene.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    return () => {
      scene.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      scene.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [applyRotation]);

  // ── 键盘：A/S/D 爆炸，Ctrl/Cmd+Z 悔棋（对齐 keydown）──────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      switch (key) {
        case 'a':
          e.preventDefault();
          toggleExplode('z');
          break;
        case 's':
          e.preventDefault();
          toggleExplode('y');
          break;
        case 'd':
          e.preventDefault();
          toggleExplode('x');
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            undoMove();
          }
          break;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggleExplode, undoMove]);

  // ── 初始化 + 尺寸自适应 ─────────────────────────────────────────────────────
  useEffect(() => {
    updateScale();
    applyRotation();

    const onResize = () => updateScale();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [updateScale, applyRotation]);

  // ── 触摸落子：区分点按与滑动（对齐 cubeTouch* 逻辑）──────────────────────────
  const touchStateRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onCubeTouchStart = useCallback((e: React.TouchEvent) => {
    if (gameEndedRef.current) return;
    e.stopPropagation();
    const t = e.touches[0];
    touchStateRef.current = { x: t.clientX, y: t.clientY, moved: false };
    e.preventDefault();
  }, []);

  const onCubeTouchMove = useCallback((e: React.TouchEvent) => {
    const st = touchStateRef.current;
    if (!st) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - st.x) > 10 || Math.abs(t.clientY - st.y) > 10) {
      st.moved = true;
    }
    e.preventDefault();
  }, []);

  const onCubeTouchEnd = useCallback(
    (i: number) => (e: React.TouchEvent) => {
      if (gameEndedRef.current) return;
      e.stopPropagation();
      const st = touchStateRef.current;
      if (st && !st.moved && cells[i] === null) {
        placePiece(i);
      }
      touchStateRef.current = null;
      e.preventDefault();
    },
    [cells, placePiece]
  );

  const playerName = (p: Player) => (p === 'red' ? '红方' : '蓝方');

  return (
    <div className={`cubettt-page ${gameEnded ? 'is-ended' : 'is-playing'}`}>
      <style>{CUBETTT_CSS}</style>

      {/* 信息面板 */}
      <div className="cubettt-info">
        {winner && (
          <div className="cubettt-info__winner" style={{ display: 'block' }}>
            🎉 {playerName(winner)}获胜！
          </div>
        )}
        {isDraw && (
          <div className="cubettt-info__draw" style={{ display: 'block' }}>
            🤝 平局！
          </div>
        )}
        {!gameEnded && (
          <div className="cubettt-info__player">当前玩家: {playerName(currentPlayer)}</div>
        )}
        <div className="cubettt-info__row">
          红方棋子: <span>{redCount}</span>
        </div>
        <div className="cubettt-info__row">
          蓝方棋子: <span>{blueCount}</span>
        </div>
        <div className="cubettt-info__row">
          总步数: <span>{totalMoves}</span> / 64
        </div>
        <div className="cubettt-info__actions">
          <button
            type="button"
            className="cubettt-btn cubettt-btn--undo"
            onClick={undoMove}
            disabled={moveHistoryRef.current.length === 0 || gameEnded}
          >
            悔棋
          </button>
          <button type="button" className="cubettt-btn" onClick={resetGame}>
            重新开始
          </button>
        </div>
      </div>

      {/* 操作说明 + 爆炸视图控制 */}
      <div className="cubettt-controls">
        <div className="cubettt-controls__title">操作说明:</div>
        <div>• 拖拽/滑动旋转视角</div>
        <div>• 点击/轻触下棋</div>
        <div>• A/S/D键爆炸视图</div>
        <div>• 四子连线获胜</div>
        <div>• 绿框显示最后一步</div>
        <div>• 64步无胜负为平局</div>
        <div className="cubettt-controls__explode">
          <div className="cubettt-controls__title">手机端爆炸视图:</div>
          <button
            type="button"
            className={`cubettt-btn cubettt-btn--toggle ${explode.z ? 'active' : ''}`}
            aria-pressed={explode.z}
            title="键盘 A"
            onClick={() => toggleExplode('z')}
          >
            Z轴(A)
          </button>
          <button
            type="button"
            className={`cubettt-btn cubettt-btn--toggle ${explode.y ? 'active' : ''}`}
            aria-pressed={explode.y}
            title="键盘 S"
            onClick={() => toggleExplode('y')}
          >
            Y轴(S)
          </button>
          <button
            type="button"
            className={`cubettt-btn cubettt-btn--toggle ${explode.x ? 'active' : ''}`}
            aria-pressed={explode.x}
            title="键盘 D"
            onClick={() => toggleExplode('x')}
          >
            X轴(D)
          </button>
        </div>
      </div>

      {/* 3D 场景 */}
      <div className="cubettt-scene" ref={sceneRef}>
        <div className="cubettt-system" ref={systemRef}>
          {CUBE_METAS.map((meta, i) => {
            const player = cells[i];
            const classes = ['cubettt-cube'];
            if (player === 'red') classes.push('cubettt-cube--red');
            if (player === 'blue') classes.push('cubettt-cube--blue');
            if (winningSet.has(i)) classes.push('cubettt-cube--winning');
            if (lastMoveIndex === i) classes.push('cubettt-cube--last-move');
            if (player === null) classes.push('cubettt-cube--empty');

            return (
              <div
                key={i}
                className={classes.join(' ')}
                style={{ transform: cubeTransform(meta) }}
                onClick={(e) => {
                  if (gameEnded) return;
                  e.stopPropagation();
                  if (cells[i] !== null) return;
                  placePiece(i);
                }}
                onTouchStart={onCubeTouchStart}
                onTouchMove={onCubeTouchMove}
                onTouchEnd={onCubeTouchEnd(i)}
              >
                {FACE_NAMES.map((face) => (
                  <div key={face} className={`cubettt-face cubettt-face--${face}`} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 自包含样式（作用域前缀 cubettt-*；颜色走 web-next 设计令牌 CSS 变量并带回退）
// 移植自 Flask app/static/scss/pages/game/_cubetictactoe.scss，改 fixed 布局为组件内 absolute
const CUBETTT_CSS = `
.cubettt-page {
  position: relative;
  width: 100%;
  height: min(72vh, 560px);
  overflow: hidden;
  border: 1px solid var(--line, #e0e0e0);
  border-radius: var(--r-sm, 10px);
  background: var(--surface-2, #f5f5f7);
  font-family: Arial, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.cubettt-scene {
  position: absolute;
  inset: 0;
  perspective: 1200px;
  perspective-origin: center center;
  display: flex;
  justify-content: center;
  align-items: center;
  touch-action: none;
  cursor: grab;
}
.cubettt-scene:active { cursor: grabbing; }
.cubettt-system {
  position: relative;
  transform-style: preserve-3d;
  transform-origin: center center;
  touch-action: none;
}
.cubettt-cube {
  position: absolute;
  width: 50px;
  height: 50px;
  transform-style: preserve-3d;
  transition: transform 0.5s ease-in-out;
  cursor: pointer;
}
.cubettt-face {
  position: absolute;
  width: 50px;
  height: 50px;
  border: 1px solid #333;
  background: rgba(255, 255, 255, 0.8);
  transition: background-color 0.2s ease;
}
.cubettt-face--front  { transform: translateZ(25px); }
.cubettt-face--back   { transform: translateZ(-25px) rotateY(180deg); }
.cubettt-face--right  { transform: rotateY(90deg) translateZ(25px); }
.cubettt-face--left   { transform: rotateY(-90deg) translateZ(25px); }
.cubettt-face--top    { transform: rotateX(90deg) translateZ(25px); }
.cubettt-face--bottom { transform: rotateX(-90deg) translateZ(25px); }

.cubettt-page.is-playing .cubettt-cube--empty:hover .cubettt-face { background: rgba(255, 255, 0, 0.6); }
.cubettt-cube--red .cubettt-face { background: rgba(255, 100, 100, 0.8); }
.cubettt-cube--blue .cubettt-face { background: rgba(100, 100, 255, 0.8); }
.cubettt-cube--winning .cubettt-face {
  background: rgba(255, 215, 0, 0.9) !important;
  border: 3px solid #ffd700 !important;
  box-shadow: 0 0 20px rgba(255, 215, 0, 0.8);
}
.cubettt-cube--last-move .cubettt-face {
  border: 2px solid #4caf50 !important;
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.4);
}

.cubettt-info {
  position: absolute;
  top: 16px;
  left: 16px;
  background: var(--surface, #fff);
  color: var(--ink, #222);
  padding: 15px;
  border-radius: var(--r-sm, 8px);
  font-size: 14px;
  z-index: 5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  border: 1px solid var(--line, #e0e0e0);
  min-width: 160px;
}
.cubettt-info__player { font-size: 16px; font-weight: bold; margin-bottom: 10px; }
.cubettt-info__winner { font-size: 18px; font-weight: bold; color: #ffd700; margin-bottom: 10px; }
.cubettt-info__draw { font-size: 18px; font-weight: bold; color: #ffa500; margin-bottom: 10px; }
.cubettt-info__row { margin-bottom: 4px; }
.cubettt-info__actions { margin-top: 10px; }

.cubettt-btn {
  background: #4caf50;
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  margin: 5px 5px 0 0;
  font-size: 12px;
  transition: background-color 0.2s ease;
}
.cubettt-btn:hover:not(:disabled) { background: #45a049; }
.cubettt-btn:disabled { background: #666; cursor: not-allowed; }
.cubettt-btn--undo { background: #ff9800; }
.cubettt-btn--undo:hover:not(:disabled) { background: #e68900; }
.cubettt-btn--toggle { background: #607d8b; }
.cubettt-btn--toggle:hover:not(:disabled) { background: #546e7a; }
.cubettt-btn--toggle.active { background: #2196f3; }

.cubettt-controls {
  position: absolute;
  bottom: 16px;
  left: 16px;
  background: var(--surface, #fff);
  color: var(--ink, #222);
  padding: 15px;
  border-radius: var(--r-sm, 8px);
  font-size: 12px;
  z-index: 5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  border: 1px solid var(--line, #e0e0e0);
  line-height: 1.6;
}
.cubettt-controls__title { font-weight: bold; margin-bottom: 6px; }
.cubettt-controls__explode { margin-top: 10px; }
.cubettt-controls__explode .cubettt-controls__title { margin-bottom: 6px; }
.cubettt-controls__explode .cubettt-btn { margin-top: 6px; }

[data-theme="dark"] .cubettt-face {
  background: rgba(60, 60, 60, 0.8);
  border-color: #555;
}
[data-theme="dark"] .cubettt-page.is-playing .cubettt-cube--empty:hover .cubettt-face {
  background: rgba(255, 255, 0, 0.5);
}

@media (max-width: 600px) {
  .cubettt-info, .cubettt-controls { font-size: 12px; padding: 10px; }
  .cubettt-info__player { font-size: 14px; }
  .cubettt-info__winner, .cubettt-info__draw { font-size: 16px; }
  .cubettt-btn { padding: 10px 14px; font-size: 14px; }
}
`;
