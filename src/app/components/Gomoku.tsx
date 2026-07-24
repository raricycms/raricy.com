'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 五子棋（Gomoku）— 从 Flask 侧 app/static/js/game/gomoku/{constants,board,ai,
// renderer,main}.js 忠实移植到 React 客户端组件。纯前端逻辑，无服务端依赖。
//
// 规则要点（与原实现一一对应）：
//   • 15×15 棋盘；黑先（BLACK=1），白后（WHITE=2）。
//   • 四方向扫描（右 / 下 / 右下 / 左下），任一方向连成 ≥5 子即获胜。
//   • 双人对战（pvp）或人机对战（ai，人执黑、AI 执白）。
//   • AI：即时制胜/拦截快路 + 深度 4 的 Minimax + Alpha-Beta 剪枝，
//     基于模式（活四/冲四/活三…）的启发式评估，候选宽度 12。
//   • 悔棋：pvp 撤销 1 步；ai 撤销 2 步（AI 的 + 人的）。重新开始。
//
// 棋盘用 <canvas> 绘制（与原实现一致），棋局状态存于 ref，命令式重绘。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── 常量（对齐 constants.js）────────────────────────────────────────────────
const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
type Cell = typeof EMPTY | typeof BLACK | typeof WHITE;
type Player = typeof BLACK | typeof WHITE;

/** 方向向量：右、下、右下、左下 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

const SCORE = {
  FIVE: 1000000,
  OPEN_FOUR: 100000,
  CLOSED_FOUR: 10000,
  OPEN_THREE: 5000,
  CLOSED_THREE: 500,
  OPEN_TWO: 200,
  CLOSED_TWO: 50,
  OPEN_ONE: 10,
  CENTER_WEIGHT: 3,
} as const;

const WIN_LENGTH = 5;
const MAX_DEPTH = 4;
const CANDIDATE_WIDTH = 12;
const DEFENSE_WEIGHT = 1.05;
const INF = 1e9;

type Move = { row: number; col: number; player: Player };

// ─── 棋盘模型（对齐 board.js）─────────────────────────────────────────────────
class GomokuBoard {
  size: number;
  grid: Cell[][];
  moveHistory: Move[];
  moveCount: number;

  constructor(size = BOARD_SIZE) {
    this.size = size;
    this.grid = [];
    this.moveHistory = [];
    this.moveCount = 0;
    this.reset();
  }

  reset(): void {
    this.grid = [];
    for (let r = 0; r < this.size; r++) {
      this.grid[r] = new Array<Cell>(this.size).fill(EMPTY);
    }
    this.moveHistory = [];
    this.moveCount = 0;
  }

  isValidMove(row: number, col: number): boolean {
    return (
      row >= 0 &&
      row < this.size &&
      col >= 0 &&
      col < this.size &&
      this.grid[row][col] === EMPTY
    );
  }

  placeStone(row: number, col: number, player: Player): boolean {
    if (!this.isValidMove(row, col)) return false;
    this.grid[row][col] = player;
    this.moveHistory.push({ row, col, player });
    this.moveCount++;
    return true;
  }

  undo(): Move | null {
    const move = this.moveHistory.pop();
    if (!move) return null;
    this.grid[move.row][move.col] = EMPTY;
    this.moveCount--;
    return move;
  }

  /** 检查 (row,col) 落子是否形成五连。返回 { won, line }。 */
  checkWinAt(
    row: number,
    col: number,
    player: Player
  ): { won: boolean; line: Array<[number, number]> } {
    for (const [dr, dc] of DIRECTIONS) {
      const line: Array<[number, number]> = [[row, col]];

      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < this.size && c >= 0 && c < this.size && this.grid[r][c] === player) {
        line.push([r, c]);
        r += dr;
        c += dc;
      }
      r = row - dr;
      c = col - dc;
      while (r >= 0 && r < this.size && c >= 0 && c < this.size && this.grid[r][c] === player) {
        line.unshift([r, c]);
        r -= dr;
        c -= dc;
      }

      if (line.length >= WIN_LENGTH) {
        return { won: true, line };
      }
    }
    return { won: false, line: [] };
  }

  isFull(): boolean {
    return this.moveCount >= this.size * this.size;
  }

  getLastMove(): Move | null {
    if (this.moveHistory.length === 0) return null;
    return this.moveHistory[this.moveHistory.length - 1];
  }

  getHistory(): Move[] {
    return this.moveHistory.slice();
  }

  /** 距任一子 range 步内的空格候选；空盘只返回中心。 */
  getCandidateCells(range = 2): Array<{ row: number; col: number }> {
    const seen = new Set<number>();
    let hasStone = false;

    const addCell = (r: number, c: number): void => {
      if (r < 0 || r >= this.size || c < 0 || c >= this.size) return;
      if (this.grid[r][c] !== EMPTY) return;
      seen.add(r * this.size + c);
    };

    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.grid[r][c] !== EMPTY) {
          hasStone = true;
          for (let dr = -range; dr <= range; dr++) {
            for (let dc = -range; dc <= range; dc++) {
              addCell(r + dr, c + dc);
            }
          }
        }
      }
    }

    if (!hasStone) {
      const center = Math.floor(this.size / 2);
      return [{ row: center, col: center }];
    }

    const result: Array<{ row: number; col: number }> = [];
    for (const key of seen) {
      result.push({ row: Math.floor(key / this.size), col: key % this.size });
    }
    return result;
  }
}

