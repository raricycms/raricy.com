'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChessBoard.tsx — 国际象棋棋盘（纯渲染）
//
// 【只渲染，不判定】格子内容全部来自传进来的 grid（在线时是服务端下发的，单机时是
// 本地棋盘）。本组件不知道「谁赢了」，只知道「哪几格被标成了高亮」。
// 合法落点也由调用方从共享规则模块算好，这里只负责把它们画出来。
//
// 【为什么是 DOM 不是 canvas】与井字棋同理：棋盘只有 64 格，用 <button> 网格白拿
// 键盘可达性、焦点环与无障碍语义，端到端测试也能直接按 data-row/data-col 点，
// 不必做「像素 → 格」的换算（那层换算正是"点这儿落在隔壁"的来源）。
//
// 【不翻转棋盘】白方永远在下方。翻转对「我执黑」更友好，但会让 e2e 的坐标与
// 服务端坐标对不上，排查问题时要在脑子里再翻一次 —— 代价大于收益，故不做。
// ─────────────────────────────────────────────────────────────────────────────

import type { Square } from '@/lib/board-shared';
import {
  BISHOP,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  colorOf,
  glyphOf,
  typeOf,
} from '@/lib/chess-rules';
import type { BoardViewProps } from './board-view';

/** 兵种 → Unicode 棋子字形。比字母好看得多，且不依赖自定义字体。 */
const GLYPH: Record<number, string> = {
  [PAWN]: '♟',
  [KNIGHT]: '♞',
  [BISHOP]: '♝',
  [ROOK]: '♜',
  [QUEEN]: '♛',
  [KING]: '♚',
};

function same(a: Square, b: Square): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export default function ChessBoardView({
  grid,
  lastMove,
  highlight,
  check,
  selection,
  onSquareClick,
  disabled,
}: BoardViewProps) {
  return (
    <div className="chess-board" role="grid" aria-label="国际象棋棋盘" data-size={grid.length}>
      {grid.map((row, r) =>
        row.map((cell, c) => {
          const square: Square = [r, c];
          const glyph = cell === 0 ? null : GLYPH[typeOf(cell)];
          const isWhite = cell !== 0 && colorOf(cell) === WHITE;

          const classes = [
            'chess-square',
            // 深色格 = (row+col)%2===0（a8 是浅色，与国际象棋惯例一致）
            (r + c) % 2 === 0 ? 'chess-square--light' : 'chess-square--dark',
            selection.path.length > 0 && same(selection.path[0], square)
              ? 'chess-square--selected'
              : '',
            selection.path.some((sq) => same(sq, square)) && selection.path.length > 1
              ? 'chess-square--path'
              : '',
            selection.targets.some((sq) => same(sq, square)) ? 'chess-square--target' : '',
            lastMove?.path.some((sq) => same(sq, square)) ? 'chess-square--last' : '',
            highlight.some((sq) => same(sq, square)) ? 'chess-square--win' : '',
            check && same(check, square) ? 'chess-square--check' : '',
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
              // 端到端测试按 data-piece 断言"这一格上是什么"，不必去解析字形。
              // 取值来自规则模块的 glyphOf（大写 = 白），与 FEN 同一口径。
              data-piece={glyphOf(cell)}
              aria-label={`第 ${8 - r} 行第 ${'abcdefgh'[c]} 列${glyph ? `，${glyph}` : '，空'}`}
              disabled={disabled}
              onClick={() => onSquareClick(r, c)}
            >
              {glyph && (
                <span
                  className={`chess-piece${isWhite ? ' chess-piece--white' : ' chess-piece--black'}`}
                  aria-hidden="true"
                >
                  {glyph}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
