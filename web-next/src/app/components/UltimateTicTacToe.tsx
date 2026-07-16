'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 超级井字棋（Ultimate Tic-Tac-Toe）— 从 Flask 侧 app/static/js/game/utictactoe.js
// 忠实移植到 React 客户端组件。纯前端逻辑，无服务端依赖。
//
// 规则要点（与原实现一一对应）：
//   • 9 个小棋盘组成大棋盘；先手 X。
//   • 你落子的格子位置，决定对手下一步必须落在对应的小棋盘。
//   • 若被指定的小棋盘已分出胜负/占满，则对手可自由选择任意可下小棋盘。
//   • 小棋盘三连获胜后其结果记入大棋盘；大棋盘三连即整局获胜。
//   • 支持悔棋（历史栈）与重新开始。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useState } from 'react';

type Mark = 'X' | 'O' | 'T' | '';

const WINNING_CONDITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

type GameState = {
  currentPlayer: 'X' | 'O';
  gameActive: boolean;
  nextBoardIndex: number | null;
  miniBoardStates: Mark[][]; // 9 x 9
  superBoardState: Mark[]; // 9
};

function makeInitialState(): GameState {
  return {
    currentPlayer: 'X',
    gameActive: true,
    nextBoardIndex: null,
    miniBoardStates: Array.from({ length: 9 }, () => Array<Mark>(9).fill('')),
    superBoardState: Array<Mark>(9).fill(''),
  };
}

/** 对齐 checkWinner：返回 'X'/'O' 胜方，'T' 平局（占满无连线），null 未结束。 */
function checkWinner(board: Mark[]): Mark | null {
  for (const [a, b, c] of WINNING_CONDITIONS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c] && board[a] !== 'T') {
      return board[a];
    }
  }
  return board.includes('') ? null : 'T';
}

function cloneState(s: GameState): GameState {
  return {
    currentPlayer: s.currentPlayer,
    gameActive: s.gameActive,
    nextBoardIndex: s.nextBoardIndex,
    miniBoardStates: s.miniBoardStates.map((row) => row.slice()),
    superBoardState: s.superBoardState.slice(),
  };
}

