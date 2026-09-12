'use client';

// ─────────────────────────────────────────────────────────────────────────────
// XiangqiBoard.tsx — 中国象棋棋盘（纯渲染）
//
// 【与另外两款棋盘最大的不同：棋子落在**交叉点**上】不是格子里。所以这里的每一格
// 按钮代表的是"一个交叉点"，而棋盘线用一层 SVG 画在按钮下面（见下面的 <BoardLines />）。
// 容器按 9 列 × 10 行的格子排布，交叉点 (r,c) 落在格子 (r,c) 的**中心** ——
// SVG 用 viewBox="0 0 9 10" 铺满容器，于是同一个坐标在两边天然对齐，
// 不必手调任何偏移量。
//
// 【河界】竖线在第 4 与第 5 横线之间断开（只有最外两条竖线通到底），中间写上
// 「楚河」「漢界」。这是象棋棋盘最好认的特征，画错了远处一眼就能看出来。
//
// 【只渲染，不判定】合法落点由调用方从共享规则模块算好（含蹩马腿、塞象眼、飞将
// 这些），本组件不知道「谁赢了」。
// ─────────────────────────────────────────────────────────────────────────────

import type { Square } from '@/lib/board-shared';
import { BLACK, COLS, KING, ROWS, colorOf, glyphOf, typeOf } from '@/lib/xiangqi-rules';
import type { BoardViewProps } from './board-view';

function same(a: Square, b: Square): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** 棋盘线。坐标单位 = 一个格子，交叉点 (r,c) 在 (c+0.5, r+0.5)。 */
function BoardLines() {
  const rows = Array.from({ length: ROWS }, (_, r) => r);
  const cols = Array.from({ length: COLS }, (_, c) => c);

  return (
    <svg
      className="xiangqi-lines"
      viewBox={`0 0 ${COLS} ${ROWS}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* 横线：10 条，通到底 */}
      {rows.map((r) => (
        <line key={`h${r}`} x1={0.5} y1={r + 0.5} x2={COLS - 0.5} y2={r + 0.5} />
      ))}
      {/* 竖线：最外两条通到底，中间七条在河界处断开 */}
      {cols.map((c) =>
        c === 0 || c === COLS - 1 ? (
          <line key={`v${c}`} x1={c + 0.5} y1={0.5} x2={c + 0.5} y2={ROWS - 0.5} />
        ) : (
          <g key={`v${c}`}>
            <line x1={c + 0.5} y1={0.5} x2={c + 0.5} y2={4.5} />
            <line x1={c + 0.5} y1={5.5} x2={c + 0.5} y2={ROWS - 0.5} />
          </g>
        )
      )}
      {/* 九宫斜线：黑方（上）与红方（下）各一个米字 */}
      <line x1={3.5} y1={0.5} x2={5.5} y2={2.5} />
      <line x1={5.5} y1={0.5} x2={3.5} y2={2.5} />
      <line x1={3.5} y1={7.5} x2={5.5} y2={9.5} />
      <line x1={5.5} y1={7.5} x2={3.5} y2={9.5} />
    </svg>
  );
}

export default function XiangqiBoardView({
  grid,
  lastMove,
  highlight,
  check,
  selection,
  onSquareClick,
  disabled,
}: BoardViewProps) {
  return (
    <div className="xiangqi-board" role="grid" aria-label="中国象棋棋盘" data-size={grid.length}>
      <BoardLines />
      {/* 河界文字：写在两条河沿线之间的空白里 */}
      <span className="xiangqi-river xiangqi-river--left" aria-hidden="true">
        楚河
      </span>
      <span className="xiangqi-river xiangqi-river--right" aria-hidden="true">
        漢界
      </span>

      <div className="xiangqi-points">
        {grid.map((row, r) =>
          row.map((cell, c) => {
            const square: Square = [r, c];
            const isBlackPiece = cell !== 0 && colorOf(cell) === BLACK;
            const inCheck = !!check && same(check, square);

            const classes = [
              'xiangqi-point',
              selection.path.length > 0 && same(selection.path[0], square)
                ? 'xiangqi-point--selected'
                : '',
              selection.path.length > 1 && selection.path.some((sq) => same(sq, square))
                ? 'xiangqi-point--path'
                : '',
              selection.targets.some((sq) => same(sq, square)) ? 'xiangqi-point--target' : '',
              lastMove?.path.some((sq) => same(sq, square)) ? 'xiangqi-point--last' : '',
              highlight.some((sq) => same(sq, square)) ? 'xiangqi-point--win' : '',
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
                // 端到端测试按 data-piece 断言"这一点上是什么"
                data-piece={glyphOf(cell)}
                aria-label={`第 ${9 - r} 路第 ${c + 1} 线${cell ? `，${glyphOf(cell)}` : '，空'}`}
                disabled={disabled}
                onClick={() => onSquareClick(r, c)}
              >
                {cell !== 0 && (
                  <span
                    className={`xiangqi-piece${isBlackPiece ? ' xiangqi-piece--black' : ' xiangqi-piece--red'}${
                      typeOf(cell) === KING ? ' xiangqi-piece--king' : ''
                    }${inCheck ? ' xiangqi-piece--check' : ''}`}
                    aria-hidden="true"
                  >
                    {glyphOf(cell)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
