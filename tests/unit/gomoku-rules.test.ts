// gomoku-rules.ts —— 五子棋纯规则的单测。
//
// 【这份测试的真正职责】规则从组件搬进 lib，是为了让前端本地对局与服务端联机
// 判定跑同一份代码。因此这里钉的不是「实现细节」，而是**口径**：
//   • 四方向（横 / 竖 / 右下 / 左下）各自都能判出五连，且 line 给出完整格子序列
//     （客户端靠它画获胜连线，错了就是「判赢了但没画线」）
//   • **长连（6 子及以上）也算胜** —— free-style，见 gomoku-rules.ts 文件头。
//     这条最容易被「顺手改成恰好五连」，而改了以后前后端会一起静默变化。
//   • 边界与阻断行为：不能绕行、不能被对方子隔断后仍判胜
//
// 没有 import 任何服务端模块 —— 这个模块要同时跑在浏览器与服务端。

import { describe, it, expect } from 'vitest';
import {
  BLACK,
  BOARD_SIZE,
  EMPTY,
  GomokuBoard,
  WHITE,
  WIN_LENGTH,
} from '@/lib/gomoku-rules';

/** 四个扫描方向；坐标含义与 DIRECTIONS 一致（dr=行增量，dc=列增量）。 */
const SCAN_DIRECTIONS = [
  { name: '横向 →', dr: 0, dc: 1 },
  { name: '纵向 ↓', dr: 1, dc: 0 },
  { name: '右下 ↘', dr: 1, dc: 1 },
  { name: '左下 ↙', dr: 1, dc: -1 },
];

describe('规则口径', () => {
  it('15×15 棋盘，五连获胜', () => {
    expect(BOARD_SIZE).toBe(15);
    expect(WIN_LENGTH).toBe(5);
  });
});

describe('checkWinAt —— 四方向五连', () => {
  for (const { name, dr, dc } of SCAN_DIRECTIONS) {
    it(`${name}：连成 5 子判胜，line 按棋盘顺序给出这 5 格`, () => {
      const board = new GomokuBoard();
      // 左下方向要选一个靠右的起点，否则会走出棋盘
      const startRow = 3;
      const startCol = dc < 0 ? 10 : 3;

      const cells: Array<[number, number]> = [];
      for (let i = 0; i < WIN_LENGTH; i++) {
        cells.push([startRow + dr * i, startCol + dc * i]);
      }
      for (const [r, c] of cells) {
        expect(board.placeStone(r, c, BLACK)).toBe(true);
      }

      const result = board.checkWinAt(startRow, startCol, BLACK);
      expect(result.won).toBe(true);
      expect(result.line).toEqual(cells);
    });
  }

  it('从中点调用时，line 仍按棋盘顺序完整给出五格（反向由 unshift 补齐）', () => {
    const board = new GomokuBoard();
    for (let c = 3; c <= 7; c++) board.placeStone(7, c, BLACK);

    expect(board.checkWinAt(7, 5, BLACK).line).toEqual([
      [7, 3],
      [7, 4],
      [7, 5],
      [7, 6],
      [7, 7],
    ]);
  });

  it('棋盘角落的五连同样判定（不因边界漏判），白方亦然', () => {
    const board = new GomokuBoard();
    for (let i = 0; i < WIN_LENGTH; i++) board.placeStone(10 + i, 10 + i, WHITE);

    const result = board.checkWinAt(14, 14, WHITE);
    expect(result.won).toBe(true);
    expect(result.line).toEqual([
      [10, 10],
      [11, 11],
      [12, 12],
      [13, 13],
      [14, 14],
    ]);
  });
});

describe('checkWinAt —— 不胜的情形', () => {
  it('只连成 4 子不判胜', () => {
    const board = new GomokuBoard();
    for (let c = 3; c < 3 + WIN_LENGTH - 1; c++) board.placeStone(7, c, BLACK);

    expect(board.checkWinAt(7, 3, BLACK).won).toBe(false);
  });

  it('被对方棋子隔断的两段（3+2）不判胜', () => {
    const board = new GomokuBoard();
    for (let c = 3; c <= 5; c++) board.placeStone(7, c, BLACK);
    board.placeStone(7, 6, WHITE);
    for (let c = 7; c <= 8; c++) board.placeStone(7, c, BLACK);

    expect(board.checkWinAt(7, 3, BLACK).won).toBe(false);
  });

  it('只认自己的子：四黑一白排成一行时黑方不胜', () => {
    const board = new GomokuBoard();
    for (let c = 3; c <= 6; c++) board.placeStone(7, c, BLACK);
    board.placeStone(7, 7, WHITE);

    expect(board.checkWinAt(7, 3, BLACK).won).toBe(false);
  });
});