export default function UltimateTicTacToe() {
  const [state, setState] = useState<GameState>(makeInitialState);
  const [history, setHistory] = useState<GameState[]>([]);

  const superWinner = useMemo(() => checkWinner(state.superBoardState), [state.superBoardState]);
  const boardFull = state.superBoardState.every((s) => s !== '');

  const status = useMemo(() => {
    if (superWinner) {
      if (superWinner === 'T') return { text: '平局！', color: '#757575' };
      return {
        text: `玩家 ${superWinner} 获胜！`,
        color: superWinner === 'X' ? '#d32f2f' : '#1976d2',
      };
    }
    if (boardFull) return { text: '平局！', color: '#757575' };
    return {
      text: `当前玩家: ${state.currentPlayer}${state.nextBoardIndex === null ? ' (自由选择)' : ''}`,
      color: '#3f51b5',
    };
  }, [superWinner, boardFull, state.currentPlayer, state.nextBoardIndex]);

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      setState((prev) => {
        if (!prev.gameActive) return prev;

        // 拒绝：格子已占用 / 该小棋盘已分胜负 / 被指定其它小棋盘时落错棋盘
        if (
          prev.miniBoardStates[boardIndex][cellIndex] !== '' ||
          prev.superBoardState[boardIndex] !== '' ||
          (prev.nextBoardIndex !== null && boardIndex !== prev.nextBoardIndex)
        ) {
          return prev;
        }

        // 入栈用于悔棋（保存落子前的快照）
        setHistory((h) => [...h, cloneState(prev)]);

        const next = cloneState(prev);
        next.miniBoardStates[boardIndex][cellIndex] = prev.currentPlayer;

        const miniWinner = checkWinner(next.miniBoardStates[boardIndex]);
        if (miniWinner && next.superBoardState[boardIndex] === '') {
          next.superBoardState[boardIndex] = miniWinner;
          if (checkWinner(next.superBoardState)) {
            next.gameActive = false;
          }
        }

        // 所有小棋盘均已完成 → 大棋盘平局
        if (next.gameActive && next.superBoardState.every((s) => s !== '')) {
          next.gameActive = false;
        }

        next.currentPlayer = prev.currentPlayer === 'X' ? 'O' : 'X';

        // 指定下一个小棋盘；若指向已完成的小棋盘则自由选择
        next.nextBoardIndex = next.superBoardState[cellIndex] !== '' ? null : cellIndex;

        return next;
      });
    },
    []
  );

  const undoMove = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const last = h[h.length - 1];
      setState(cloneState(last));
      return h.slice(0, -1);
    });
  }, []);

  const restart = useCallback(() => {
    setState(makeInitialState());
    setHistory([]);
  }, []);

  // 高亮：自由选择时，所有未完成小棋盘可下；否则仅高亮被指定的小棋盘
  const freePlay = state.gameActive && state.nextBoardIndex === null;

  return (
    <div className="uttt">
      <style>{UTTT_CSS}</style>

      <div className="uttt__status" style={{ color: status.color }}>
        {status.text}
      </div>

      <div className={`uttt__board${freePlay ? ' uttt__board--free' : ''}`}>
        {state.superBoardState.map((superCell, i) => {
          const won = superCell === 'X' || superCell === 'O';
          const tied = superCell === 'T';
          const active = state.gameActive && !freePlay && state.nextBoardIndex === i;
          const playable = freePlay && superCell === '';
          const cls = [
            'uttt__mini',
            won ? 'uttt__mini--won' : '',
            won ? (superCell === 'X' ? 'uttt__mini--won-x' : 'uttt__mini--won-o') : '',
            tied ? 'uttt__mini--tied' : '',
            active ? 'uttt__mini--active' : '',
            playable ? 'uttt__mini--playable' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div key={i} className={cls} data-winner={won ? superCell : undefined}>
              {state.miniBoardStates[i].map((mark, j) => (
                <button
                  key={j}
                  type="button"
                  className={`uttt__cell${
                    mark === 'X' ? ' uttt__cell--x' : mark === 'O' ? ' uttt__cell--o' : ''
                  }`}
                  onClick={() => handleCellClick(i, j)}
                  aria-label={`小棋盘 ${i + 1} 格 ${j + 1}`}
                >
                  {mark === 'X' || mark === 'O' ? mark : ''}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="uttt__controls">
        <button type="button" className="uttt__btn" onClick={restart}>
          重新开始
        </button>
        <button
          type="button"
          className="uttt__btn"
          onClick={undoMove}
          disabled={history.length === 0 || !state.gameActive}
        >
          悔棋
        </button>
      </div>
    </div>
  );
}

// 自包含样式（作用域前缀 uttt__，不依赖设计系统之外的类；颜色沿用设计令牌 + X 红/O 蓝）
const UTTT_CSS = `
.uttt { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.uttt__status { font-size: 1.1rem; font-weight: 600; min-height: 1.4em; text-align: center; }
.uttt__board {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: min(90vw, 480px);
  aspect-ratio: 1 / 1;
  padding: 8px;
  background: var(--line-2, #d0d0d0);
  border-radius: var(--r-sm, 8px);
}
.uttt__mini {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px;
  padding: 4px;
  background: var(--surface, #fff);
  border-radius: 6px;
  position: relative;
  transition: box-shadow .15s ease, outline .15s ease;
}
.uttt__mini--playable { outline: 2px solid var(--accent, #3f51b5); outline-offset: 1px; }
.uttt__mini--active { outline: 3px solid var(--accent, #3f51b5); outline-offset: 1px; box-shadow: 0 0 0 4px rgba(63,81,181,.18); }
.uttt__mini--won::after,
.uttt__mini--tied::after {
  content: attr(data-winner);
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: clamp(2rem, 12vw, 4rem); font-weight: 800;
  border-radius: 6px;
  pointer-events: none;
}
.uttt__mini--won-x::after { content: 'X'; color: #d32f2f; background: rgba(211,47,47,.12); }
.uttt__mini--won-o::after { content: 'O'; color: #1976d2; background: rgba(25,118,210,.12); }
.uttt__mini--tied::after { content: '—'; color: #757575; background: rgba(117,117,117,.12); }
.uttt__cell {
  aspect-ratio: 1 / 1;
  border: 1px solid var(--line, #e0e0e0);
  border-radius: 4px;
  background: var(--surface-2, #fafafa);
  color: var(--ink, #222);
  font-size: clamp(.9rem, 4vw, 1.4rem);
  font-weight: 700;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0; line-height: 1;
  transition: background .12s ease;
}
.uttt__cell:hover:not(:disabled) { background: var(--line, #eee); }
.uttt__cell--x { color: #d32f2f; }
.uttt__cell--o { color: #1976d2; }
.uttt__controls { display: flex; gap: 12px; }
.uttt__btn {
  padding: 8px 20px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .95rem; font-weight: 600;
  cursor: pointer;
}
.uttt__btn:hover:not(:disabled) { background: var(--surface-2, #f5f5f5); }
.uttt__btn:disabled { opacity: .45; cursor: not-allowed; }
`;