// ─── AI 引擎（对齐 ai.js）─────────────────────────────────────────────────────
class GomokuAI {
  board: GomokuBoard;
  aiPlayer: Player;
  humanPlayer: Player;

  constructor(board: GomokuBoard, aiPlayer: Player) {
    this.board = board;
    this.aiPlayer = aiPlayer;
    this.humanPlayer = aiPlayer === BLACK ? WHITE : BLACK;
  }

  getBestMove(): { row: number; col: number } {
    const candidates = this.board.getCandidateCells(2);

    // 快路 1：AI 能否立即取胜？
    for (const { row: cr, col: cc } of candidates) {
      this.board.placeStone(cr, cc, this.aiPlayer);
      const wr = this.board.checkWinAt(cr, cc, this.aiPlayer);
      this.board.undo();
      if (wr.won) return { row: cr, col: cc };
    }

    // 快路 2：必须拦截人类？
    for (const { row: cr, col: cc } of candidates) {
      this.board.placeStone(cr, cc, this.humanPlayer);
      const wr = this.board.checkWinAt(cr, cc, this.humanPlayer);
      this.board.undo();
      if (wr.won) return { row: cr, col: cc };
    }

    // 走法排序：为每个候选打分
    const scored = candidates.map((c) => {
      const off = this.quickEval(c.row, c.col, this.aiPlayer);
      const def = this.quickEval(c.row, c.col, this.humanPlayer);
      return { row: c.row, col: c.col, score: off + def * DEFENSE_WEIGHT };
    });
    scored.sort((a, b) => b.score - a.score);

    // 对靠前候选做 Minimax 搜索
    let bestScore = -INF;
    let bestMove: { row: number; col: number } = scored[0];
    const topN = Math.min(scored.length, CANDIDATE_WIDTH);

    for (let i = 0; i < topN; i++) {
      const r = scored[i].row;
      const c = scored[i].col;
      this.board.placeStone(r, c, this.aiPlayer);

      const winCheck = this.board.checkWinAt(r, c, this.aiPlayer);
      let score: number;
      if (winCheck.won) {
        score = SCORE.FIVE;
      } else if (this.board.isFull()) {
        score = 0;
      } else {
        score = this.minimax(MAX_DEPTH - 1, -INF, INF, false);
      }

      this.board.undo();

      if (score > bestScore) {
        bestScore = score;
        bestMove = { row: r, col: c };
      }
    }

    return bestMove;
  }

