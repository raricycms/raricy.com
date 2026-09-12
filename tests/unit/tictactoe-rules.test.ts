// tictactoe-rules.ts —— 井字棋的棋盘与胜负判定（前端与服务端共用的那一份）
//
// 【为什么测这些】这份规则同时跑在浏览器与服务端：写错的后果是「两边一起错」，
// 而错法全是静默的 —— 少一条胜型线只会让某种赢法判不出来（玩家看得见输赢，
// 服务端却宣布继续走），而不是报错。所以 8 条线要一条一条钉住。

import { describe, it, expect } from 'vitest';
import { EMPTY, FIRST, SECOND } from '@/lib/board-shared';
import {
  EMPTY as TT_EMPTY,
  O,
  SIZE,
  TicTacToeBoard,
  WIN_LINES,
  X,
  markOf,
  type Player,
} from '@/lib/tictactoe-rules';

/** 按顺序落子，落不动就抛 —— 用例里写错坐标会立刻暴露，而不是静默少走一步。 */
function play(board: TicTacToeBoard, moves: Array<[number, number, Player]>): void {
  for (const [r, c, p] of moves) {
    if (!board.placeStone(r, c, p)) throw new Error(`落子失败：(${r},${c})`);
  }
}

describe('格子取值口径', () => {
  it('井字棋的取值必须与房间层的 FIRST/SECOND 同值（房间靠它把 turn 映射到席位）', () => {
    expect(TT_EMPTY).toBe(EMPTY);
    expect(X).toBe(FIRST);
    expect(O).toBe(SECOND);
  });

  it('markOf：先手是 X，后手是 O', () => {
    expect(markOf(X)).toBe('X');
    expect(markOf(O)).toBe('O');
  });
});

describe('棋盘', () => {
  it('新盘是 3×3 全空、手数为 0、无最后一手', () => {
    const b = new TicTacToeBoard();
    expect(b.size).toBe(SIZE);
    expect(b.grid).toHaveLength(3);
    expect(b.grid.every((row) => row.length === 3 && row.every((c) => c === EMPTY))).toBe(true);
    expect(b.moveCount).toBe(0);
    expect(b.getLastMove()).toBeNull();
    expect(b.isFull()).toBe(false);
  });

  it('落子写进 grid 与历史；占位/越界/非整数一律拒绝', () => {
    const b = new TicTacToeBoard();
    expect(b.placeStone(1, 1, X)).toBe(true);
    expect(b.grid[1][1]).toBe(X);
    expect(b.getLastMove()).toEqual({ row: 1, col: 1, player: X });
    expect(b.getHistory()).toHaveLength(1);

    expect(b.placeStone(1, 1, O)).toBe(false); // 已占
    expect(b.placeStone(-1, 0, O)).toBe(false);
    expect(b.placeStone(0, 3, O)).toBe(false);
    expect(b.placeStone(1.5, 0, O)).toBe(false);
    expect(b.placeStone(0, NaN, O)).toBe(false);
    expect(b.moveCount).toBe(1); // 失败的落子不计数
  });

  it('reset 清空棋盘与历史', () => {
    const b = new TicTacToeBoard();
    play(b, [
      [0, 0, X],
      [1, 1, O],
    ]);
    b.reset();
    expect(b.moveCount).toBe(0);
    expect(b.grid[0][0]).toBe(EMPTY);
    expect(b.getHistory()).toHaveLength(0);
  });

  it('走满 9 手 isFull 为真', () => {
    const b = new TicTacToeBoard();
    play(b, [
      [0, 0, X],
      [0, 1, O],
      [0, 2, X],
      [1, 0, O],
      [1, 1, X],
      [1, 2, O],
      [2, 0, O],
      [2, 1, X],
      [2, 2, X],
    ]);
    expect(b.isFull()).toBe(true);
  });
});

describe('胜负：8 条线一条都不能漏', () => {
  it('胜型线恰好 8 条，且每条 3 格、不重复', () => {
    expect(WIN_LINES).toHaveLength(8);
    for (const line of WIN_LINES) {
      expect(line).toHaveLength(3);
      expect(new Set(line.map(([r, c]) => `${r},${c}`)).size).toBe(3);
    }
    // 8 条互不相同：3 行 + 3 列 + 2 对角线
    expect(new Set(WIN_LINES.map((l) => l.map(([r, c]) => `${r}${c}`).join(''))).size).toBe(8);
  });

  it.each(WIN_LINES.map((line) => [line.map(([r, c]) => `${r},${c}`).join(' '), line]))(
    '线 %s 能判出胜负，且回的就是这条线',
    (_label, line) => {
      const b = new TicTacToeBoard();
      const cells = line as ReadonlyArray<readonly [number, number]>;

      // 前两格不判胜；第三格补上才判胜 —— 顺带证明判定锚在「刚落的这一手」上
      expect(b.placeStone(cells[0][0], cells[0][1], X)).toBe(true);
      expect(b.checkWinAt(cells[0][0], cells[0][1], X).won).toBe(false);
      expect(b.placeStone(cells[1][0], cells[1][1], X)).toBe(true);
      expect(b.checkWinAt(cells[1][0], cells[1][1], X).won).toBe(false);
      expect(b.placeStone(cells[2][0], cells[2][1], X)).toBe(true);

      const res = b.checkWinAt(cells[2][0], cells[2][1], X);
      expect(res.won).toBe(true);
      expect(res.line.map(([r, c]) => `${r},${c}`).sort()).toEqual(
        cells.map(([r, c]) => `${r},${c}`).sort()
      );
    }
  );

  it('后手（O）同样能判胜 —— 判定不写死先手', () => {
    const b = new TicTacToeBoard();
    play(b, [
      [0, 0, X],
      [1, 0, O],
      [0, 1, X],
      [1, 1, O],
      [2, 2, X],
      [1, 2, O],
    ]);
    const res = b.checkWinAt(1, 2, O);
    expect(res.won).toBe(true);
    expect(res.line).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
  });

  it('敌方三格连成一线不算我方赢（按 player 判，不按格子数）', () => {
    const b = new TicTacToeBoard();
    play(b, [
      [0, 0, X],
      [1, 0, O],
      [0, 1, X],
      [1, 1, O],
      [2, 2, X],
      [1, 2, O],
    ]);
    expect(b.checkWinAt(1, 2, X).won).toBe(false); // 那条线上是 O
  });

  it('满盘无三连 → 判和（不设 winner）', () => {
    const b = new TicTacToeBoard();
    play(b, [
      [0, 0, X],
      [0, 1, O],
      [0, 2, X],
      [1, 1, O],
      [1, 0, X],
      [1, 2, O],
      [2, 1, X],
      [2, 0, O],
      [2, 2, X],
    ]);
    expect(b.isFull()).toBe(true);
    // 中局与终局都不该有胜者
    for (const [r, c] of [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ]) {
      expect(b.checkWinAt(r, c, b.grid[r][c] as Player).won).toBe(false);
    }
  });
});
