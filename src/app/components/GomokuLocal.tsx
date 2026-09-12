'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 五子棋**本地对局**（pvp / 人机）— 从 Flask 侧 app/static/js/game/gomoku/{constants,board,ai,
// renderer,main}.js 忠实移植到 React 客户端组件。
//
// 【规则不在这里】棋盘模型与胜负判定已抽到 @/lib/gomoku-rules —— 联机对战时
// 服务端要用同一份代码判胜负，两边各写一份必然 drift。规则口径（15×15 / 黑先 /
// 四方向 ≥5 连 / 长连也算胜）见那边的文件头。本文件只剩三件事：前端 AI、
// canvas 渲染、本地对局状态机。
//
// 本组件覆盖的玩法：
//   • 双人对战（pvp）或人机对战（ai，人执黑、AI 执白）。
//   • AI：即时制胜/拦截快路 + 深度 4 的 Minimax + Alpha-Beta 剪枝，
//     基于模式（活四/冲四/活三…）的启发式评估，候选宽度 12。
//   • 悔棋：pvp 撤销 1 步；ai 撤销 2 步（AI 的 + 人的）。重新开始。
//
// 棋盘用 <canvas> 绘制（与原实现一致），棋局状态存于 ref，命令式重绘。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLACK,
  BOARD_SIZE,
  DIRECTIONS,
  EMPTY,
  GomokuBoard,
  WHITE,
  type Move,
  type Player,
} from '@/lib/gomoku-rules';
import GomokuCanvas from './GomokuCanvas';

// ─── AI 常量（对齐 ai.js）─────────────────────────────────────────────────────
// 规则常量（BOARD_SIZE / EMPTY / BLACK / WHITE / DIRECTIONS / WIN_LENGTH）与棋盘
// 模型 GomokuBoard 已抽到 @/lib/gomoku-rules —— 服务端判胜负要跑同一份代码。
// 下面这些只服务前端的 AI，服务端永不 import。
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

const MAX_DEPTH = 4;
const CANDIDATE_WIDTH = 12;
const DEFENSE_WEIGHT = 1.05;
const INF = 1e9;

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

// ─── React 组件（对齐 main.js 控制器）────────────────────────────────────────
// 画布（调色板 / DPR / resize / 主题 / 点击换算）全在 GomokuCanvas 里，
// 与联机模式共用。本组件只剩本地对局的 AI 与状态机。
type Mode = 'pvp' | 'ai';
type StatusKind = 'turn' | 'thinking' | 'win-black' | 'win-white' | 'draw';

export default function GomokuLocal() {
  const boardRef = useRef<GomokuBoard>(new GomokuBoard());
  const aiRef = useRef<GomokuAI | null>(null);

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

  // 棋盘是原地改的可变对象，引用不变 —— 靠这个计数器通知 GomokuCanvas 重绘。
  const [viewSeq, setViewSeq] = useState<number>(0);

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
    // 自增而非比较：棋盘被原地改了，引用比不出变化（见 GomokuCanvas 文件头）
    setViewSeq((n) => n + 1);
    updateStatus();
    refreshUndoDisabled();
  }, [updateStatus, refreshUndoDisabled]);

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
        // 【为什么这里要补一次 applyView】placeAndCheck 内部已经刷新过一次状态，
        // 但那是在 switchTurn 之前 —— 读到的还是刚落子那方。AI 模式下 maybeAiMove
        // 会再补一次，pvp 模式下它立刻返回，状态栏就永远停在「刚落子那方」，
        // 回合提示慢一拍（玩家会以为还是对方走）。同一次事件里 setState 会合并，
        // AI 模式随后覆盖成「AI 思考中…」，不会闪。
        applyView();
        maybeAiMove();
      }
    },
    [placeAndCheck, switchTurn, maybeAiMove, applyView]
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

  // 初始化（对齐 main.js）。画布的 resize / 主题 / 点击换算已移交 GomokuCanvas，
  // 这里只剩本地对局自己的初始化。
  useEffect(() => {
    initGame('pvp');
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

  // 胜负文字用主题令牌着色。此前写死 var(--ink, #333) / var(--muted, #888) ——
  // 这两个变量主题体系里并不存在，暗色下「黑方获胜」是深色底上的近黑色。
  const statusColor: string | undefined =
    statusKind === 'win-black'
      ? 'var(--color-text-primary)'
      : statusKind === 'win-white'
        ? 'var(--color-text-secondary)'
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
      <GomokuCanvas
        grid={boardRef.current.grid}
        lastMove={lastMoveRef.current}
        winningLine={winningLineRef.current}
        version={viewSeq}
        onCellClick={handleCellClick}
      />

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
