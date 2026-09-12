// ─────────────────────────────────────────────────────────────────────────────
// tictactoe-rules.ts — 井字棋的**纯规则**：棋盘模型与胜负判定。
//
// 【为什么在 lib 而不是组件里】联机对战时客户端不可信（否则 POST 一句「我赢了」
// 就行），胜负必须由服务端判定。抽到这里是为了让前端组件与服务端 API **跑同一份
// 代码路径** —— 若两边各写一份，规则迟早会 drift，而且是静默的那种。
//
// 【零依赖】本模块不得 import prisma / next/headers / 任何 server-only 模块，
// 也不得 import 本文件之外的任何东西 —— 它要同时跑在浏览器与服务端。
//
// 【规则口径 · 改动前必读】
//   • 3×3；X 先手（X=1），O 后手（O=2）。
//   • 胜型是 8 条线（3 行 + 3 列 + 2 对角线）上**恰好三格同色**。
//     3×3 上「恰好三格」与「三格及以上」等价，故这里直接写死整条线 ——
//     与五子棋的 free-style 长连口径无关，别照抄那边的 `>=` 扫描。
//   • X=1 / O=2 的**取值必须与 board-shared.ts 的 FIRST/SECOND 一致**：
//     房间层靠「1 = 先手席（black = 建房者）」这条不变量把 turn 映射到席位。
//     tests/unit/tictactoe-rules.test.ts 有一条钉子盯着这个等式。
// ─────────────────────────────────────────────────────────────────────────────

export const SIZE = 3;
export const EMPTY = 0;
export const X = 1;
export const O = 2;
export type Cell = typeof EMPTY | typeof X | typeof O;
export type Player = typeof X | typeof O;

export type Move = { row: number; col: number; player: Player };

/**
 * 8 条胜型线。程序化生成而不是手写 8 行字面量 —— 手抄一格的坐标错误不会报错，
 * 只会让某条对角线永远判不出胜负（而三格连线在视觉上一目了然，反倒更难怀疑）。
 */
export const WIN_LINES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = (() => {
  const lines: Array<Array<readonly [number, number]>> = [];
  for (let i = 0; i < SIZE; i++) {
    lines.push([
      [i, 0],
      [i, 1],
      [i, 2],
    ]); // 第 i 行
    lines.push([
      [0, i],
      [1, i],
      [2, i],
    ]); // 第 i 列
  }
  lines.push([
    [0, 0],
    [1, 1],
    [2, 2],
  ]); // 主对角线
  lines.push([
    [0, 2],
    [1, 1],
    [2, 0],
  ]); // 副对角线
  return lines;
})();

/** 棋子显示名。席位 → 记号只此一处，免得服务端文案与前端渲染各写一份。 */
export function markOf(player: Player): 'X' | 'O' {
  return player === X ? 'X' : 'O';
}

// ─── 棋盘模型 ────────────────────────────────────────────────────────────────
// 方法签名与 GomokuBoard 对齐（isValidMove / placeStone / checkWinAt / isFull /
// getLastMove / reset）—— 房间层用的是**结构性**接口 RoomBoard，两边因此可以
// 互换。checkWinAt 保留 (row, col, player) 三个参数虽然只有 player 用得上：
// 房间层对所有棋类都按「刚落在哪」调用，签名一致才换得进来。

export class TicTacToeBoard {
  size = SIZE;
  grid: Cell[][];
  moveHistory: Move[];
  moveCount: number;

  constructor() {
    this.grid = [];
    this.moveHistory = [];
    this.moveCount = 0;
    this.reset();
  }

  reset(): void {
    this.grid = [];
    for (let r = 0; r < SIZE; r++) {
      this.grid[r] = new Array<Cell>(SIZE).fill(EMPTY);
    }
    this.moveHistory = [];
    this.moveCount = 0;
  }

  isValidMove(row: number, col: number): boolean {
    return (
      Number.isInteger(row) &&
      Number.isInteger(col) &&
      row >= 0 &&
      row < SIZE &&
      col >= 0 &&
      col < SIZE &&
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

  /** 检查 (row,col) 落子是否补出三连。返回 { won, line }。 */
  checkWinAt(
    row: number,
    col: number,
    player: Player
  ): { won: boolean; line: Array<[number, number]> } {
    for (const line of WIN_LINES) {
      if (!line.some(([r, c]) => r === row && c === col)) continue; // 这一手不在这条线上
      if (line.every(([r, c]) => this.grid[r][c] === player)) {
        return { won: true, line: line.map(([r, c]) => [r, c] as [number, number]) };
      }
    }
    return { won: false, line: [] };
  }

  /** 3×3 下没有平局以外的终局形态：走满 9 手仍无三连即和棋。 */
  isFull(): boolean {
    return this.moveCount >= SIZE * SIZE;
  }

  getLastMove(): Move | null {
    if (this.moveHistory.length === 0) return null;
    return this.moveHistory[this.moveHistory.length - 1];
  }

  getHistory(): Move[] {
    return this.moveHistory.slice();
  }
}
