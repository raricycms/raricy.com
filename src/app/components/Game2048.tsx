'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 2048 — 从 Flask 侧 app/static/js/game/2048.js 忠实移植到 React 客户端组件。
// 纯前端逻辑，无服务端依赖。
//
// 规则要点（与原实现一一对应）：
//   • 4×4 网格，方向键 / WASD / 滑动移动；相同数字合并翻倍，得分累加合并值。
//   • 每次有效移动后在空格随机生成一个新块（90% 为 2，10% 为 4）。
//   • 出现 2048 判胜（可继续游戏）；无可移动方向判负。
//   • 支持悔棋（保留最近 5 步，Ctrl/Cmd+Z）与最佳分持久化（localStorage）。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

const SIZE = 4;
const WIN_VALUE = 2048;
const LS_KEY = 'game2048_best';
const SWIPE_THRESHOLD = 30;
const MAX_HISTORY = 5;

type Direction = 'left' | 'right' | 'up' | 'down';

type Tile = {
  id: number;
  r: number;
  c: number;
  value: number;
  isNew?: boolean;
  isMerged?: boolean;
};

type Snapshot = {
  tiles: Tile[];
  score: number;
};

// 瓦片配色 — 与 Flask 版一致的暖色调（颜色为游戏语义，直写十六进制）。
const TILE_STYLES: Record<number, { bg: string; fg: string }> = {
  2: { bg: '#eee4da', fg: '#776e65' },
  4: { bg: '#ede0c8', fg: '#776e65' },
  8: { bg: '#f2b179', fg: '#f9f6f2' },
  16: { bg: '#f59563', fg: '#f9f6f2' },
  32: { bg: '#f67c5f', fg: '#f9f6f2' },
  64: { bg: '#f65e3b', fg: '#f9f6f2' },
  128: { bg: '#edcf72', fg: '#f9f6f2' },
  256: { bg: '#edcc61', fg: '#f9f6f2' },
  512: { bg: '#edc850', fg: '#f9f6f2' },
  1024: { bg: '#edc53f', fg: '#f9f6f2' },
  2048: { bg: '#edc22e', fg: '#f9f6f2' },
};
const SUPER_TILE = { bg: '#3c3a32', fg: '#f9f6f2' };

function tileStyle(value: number) {
  return TILE_STYLES[value] || SUPER_TILE;
}

function fontSizeFor(value: number): string {
  const len = String(value).length;
  if (len <= 2) return '2rem';
  if (len === 3) return '1.6rem';
  if (len === 4) return '1.2rem';
  return '0.95rem';
}

function cloneTiles(tiles: Tile[]): Tile[] {
  return tiles.map((t) => ({ ...t }));
}

// ---- 网格与瓦片互转 ---------------------------------------------------------

type Cell = { value: number; id: number } | null;

function tilesToGrid(tiles: Tile[]): Cell[][] {
  const g: Cell[][] = Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(null));
  for (const t of tiles) g[t.r][t.c] = { value: t.value, id: t.id };
  return g;
}

// ---- 单行滑动（对齐 slideLineWithIds） --------------------------------------
// 输入向左对齐的一行 Cell，输出合并后的一行、得分、是否变化、合并后存活的 id。

function slideLine(line: Cell[]): {
  result: Cell[];
  scoreGain: number;
  moved: boolean;
  mergedIds: Set<number>;
} {
  const arr: Cell[] = line.filter((c): c is NonNullable<Cell> => c !== null);
  let scoreGain = 0;
  const mergedIds = new Set<number>();

  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i]!;
    const b = arr[i + 1]!;
    if (a.value === b.value) {
      const nv = a.value * 2;
      arr[i] = { value: nv, id: a.id }; // 存活 id 沿用前一块（与 Flask 一致）
      scoreGain += nv;
      mergedIds.add(a.id);
      arr[i + 1] = null as unknown as NonNullable<Cell>;
      i++;
    }
  }

  const compact: Cell[] = arr.filter((c) => c !== null) as Cell[];
  while (compact.length < SIZE) compact.push(null);

  let moved = false;
  for (let i = 0; i < SIZE; i++) {
    const before = line[i];
    const after = compact[i];
    if ((before?.value ?? 0) !== (after?.value ?? 0) || (before?.id ?? 0) !== (after?.id ?? 0)) {
      moved = true;
      break;
    }
  }

  return { result: compact, scoreGain, moved, mergedIds };
}

