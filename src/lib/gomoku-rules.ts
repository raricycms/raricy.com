// ─────────────────────────────────────────────────────────────────────────────
// gomoku-rules.ts — 五子棋的**纯规则**：棋盘模型与胜负判定。
//
// 【为什么在 lib 而不是组件里】联机对战时客户端不可信（否则 POST 一句「我赢了」
// 就行），胜负必须由服务端判定。抽到这里是为了让前端组件与服务端 API **跑同一份
// 代码路径** —— 若两边各写一份，规则迟早会 drift，而且是静默的那种。
// 原实现是 Flask 侧 app/static/js/game/gomoku/{constants,board}.js。
//
// 【零依赖】本模块不得 import prisma / next/headers / 任何 server-only 模块，
// 也不得 import 本文件之外的任何东西 —— 它要同时跑在浏览器与服务端。
// AI（minimax，只在前端）**不在**这里，见 components/Gomoku.tsx。
//
// 【规则口径 · 改动前必读】
//   • 15×15；黑先（BLACK=1），白后（WHITE=2）。
//   • 四方向扫描（右 / 下 / 右下 / 左下），任一方向连成 ≥5 子即获胜。
//   • **长连（6 子及以上）也算胜** —— checkWinAt 用的是 `line.length >= WIN_LENGTH`，
//     即 free-style 口径，与 Flask 版一致。别「顺手」改成恰好五连：那会同时改变
//     前端本地对局与服务端判定的行为，且两侧一起静默变化。
// ─────────────────────────────────────────────────────────────────────────────

export const BOARD_SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export type Cell = typeof EMPTY | typeof BLACK | typeof WHITE;
export type Player = typeof BLACK | typeof WHITE;

/** 方向向量：右、下、右下、左下 */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export const WIN_LENGTH = 5;

export type Move = { row: number; col: number; player: Player };

// ─── 棋盘模型（对齐 board.js）─────────────────────────────────────────────────
export class GomokuBoard {
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

// ─── 房间层 DTO ↔ 本模块口径 的收窄 ─────────────────────────────────────────
// 【为什么必须有这一步】房间层的 `grid` 是 `number[][]`（它对所有棋一视同仁，
// 不解释格子里放的是什么，见 board-shared.ts），而本模块的 `Cell` 只有 0/1/2。
// TS 不会把 `number` 收回成 `0|1|2`，**更不能靠 as 硬转** —— GomokuCanvas 的绘制
// 是 `cell === BLACK ? 黑子 : 白子`，一个野生数字会被静默画成白棋。
// 所以在这里显式收窄：不认识的取值一律当空格，宁可少画一个子，也不凭空多一个。
//
// 放在本模块（而不是各组件里）是因为**编码是本模块定的** —— 换编码时这里跟着改，
// 不必去找散落各处的转换。参数用结构化的 `path` 形状而不是 import board-shared 的
// 类型：本模块零依赖，不得引入任何 import。

/** 把房间层下发的棋盘收窄成五子棋的 `0|1|2` 棋盘；不认识的取值当空格。 */
export function asGomokuGrid(grid: number[][]): Cell[][] {
  return grid.map((row) => row.map((c) => (c === BLACK || c === WHITE ? c : EMPTY)));
}

/** 把房间层的 lastMove 收窄成五子棋的 `{row,col,player}`；空路径返回 null。 */
export function asGomokuMove(move: {
  path: Array<[number, number]>;
  player: Player;
} | null): Move | null {
  if (!move || move.path.length === 0) return null;
  const [row, col] = move.path[move.path.length - 1];
  return { row, col, player: move.player };
}
