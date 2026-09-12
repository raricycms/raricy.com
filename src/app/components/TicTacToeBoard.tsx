'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TicTacToeBoard.tsx — 井字棋棋盘（纯渲染）
//
// 【只渲染，不判定】格子内容全部来自服务端下发的 grid（见 lib/board-room.ts）。
// 本组件不知道「谁赢了」，只知道「哪几格被服务端标成了胜线」。
//
// 【为什么是 DOM 不是 canvas】与五子棋相反：3×3 只有九格，<button> 网格白拿键盘
// 可达性、焦点环与无障碍语义，端到端测试也能直接按格点，不必做「像素 → 格」的
// 换算（那层换算正是五子棋 canvas 上「点这儿落在隔壁」的来源）。
// ─────────────────────────────────────────────────────────────────────────────

import { EMPTY, markOf, type Cell, type Move } from '@/lib/tictactoe-rules';

export interface TicTacToeBoardProps {
  grid: Cell[][];
  lastMove: Move | null;
  /** 成三的那条线（服务端给的坐标）；无胜线传 null。 */
  winningLine: Array<[number, number]> | null;
  onCellClick: (row: number, col: number) => void;
  /** 点不动（轮不到你 / 观战 / 断线）。已落的子仍然照常显示。 */
  disabled: boolean;
}

/** 线内坐标是否命中。 */
function inLine(line: Array<[number, number]> | null, row: number, col: number): boolean {
  return !!line?.some(([r, c]) => r === row && c === col);
}

export default function TicTacToeBoard({
  grid,
  lastMove,
  winningLine,
  onCellClick,
  disabled,
}: TicTacToeBoardProps) {
  return (
    <div
      className="tictactoe-board"
      role="grid"
      aria-label="井字棋棋盘"
      // 端到端测试按 data 属性选格子，不靠 nth-child —— 后者会把行优先的顺序
      // 悄悄写死在测试里，改布局就集体失效
      data-size={grid.length}
    >
      {grid.map((row, r) =>
        row.map((cell, c) => {
          // mark 为 null = 空格。判空只此一处：Cell 含 0，markOf 只吃 1|2，
          // 这样 TS 的窄化与运行时语义是同一件事。
          const mark = cell === EMPTY ? null : markOf(cell);
          const isLast = !!lastMove && lastMove.row === r && lastMove.col === c;
          const isWin = inLine(winningLine, r, c);

          const classes = [
            'tictactoe-cell',
            mark ? 'tictactoe-cell--filled' : '',
            mark === 'X' ? 'tictactoe-cell--x' : mark === 'O' ? 'tictactoe-cell--o' : '',
            isLast ? 'tictactoe-cell--last' : '',
            isWin ? 'tictactoe-cell--win' : '',
            disabled ? 'tictactoe-cell--locked' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <button
              key={`${r}-${c}`}
              type="button"
              role="gridcell"
              className={classes}
              data-row={r}
              data-col={c}
              data-mark={mark ?? ''}
              aria-label={`第 ${r + 1} 行第 ${c + 1} 列${mark ? `，${mark}` : '，空'}`}
              // 已落子的格子永远不可点（服务端也会拒），这样 e2e 的点击语义
              // 与真实用户一致：看见 X 的格子点不动
              disabled={disabled || !!mark}
              onClick={() => onCellClick(r, c)}
            >
              {mark ?? ''}
            </button>
          );
        })
      )}
    </div>
  );
}