// 对整个网格按方向滑动，返回新瓦片数组。
function slideGrid(
  tiles: Tile[],
  direction: Direction
): { tiles: Tile[]; scoreGain: number; moved: boolean } {
  const grid = tilesToGrid(tiles);
  const next: Cell[][] = Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(null));
  let scoreGain = 0;
  let moved = false;
  const allMerged = new Set<number>();

  const runLine = (cells: Cell[], reverse: boolean): Cell[] => {
    const input = reverse ? [...cells].reverse() : cells;
    const { result, scoreGain: gain, moved: m, mergedIds } = slideLine(input);
    scoreGain += gain;
    moved = moved || m;
    mergedIds.forEach((id) => allMerged.add(id));
    return reverse ? [...result].reverse() : result;
  };

  if (direction === 'left' || direction === 'right') {
    const reverse = direction === 'right';
    for (let r = 0; r < SIZE; r++) {
      const out = runLine(grid[r], reverse);
      for (let c = 0; c < SIZE; c++) next[r][c] = out[c];
    }
  } else {
    const reverse = direction === 'down';
    for (let c = 0; c < SIZE; c++) {
      const col: Cell[] = [];
      for (let r = 0; r < SIZE; r++) col.push(grid[r][c]);
      const out = runLine(col, reverse);
      for (let r = 0; r < SIZE; r++) next[r][c] = out[r];
    }
  }

  const outTiles: Tile[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = next[r][c];
      if (cell) {
        outTiles.push({
          id: cell.id,
          r,
          c,
          value: cell.value,
          isMerged: allMerged.has(cell.id),
        });
      }
    }
  }

  return { tiles: outTiles, scoreGain, moved };
}

function emptyCells(tiles: Tile[]): Array<{ r: number; c: number }> {
  const occupied = new Set(tiles.map((t) => t.r * SIZE + t.c));
  const cells: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!occupied.has(r * SIZE + c)) cells.push({ r, c });
    }
  }
  return cells;
}

function canMove(tiles: Tile[]): boolean {
  if (emptyCells(tiles).length > 0) return true;
  const grid = tilesToGrid(tiles);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c]?.value;
      if (v === undefined) return true;
      if (c + 1 < SIZE && grid[r][c + 1]?.value === v) return true;
      if (r + 1 < SIZE && grid[r + 1][c]?.value === v) return true;
    }
  }
  return false;
}

function hasWon(tiles: Tile[]): boolean {
  return tiles.some((t) => t.value >= WIN_VALUE);
}