describe('长连（free-style 口径 · 改动前先读 gomoku-rules.ts 文件头）', () => {
  it('连成 6 子也算胜，line 给出全部 6 格', () => {
    const board = new GomokuBoard();
    for (let c = 3; c < 9; c++) board.placeStone(7, c, BLACK);

    const result = board.checkWinAt(7, 3, BLACK);
    expect(result.won).toBe(true);
    expect(result.line).toHaveLength(6);
  });

  it('横向 7 子、纵向 6 子同样判胜', () => {
    const row = new GomokuBoard();
    for (let c = 3; c < 10; c++) row.placeStone(7, c, WHITE);
    expect(row.checkWinAt(7, 3, WHITE).won).toBe(true);

    const col = new GomokuBoard();
    for (let r = 3; r < 9; r++) col.placeStone(r, 7, WHITE);
    expect(col.checkWinAt(3, 7, WHITE).won).toBe(true);
  });
});

describe('isValidMove / placeStone', () => {
  it('空位可落；越界（含负数）与已占位不可', () => {
    const board = new GomokuBoard();

    expect(board.isValidMove(0, 0)).toBe(true);
    expect(board.isValidMove(BOARD_SIZE - 1, BOARD_SIZE - 1)).toBe(true);

    expect(board.isValidMove(-1, 0)).toBe(false);
    expect(board.isValidMove(0, -1)).toBe(false);
    expect(board.isValidMove(BOARD_SIZE, 0)).toBe(false);
    expect(board.isValidMove(0, BOARD_SIZE)).toBe(false);

    board.placeStone(7, 7, BLACK);
    expect(board.isValidMove(7, 7)).toBe(false);
  });

  it('placeStone 在非法位置返回 false，且不改动任何状态', () => {
    const board = new GomokuBoard();
    board.placeStone(7, 7, BLACK);
    const snapshot = JSON.stringify(board.grid);

    expect(board.placeStone(7, 7, WHITE)).toBe(false); // 已占位
    expect(board.placeStone(-1, 0, WHITE)).toBe(false); // 越界
    expect(board.placeStone(BOARD_SIZE, 0, WHITE)).toBe(false);

    expect(JSON.stringify(board.grid)).toBe(snapshot);
    expect(board.moveCount).toBe(1);
    expect(board.getHistory()).toHaveLength(1);
  });
});

describe('悔棋与历史', () => {
  it('undo 恢复该格为空，moveCount 与历史同步递减；空盘 undo 返回 null', () => {
    const board = new GomokuBoard();
    expect(board.undo()).toBeNull();

    board.placeStone(7, 7, BLACK);
    board.placeStone(7, 8, WHITE);

    expect(board.undo()).toEqual({ row: 7, col: 8, player: WHITE });
    expect(board.grid[7][8]).toBe(EMPTY);
    expect(board.moveCount).toBe(1);
    expect(board.getHistory()).toEqual([{ row: 7, col: 7, player: BLACK }]);
  });

  it('悔棋后重新落子，胜负判定与按历史重放一致', () => {
    const board = new GomokuBoard();
    for (let c = 3; c <= 6; c++) board.placeStone(7, c, BLACK); // 4 子，尚未胜
    expect(board.checkWinAt(7, 3, BLACK).won).toBe(false);

    board.undo(); // 退回 3 子
    board.placeStone(7, 6, BLACK); // 换个位置补齐第 4 子
    expect(board.checkWinAt(7, 3, BLACK).won).toBe(false);

    board.placeStone(7, 7, BLACK); // 第 5 子
    expect(board.checkWinAt(7, 3, BLACK).won).toBe(true);
  });

  it('getHistory 返回副本，外部改动不会污染棋局', () => {
    const board = new GomokuBoard();
    board.placeStone(7, 7, BLACK);

    board.getHistory().push({ row: 0, col: 0, player: WHITE });

    expect(board.getHistory()).toHaveLength(1);
    expect(board.isValidMove(0, 0)).toBe(true);
  });

  it('getLastMove 返回最后一手；reset 清空棋盘与历史', () => {
    const board = new GomokuBoard();
    expect(board.getLastMove()).toBeNull();

    board.placeStone(7, 7, BLACK);
    board.placeStone(8, 8, WHITE);
    expect(board.getLastMove()).toEqual({ row: 8, col: 8, player: WHITE });

    board.reset();
    expect(board.getLastMove()).toBeNull();
    expect(board.moveCount).toBe(0);
    expect(board.grid[8][8]).toBe(EMPTY);
  });
});

describe('isFull / 自定义棋盘尺寸', () => {
  it('未满时为假，落满 size² 后为真', () => {
    const board = new GomokuBoard(2);
    expect(board.isFull()).toBe(false);

    board.placeStone(0, 0, BLACK);
    board.placeStone(0, 1, WHITE);
    board.placeStone(1, 0, BLACK);
    expect(board.isFull()).toBe(false);

    board.placeStone(1, 1, WHITE);
    expect(board.isFull()).toBe(true);
  });

  it('reset 后 isFull 回到假', () => {
    const board = new GomokuBoard(2);
    for (const [r, c] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      board.placeStone(r, c, BLACK);
    }
    expect(board.isFull()).toBe(true);

    board.reset();
    expect(board.isFull()).toBe(false);
  });
});
