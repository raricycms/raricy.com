'use client';

// ─────────────────────────────────────────────────────────────────────────────
// DraughtsBoard.tsx — 国际跳棋棋盘（纯渲染）
//
// 【只渲染，不判定】格子内容来自传进来的 grid；合法落点由调用方从共享规则模块
// 算好。本组件不知道「谁赢了」。
//
// 【只有深色格能点】`(row+col)%2===1` 的格子才是棋盘的格 —— 另外 50 格永远空着。
// 浅色格渲染成不可交互的 <div>，不是 disabled 的 <button>：它们根本不是棋盘的一部分，
// 让它们出现在 tab 顺序里会变成 50 个"点不动的按钮"。
//
// 【连吃是逐跳点的】点一下自己的子、再依次点每个落点，最后一步落下整条路径。
// 这由 useMoveSelection 按"路径前缀"推进实现（见那边的文件头）—— 一个终点对应
// 多条吃法时，逐跳点才能表达走的是哪一条。
// ─────────────────────────────────────────────────────────────────────────────

import type { Square } from '@/lib/board-shared';
import { KING, WHITE, colorOf, glyphOf, isDark, typeOf } from '@/lib/draughts-rules';
import type { BoardViewProps } from './board-view';

function same(a: Square, b: Square): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export default function DraughtsBoardView({
  grid,
  lastMove,
  highlight,
  // 跳棋没有"将军"这个概念，这个字段恒为 null —— 保留它是为了让三款棋的棋盘组件
  // 共用同一个 BoardViewProps，单机壳才能只写一份。
  check: _check,
  selection,
  onSquareClick,
  disabled,
}: BoardViewProps) {
  return (
    <div className="draughts-board" role="grid" aria-label="国际跳棋棋盘" data-size={grid.length}>
      {grid.map((row, r) =>
        row.map((cell, c) => {
          const dark = isDark(r, c);
          if (!dark) {
            // 浅色格：棋盘上不存在的位置，纯粹是视觉背景
            return <div key={`${r}-${c}`} className="draughts-square draughts-square--light" />;
          }

          const square: Square = [r, c];
          const isKing = cell !== 0 && typeOf(cell) === KING;

          const classes = [
            'draughts-square',
            'draughts-square--dark',
            selection.path.length > 0 && same(selection.path[0], square)
              ? 'draughts-square--selected'
              : '',
            selection.path.length > 1 && selection.path.some((sq) => same(sq, square))
              ? 'draughts-square--path'
              : '',
            selection.targets.some((sq) => same(sq, square)) ? 'draughts-square--target' : '',
            lastMove?.path.some((sq) => same(sq, square)) ? 'draughts-square--last' : '',
            highlight.some((sq) => same(sq, square)) ? 'draughts-square--win' : '',
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
              // 端到端测试按 data-piece 断言"这一格上是什么"
              data-piece={glyphOf(cell)}
              aria-label={`第 ${r + 1} 行第 ${c + 1} 列${cell ? `，${colorOf(cell) === WHITE ? '白' : '黑'}${isKing ? '王' : '兵'}` : '，空'}`}
              disabled={disabled}
              onClick={() => onSquareClick(r, c)}
            >
              {cell !== 0 && (
                <span
                  className={`draughts-piece${
                    colorOf(cell) === WHITE ? ' draughts-piece--white' : ' draughts-piece--black'
                  }${isKing ? ' draughts-piece--king' : ''}`}
                  aria-hidden="true"
                >
                  {/* 王画一个王冠记号 —— 只靠颜色深浅区分不出兵与王 */}
                  {isKing && <span className="draughts-piece__crown">♛</span>}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