export default function Game2048() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  const [keepPlaying, setKeepPlaying] = useState(false);

  const nextIdRef = useRef(1);
  const historyRef = useRef<Snapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const spawnTile = useCallback((current: Tile[]): Tile | null => {
    const cells = emptyCells(current);
    if (cells.length === 0) return null;
    const { r, c } = cells[Math.floor(Math.random() * cells.length)];
    return {
      id: nextIdRef.current++,
      r,
      c,
      value: Math.random() < 0.9 ? 2 : 4,
      isNew: true,
    };
  }, []);

  const newGame = useCallback(() => {
    nextIdRef.current = 1;
    historyRef.current = [];
    setCanUndo(false);
    let start: Tile[] = [];
    const a = { id: nextIdRef.current++, ...pickEmpty(start), value: rand2or4(), isNew: true };
    start = [a];
    const b = { id: nextIdRef.current++, ...pickEmpty(start), value: rand2or4(), isNew: true };
    start = [a, b];
    setTiles(start);
    setScore(0);
    setOver(false);
    setWon(false);
    setKeepPlaying(false);
  }, []);

  // 初始化：读取最佳分并开局
  useEffect(() => {
    try {
      const v = parseInt(localStorage.getItem(LS_KEY) || '0', 10);
      if (v > 0) setBest(v);
    } catch {
      /* ignore */
    }
    newGame();
  }, [newGame]);

  const move = useCallback(
    (direction: Direction) => {
      setTiles((prev) => {
        if (over && !keepPlaying) return prev;
        if (over && keepPlaying && !canMove(prev)) return prev;

        const { tiles: slid, scoreGain, moved } = slideGrid(prev, direction);
        if (!moved) return prev;

        // 入栈用于悔棋（保存移动前快照）
        historyRef.current.push({ tiles: cloneTiles(prev), score });
        if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
        setCanUndo(true);

        const spawned = spawnTile(slid);
        const nextTiles = spawned ? [...slid, spawned] : slid;

        const newScore = score + scoreGain;
        setScore(newScore);
        if (newScore > best) {
          setBest(newScore);
          try {
            localStorage.setItem(LS_KEY, String(newScore));
          } catch {
            /* ignore */
          }
        }

        if (!won && !keepPlaying && hasWon(nextTiles)) setWon(true);
        if (!canMove(nextTiles)) setOver(true);

        return nextTiles;
      });
    },
    [over, keepPlaying, score, best, won, spawnTile]
  );

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    setTiles(prev.tiles.map((t) => ({ ...t, isNew: false, isMerged: false })));
    setScore(prev.score);
    setOver(false);
    const w = hasWon(prev.tiles);
    setWon(w && !keepPlaying ? true : false);
    setCanUndo(historyRef.current.length > 0);
  }, [keepPlaying]);

  const continuePlaying = useCallback(() => {
    setKeepPlaying(true);
    setWon(false);
  }, []);

  // 键盘输入
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keyMap: Record<string, Direction> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
        a: 'left',
        d: 'right',
        w: 'up',
        s: 'down',
      };
      const dir = keyMap[e.key];
      if (dir) {
        e.preventDefault();
        move(dir);
      }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, undo]);

  // 触摸滑动
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    if (!start || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (Math.max(absDx, absDy) < SWIPE_THRESHOLD) return;
    if (absDx > absDy) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
    touchStart.current = null;
  };

  const showOverlay = (won && !keepPlaying) || over;

  return (
    <div className="g2048">
      <style>{G2048_CSS}</style>

      <div className="g2048__header">
        <h2 className="g2048__title">2048</h2>
        <div className="g2048__scores">
          <div className="g2048__score">
            <span className="g2048__score-label">分数</span>
            <span className="g2048__score-value">{score}</span>
          </div>
          <div className="g2048__score">
            <span className="g2048__score-label">最佳</span>
            <span className="g2048__score-value">{best}</span>
          </div>
        </div>
      </div>

      <p className="g2048__desc">
        用方向键 / WASD 或滑动合并相同的数字，拼出 <strong>2048</strong>！
      </p>

      <div
        className="g2048__board-wrap"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="g2048__board">
          {Array.from({ length: SIZE * SIZE }).map((_, i) => (
            <div key={i} className="g2048__cell" />
          ))}
          {tiles.map((t) => {
            const st = tileStyle(t.value);
            return (
              <div
                key={t.id}
                className="g2048__tile"
                style={
                  {
                    '--r': t.r,
                    '--c': t.c,
                  } as React.CSSProperties
                }
              >
                <div
                  className={`g2048__face${t.isNew ? ' g2048__face--new' : ''}${
                    t.isMerged ? ' g2048__face--merged' : ''
                  }`}
                  style={{
                    background: st.bg,
                    color: st.fg,
                    fontSize: fontSizeFor(t.value),
                  }}
                >
                  {t.value}
                </div>
              </div>
            );
          })}
        </div>

        {showOverlay && (
          <div className="g2048__overlay">
            <div className="g2048__overlay-text">{won ? '你赢了！' : '游戏结束'}</div>
            {won ? (
              <button type="button" className="g2048__overlay-btn" onClick={continuePlaying}>
                继续游戏
              </button>
            ) : (
              <button type="button" className="g2048__overlay-btn" onClick={newGame}>
                再来一局
              </button>
            )}
          </div>
        )}
      </div>

      <div className="g2048__actions">
        <button type="button" className="g2048__btn" onClick={newGame}>
          新游戏
        </button>
        <button
          type="button"
          className="g2048__btn g2048__btn--secondary"
          onClick={undo}
          disabled={!canUndo}
        >
          悔棋
        </button>
      </div>
    </div>
  );
}