  private minimax(depth: number, alpha: number, beta: number, maximizing: boolean): number {
    if (depth === 0) {
      return this.evaluateBoard();
    }

    const player: Player = maximizing ? this.aiPlayer : this.humanPlayer;
    const candidates = this.board.getCandidateCells(2);

    const scored = candidates.map((c) => ({
      row: c.row,
      col: c.col,
      score: this.quickEval(c.row, c.col, player),
    }));
    scored.sort((a, b) => b.score - a.score);
    const limit = Math.min(scored.length, CANDIDATE_WIDTH);

    if (maximizing) {
      let best = -INF;
      for (let i = 0; i < limit; i++) {
        const r = scored[i].row;
        const c = scored[i].col;
        this.board.placeStone(r, c, player);

        const winCheck = this.board.checkWinAt(r, c, player);
        let childScore: number;
        if (winCheck.won) {
          childScore = SCORE.FIVE;
        } else if (this.board.isFull()) {
          childScore = 0;
        } else {
          childScore = this.minimax(depth - 1, alpha, beta, false);
        }

        this.board.undo();

        if (childScore > best) best = childScore;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    } else {
      let best = INF;
      for (let i = 0; i < limit; i++) {
        const r = scored[i].row;
        const c = scored[i].col;
        this.board.placeStone(r, c, player);

        const winCheck = this.board.checkWinAt(r, c, player);
        let childScore: number;
        if (winCheck.won) {
          childScore = -SCORE.FIVE;
        } else if (this.board.isFull()) {
          childScore = 0;
        } else {
          childScore = this.minimax(depth - 1, alpha, beta, true);
        }

        this.board.undo();

        if (childScore < best) best = childScore;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }
  }

  private evaluateBoard(): number {
    const aiScore = this.scanLines(this.aiPlayer);
    const humanScore = this.scanLines(this.humanPlayer);

    let centerBonus = 0;
    const center = Math.floor(BOARD_SIZE / 2);
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board.grid[r][c] === this.aiPlayer) {
          centerBonus += Math.max(0, BOARD_SIZE - Math.abs(r - center) - Math.abs(c - center));
        }
        if (this.board.grid[r][c] === this.humanPlayer) {
          centerBonus -= Math.max(0, BOARD_SIZE - Math.abs(r - center) - Math.abs(c - center));
        }
      }
    }

    return aiScore - humanScore * DEFENSE_WEIGHT + centerBonus * SCORE.CENTER_WEIGHT;
  }

  private scanLines(player: Player): number {
    let total = 0;
    // 行
    for (let r = 0; r < BOARD_SIZE; r++) total += this.evalLine(r, 0, 0, 1, player);
    // 列
    for (let c = 0; c < BOARD_SIZE; c++) total += this.evalLine(0, c, 1, 0, player);
    // 主对角线 ↘
    for (let r = 0; r < BOARD_SIZE; r++) total += this.evalLine(r, 0, 1, 1, player);
    for (let c = 1; c < BOARD_SIZE; c++) total += this.evalLine(0, c, 1, 1, player);
    // 副对角线 ↙
    for (let r = 0; r < BOARD_SIZE; r++) total += this.evalLine(r, BOARD_SIZE - 1, 1, -1, player);
    for (let c = 0; c < BOARD_SIZE - 1; c++) total += this.evalLine(0, c, 1, -1, player);
    return total;
  }

  private evalLine(
    startR: number,
    startC: number,
    dr: number,
    dc: number,
    player: Player
  ): number {
    let score = 0;
    let r = startR;
    let c = startC;

    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
      const cell = this.board.grid[r][c];

      if (cell === EMPTY || cell !== player) {
        r += dr;
        c += dc;
        continue;
      }

      const runR = r;
      const runC = c;
      let count = 0;
      while (
        r >= 0 &&
        r < BOARD_SIZE &&
        c >= 0 &&
        c < BOARD_SIZE &&
        this.board.grid[r][c] === player
      ) {
        count++;
        r += dr;
        c += dc;
      }

      const beforeR = runR - dr;
      const beforeC = runC - dc;
      const afterR = r;
      const afterC = c;
      const openBefore =
        this.inBounds(beforeR, beforeC) && this.board.grid[beforeR][beforeC] === EMPTY;
      const openAfter =
        this.inBounds(afterR, afterC) && this.board.grid[afterR][afterC] === EMPTY;
      const openEnds = (openBefore ? 1 : 0) + (openAfter ? 1 : 0);

      score += this.classifyScore(count, openEnds);
    }

    return score;
  }

  private quickEval(row: number, col: number, player: Player): number {
    let score = 0;
    for (const [dr, dc] of DIRECTIONS) {
      score += this.evalDirVirtual(row, col, dr, dc, player);
    }
    const center = Math.floor(BOARD_SIZE / 2);
    score +=
      Math.max(0, BOARD_SIZE - Math.abs(row - center) - Math.abs(col - center)) *
      SCORE.CENTER_WEIGHT;
    return score;
  }

  private evalDirVirtual(
    row: number,
    col: number,
    dr: number,
    dc: number,
    player: Player
  ): number {
    let count = 1;
    let openEnds = 0;
    let jumpBonus = 0;

    // 正方向
    let r = row + dr;
    let c = col + dc;
    while (this.inBounds(r, c) && this.board.grid[r][c] === player) {
      count++;
      r += dr;
      c += dc;
    }
    if (this.inBounds(r, c) && this.board.grid[r][c] === EMPTY) {
      openEnds++;
      let jr = r + dr;
      let jc = c + dc;
      if (this.inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
        while (this.inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
          jumpBonus++;
          jr += dr;
          jc += dc;
        }
      }
    }

    // 负方向
    r = row - dr;
    c = col - dc;
    while (this.inBounds(r, c) && this.board.grid[r][c] === player) {
      count++;
      r -= dr;
      c -= dc;
    }
    if (this.inBounds(r, c) && this.board.grid[r][c] === EMPTY) {
      openEnds++;
      let jr = r - dr;
      let jc = c - dc;
      if (this.inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
        while (this.inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
          jumpBonus++;
          jr -= dr;
          jc -= dc;
        }
      }
    }

    count += Math.floor(jumpBonus * 0.8);
    return this.classifyScore(count, openEnds);
  }

  private classifyScore(count: number, openEnds: number): number {
    if (count >= 5) return SCORE.FIVE;
    if (count === 4) {
      if (openEnds >= 2) return SCORE.OPEN_FOUR;
      if (openEnds === 1) return SCORE.CLOSED_FOUR;
      return 0;
    }
    if (count === 3) {
      if (openEnds >= 2) return SCORE.OPEN_THREE;
      if (openEnds === 1) return SCORE.CLOSED_THREE;
      return 0;
    }
    if (count === 2) {
      if (openEnds >= 2) return SCORE.OPEN_TWO;
      if (openEnds === 1) return SCORE.CLOSED_TWO;
      return 0;
    }
    if (count === 1) {
      if (openEnds >= 2) return SCORE.OPEN_ONE;
      return 0;
    }
    return 0;
  }

  private inBounds(r: number, c: number): boolean {
    return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
  }
}

// ─── 渲染调色板（对齐 renderer.js）───────────────────────────────────────────
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
  board: GomokuBoard,
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
      const cell = board.grid[r][c];
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

// ─── React 组件（对齐 main.js 控制器）────────────────────────────────────────
type Mode = 'pvp' | 'ai';
type StatusKind = 'turn' | 'thinking' | 'win-black' | 'win-white' | 'draw';