// ---- 开局辅助 --------------------------------------------------------------

function rand2or4(): number {
  return Math.random() < 0.9 ? 2 : 4;
}

function pickEmpty(existing: Tile[]): { r: number; c: number } {
  const cells = emptyCells(existing);
  return cells[Math.floor(Math.random() * cells.length)];
}

// 自包含样式（作用域前缀 g2048__；沿用设计令牌 var(--surface)/var(--ink)/var(--line)/var(--accent)/var(--r-sm)）
const G2048_CSS = `
.g2048 { display: flex; flex-direction: column; max-width: 480px; margin: 0 auto; }
.g2048__header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.g2048__title { font-size: 2rem; font-weight: 700; color: var(--ink, #1d1d1f); margin: 0; }
.g2048__scores { display: flex; gap: 8px; }
.g2048__score { background: var(--surface-2, #f5f5f7); border-radius: var(--r-sm, 8px); padding: 6px 14px; text-align: center; min-width: 72px; }
.g2048__score-label { display: block; font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2, #6e6e73); margin-bottom: 2px; }
.g2048__score-value { font-size: 1.15rem; font-weight: 700; color: var(--ink, #1d1d1f); }
.g2048__desc { font-size: .9rem; color: var(--ink-2, #6e6e73); margin: 0 0 16px; line-height: 1.5; }
.g2048__board-wrap {
  position: relative;
  background: var(--surface-2, #f5f5f7);
  border: 1px solid var(--line, #e5e5e9);
  border-radius: 12px;
  padding: 12px;
  aspect-ratio: 1 / 1;
  max-width: 100%;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.g2048__board {
  position: relative;
  width: 100%;
  height: 100%;
  --gap: 10px;
  --n: 4;
  --cell: calc((100% - (var(--n) - 1) * var(--gap)) / var(--n));
}
.g2048__cell {
  position: absolute;
  width: var(--cell);
  height: var(--cell);
  background: var(--surface, #fff);
  border-radius: var(--r-sm, 8px);
}
.g2048__cell:nth-child(1)  { left: calc((var(--cell) + var(--gap)) * 0); top: calc((var(--cell) + var(--gap)) * 0); }
.g2048__cell:nth-child(2)  { left: calc((var(--cell) + var(--gap)) * 1); top: calc((var(--cell) + var(--gap)) * 0); }
.g2048__cell:nth-child(3)  { left: calc((var(--cell) + var(--gap)) * 2); top: calc((var(--cell) + var(--gap)) * 0); }
.g2048__cell:nth-child(4)  { left: calc((var(--cell) + var(--gap)) * 3); top: calc((var(--cell) + var(--gap)) * 0); }
.g2048__cell:nth-child(5)  { left: calc((var(--cell) + var(--gap)) * 0); top: calc((var(--cell) + var(--gap)) * 1); }
.g2048__cell:nth-child(6)  { left: calc((var(--cell) + var(--gap)) * 1); top: calc((var(--cell) + var(--gap)) * 1); }
.g2048__cell:nth-child(7)  { left: calc((var(--cell) + var(--gap)) * 2); top: calc((var(--cell) + var(--gap)) * 1); }
.g2048__cell:nth-child(8)  { left: calc((var(--cell) + var(--gap)) * 3); top: calc((var(--cell) + var(--gap)) * 1); }
.g2048__cell:nth-child(9)  { left: calc((var(--cell) + var(--gap)) * 0); top: calc((var(--cell) + var(--gap)) * 2); }
.g2048__cell:nth-child(10) { left: calc((var(--cell) + var(--gap)) * 1); top: calc((var(--cell) + var(--gap)) * 2); }
.g2048__cell:nth-child(11) { left: calc((var(--cell) + var(--gap)) * 2); top: calc((var(--cell) + var(--gap)) * 2); }
.g2048__cell:nth-child(12) { left: calc((var(--cell) + var(--gap)) * 3); top: calc((var(--cell) + var(--gap)) * 2); }
.g2048__cell:nth-child(13) { left: calc((var(--cell) + var(--gap)) * 0); top: calc((var(--cell) + var(--gap)) * 3); }
.g2048__cell:nth-child(14) { left: calc((var(--cell) + var(--gap)) * 1); top: calc((var(--cell) + var(--gap)) * 3); }
.g2048__cell:nth-child(15) { left: calc((var(--cell) + var(--gap)) * 2); top: calc((var(--cell) + var(--gap)) * 3); }
.g2048__cell:nth-child(16) { left: calc((var(--cell) + var(--gap)) * 3); top: calc((var(--cell) + var(--gap)) * 3); }
.g2048__tile {
  position: absolute;
  width: var(--cell);
  height: var(--cell);
  left: calc((var(--cell) + var(--gap)) * var(--c));
  top: calc((var(--cell) + var(--gap)) * var(--r));
  transition: left 120ms ease, top 120ms ease;
  z-index: 1;
}
.g2048__face {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%;
  border-radius: var(--r-sm, 8px);
  font-weight: 700; line-height: 1;
}
.g2048__face--new { animation: g2048-appear 200ms ease 90ms backwards; }
.g2048__face--merged { animation: g2048-pop 200ms ease 120ms backwards; }
@keyframes g2048-appear { 0% { transform: scale(0); opacity: 0; } 60% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 1; } }
@keyframes g2048-pop { 0% { transform: scale(1); } 35% { transform: scale(1.25); } 100% { transform: scale(1); } }
.g2048__overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(0,0,0,.45); border-radius: 12px; z-index: 10; gap: 12px;
}
.g2048__overlay-text { color: #fff; font-size: 2rem; font-weight: 700; }
.g2048__overlay-btn {
  padding: 8px 24px; border: 1px solid #fff; border-radius: 999px;
  background: transparent; color: #fff; font-size: 1rem; font-family: inherit; cursor: pointer;
  transition: background .2s;
}
.g2048__overlay-btn:hover { background: rgba(255,255,255,.15); }
.g2048__actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
.g2048__btn {
  padding: 7px 18px; border: 1px solid var(--accent, #0071e3); border-radius: var(--r-sm, 8px);
  background: var(--accent, #0071e3); color: #fff; font-size: .9rem; font-family: inherit; cursor: pointer;
  transition: opacity .2s;
}
.g2048__btn:hover:not(:disabled) { opacity: .85; }
.g2048__btn--secondary { background: transparent; color: var(--ink-2, #6e6e73); border-color: var(--line-2, #d2d2d7); }
.g2048__btn--secondary:hover:not(:disabled) { border-color: var(--ink-2, #6e6e73); opacity: 1; }
.g2048__btn:disabled { opacity: .45; cursor: not-allowed; }
@media (max-width: 640px) {
  .g2048__title { font-size: 1.5rem; }
  .g2048__board { --gap: 7px; }
  .g2048__overlay-text { font-size: 1.5rem; }
}
`;