export default function Gomoku() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const boardRef = useRef<GomokuBoard>(new GomokuBoard());
  const aiRef = useRef<GomokuAI | null>(null);
  const sizingRef = useRef<Sizing>(computeSizing(480));
  const darkRef = useRef<boolean>(false);

  // 运行时棋局状态（命令式，存 ref 以避免绘制耦合 React 渲染）
  const currentPlayerRef = useRef<Player>(BLACK);
  const gameOverRef = useRef<boolean>(false);
  const winningLineRef = useRef<Array<[number, number]> | null>(null);
  const lastMoveRef = useRef<Move | null>(null);
  const isAiThinkingRef = useRef<boolean>(false);
  const modeRef = useRef<Mode>('pvp');

  // DOM 展示态
  const [mode, setMode] = useState<Mode>('pvp');
  const [statusText, setStatusText] = useState<string>('黑方落子');
  const [statusKind, setStatusKind] = useState<StatusKind>('turn');
  const [undoDisabled, setUndoDisabled] = useState<boolean>(true);

  const paletteOf = useCallback((): Palette => (darkRef.current ? DARK : LIGHT), []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawBoard(
      canvas,
      sizingRef.current,
      paletteOf(),
      boardRef.current,
      lastMoveRef.current,
      winningLineRef.current
    );
  }, [paletteOf]);

  const updateStatus = useCallback(() => {
    if (isAiThinkingRef.current) {
      setStatusText('AI 思考中…');
      setStatusKind('thinking');
      return;
    }
    if (gameOverRef.current) {
      const line = winningLineRef.current;
      const last = lastMoveRef.current;
      if (line && line.length > 0 && last) {
        if (last.player === BLACK) {
          setStatusText('黑方获胜！');
          setStatusKind('win-black');
        } else {
          setStatusText('白方获胜！');
          setStatusKind('win-white');
        }
      } else {
        setStatusText('平局！');
        setStatusKind('draw');
      }
      return;
    }
    setStatusText(currentPlayerRef.current === BLACK ? '黑方落子' : '白方落子');
    setStatusKind('turn');
  }, []);

  const refreshUndoDisabled = useCallback(() => {
    setUndoDisabled(
      boardRef.current.getHistory().length === 0 || isAiThinkingRef.current
    );
  }, []);

  const applyView = useCallback(() => {
    render();
    updateStatus();
    refreshUndoDisabled();
  }, [render, updateStatus, refreshUndoDisabled]);

  const placeAndCheck = useCallback(
    (row: number, col: number, player: Player) => {
      boardRef.current.placeStone(row, col, player);
      lastMoveRef.current = { row, col, player };

      const wr = boardRef.current.checkWinAt(row, col, player);
      if (wr.won) {
        gameOverRef.current = true;
        winningLineRef.current = wr.line;
      } else if (boardRef.current.isFull()) {
        gameOverRef.current = true;
        winningLineRef.current = null;
      }
      applyView();
    },
    [applyView]
  );

  const switchTurn = useCallback(() => {
    currentPlayerRef.current = currentPlayerRef.current === BLACK ? WHITE : BLACK;
  }, []);

  const maybeAiMove = useCallback(() => {
    if (modeRef.current !== 'ai') return;
    if (gameOverRef.current) return;
    if (currentPlayerRef.current !== WHITE) return;

    isAiThinkingRef.current = true;
    updateStatus();
    refreshUndoDisabled();

    window.setTimeout(() => {
      const ai = aiRef.current;
      if (!ai) return;

      const move = ai.getBestMove();
      placeAndCheck(move.row, move.col, WHITE);

      isAiThinkingRef.current = false;

      if (!gameOverRef.current) {
        switchTurn();
      }
      applyView();
    }, 30);
  }, [updateStatus, refreshUndoDisabled, placeAndCheck, switchTurn, applyView]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (gameOverRef.current) return;
      if (isAiThinkingRef.current) return;
      if (!boardRef.current.isValidMove(row, col)) return;

      // AI 模式下仅人类（黑）可点
      if (modeRef.current === 'ai' && currentPlayerRef.current !== BLACK) return;

      placeAndCheck(row, col, currentPlayerRef.current);

      if (!gameOverRef.current) {
        switchTurn();
        maybeAiMove();
      }
    },
    [placeAndCheck, switchTurn, maybeAiMove]
  );

  const initGame = useCallback(
    (nextMode: Mode) => {
      boardRef.current.reset();
      currentPlayerRef.current = BLACK;
      gameOverRef.current = false;
      winningLineRef.current = null;
      lastMoveRef.current = null;
      isAiThinkingRef.current = false;
      modeRef.current = nextMode;

      aiRef.current = nextMode === 'ai' ? new GomokuAI(boardRef.current, WHITE) : null;

      applyView();
    },
    [applyView]
  );

  const undoMove = useCallback(() => {
    if (isAiThinkingRef.current) return;
    if (boardRef.current.getHistory().length === 0) return;

    if (modeRef.current === 'ai') {
      // 撤销两步：AI 的 + 人的；人类恒执黑
      boardRef.current.undo();
      boardRef.current.undo();
      currentPlayerRef.current = BLACK;
    } else {
      boardRef.current.undo();
      switchTurn();
    }

    gameOverRef.current = false;
    winningLineRef.current = null;
    lastMoveRef.current = boardRef.current.getLastMove();
    applyView();
  }, [switchTurn, applyView]);

  // 画布点击 → 像素转格
  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
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

      handleCellClick(row, col);
    },
    [handleCellClick]
  );

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
    initGame('pvp');

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
    // 仅挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onModeChange = useCallback(
    (value: Mode) => {
      setMode(value);
      initGame(value);
    },
    [initGame]
  );

  const statusColor: string | undefined =
    statusKind === 'win-black'
      ? 'var(--ink, #333)'
      : statusKind === 'win-white'
        ? 'var(--muted, #888)'
        : undefined;

  return (
    <div className="gomoku-container">
      {/* 模式选择 */}
      <div className="gomoku-mode-selector" role="radiogroup" aria-label="对战模式">
        <label className="gomoku-mode-option">
          <input
            type="radio"
            name="gomoku-mode"
            value="pvp"
            checked={mode === 'pvp'}
            onChange={() => onModeChange('pvp')}
          />
          <span>双人对战</span>
        </label>
        <label className="gomoku-mode-option">
          <input
            type="radio"
            name="gomoku-mode"
            value="ai"
            checked={mode === 'ai'}
            onChange={() => onModeChange('ai')}
          />
          <span>人机对战</span>
        </label>
      </div>

      {/* 状态 */}
      <div className="gomoku-status" style={statusColor ? { color: statusColor } : undefined}>
        {statusText}
      </div>

      {/* 棋盘 */}
      <div className="gomoku-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="gomoku-canvas"
          onClick={onCanvasClick}
          aria-label="五子棋棋盘"
        />
      </div>

      {/* 控制 */}
      <div className="gomoku-controls">
        <button type="button" className="gomoku-btn" onClick={() => initGame(modeRef.current)}>
          新游戏
        </button>
        <button
          type="button"
          className="gomoku-btn"
          onClick={undoMove}
          disabled={undoDisabled}
        >
          悔棋
        </button>
      </div>
    </div>
  );
}

// 自包含样式已迁移至 src/styles-scss/pages/game/_gomoku.scss / 编译产物 flask.css
const _UNUSED_GMK_CSS = `
.gmk { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
.gmk__modes { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.gmk__mode {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .9rem; font-weight: 600;
  cursor: pointer;
}
.gmk__mode input { accent-color: var(--accent, #3f51b5); cursor: pointer; }
.gmk__status {
  font-size: 1.1rem; font-weight: 600; min-height: 1.4em; text-align: center;
  color: var(--ink, #222);
}
.gmk__canvas-wrap {
  width: 100%;
  display: flex; justify-content: center;
  padding: 8px;
  background: var(--surface, #fff);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: var(--r-sm, 8px);
}
.gmk__canvas { display: block; touch-action: manipulation; cursor: pointer; border-radius: 4px; }
.gmk__controls { display: flex; gap: 12px; }
.gmk__btn {
  padding: 8px 20px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .95rem; font-weight: 600;
  cursor: pointer;
}
.gmk__btn:hover:not(:disabled) { background: var(--surface-2, #f5f5f5); }
.gmk__btn:disabled { opacity: .45; cursor: not-allowed; }
`;
