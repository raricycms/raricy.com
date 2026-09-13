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
//   • **先手（黑棋）禁手**：三三 / 四四 / 长连（≥6 连）是**禁手点**，黑棋走不上去。
//     白棋没有禁手，长连照样算胜。
//   • 禁手是**拒绝落子**口径，不是 Renju 的「判负」：`forbiddenKind` 在落子**之前**
//     问，返回非 null 就拒绝这一手，棋盘一格不动。所以棋盘上永远不会出现黑棋的
//     长连或四四 —— 这正是 `checkWinAt` 的 `>= WIN_LENGTH` 不需要按颜色分岔的原因。
//   • 五连优先于一切禁手：一手若在某个方向恰好成五，那就是胜，即使同时在别处形成
//     禁手形状。而长连不是五连，是禁手。
//
// 【口径是 2026-09 从 free-style 改过来的 —— 下面是为什么改、以及改完到底有没有用】
// 改之前是自由五子棋（长连也算胜），先手优势大到棋力根本显不出来：同引擎自对弈
// **黑 100% 全胜**（把黑第一手扔到 (2,2)、白占天元，黑照样 100%）。
//
// 加禁手之后用同一套工具（`scripts/gomoku-selfplay.ts`，30 开局 × 两色 = 60 局、
// 按开局配对）实测：
//   • 同档镜像自对弈（简单档 200ms 对 200ms）：**黑方 60.0%**（36:24）。
//     先手优势确实被削下来了 —— 这是加禁手**兑现了**的那部分。
//   • 「简单@200ms vs 普通@1s」的档位得分率：**15.0% → 13.3%**
//     （95% CI 6.0~24.0 与 4.7~21.9，完全重叠；配对分布 0/9/21 与 0/8/22）。
//     也就是**档位差没有变大** —— 这是加禁手**没有兑现**的那部分。
//
// 所以「先手优势小了，档位差距就会显出来」这个假设**不成立**，别照着它做后续
// 决策。原因：简单与普通之间差的是「看不看得见双威胁与 VCF」这类**定性**能力，
// 那一步本来就已经接近天花板（85% 上下），先手优势被削掉也挤不出更多空间。
// **能做出台阶的是「多了某种看不见的能力」，不是「同一套东西多算一会儿」** ——
// 这条在 `gomoku-ai.ts` 的 PARAMS 上方另有一段实测佐证。
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

/** 对方那一方。 */
export function otherOf(player: Player): Player {
  return player === BLACK ? WHITE : BLACK;
}

// ─── 棋型判定（扁平数组核心）─────────────────────────────────────────────────
// 【这一层为什么在 rules 而不是 AI 里】判断「活四 / 冲四 / 活三 / 长连」是**规则**，
// 服务端要用它（禁手判定、以及将来的其它口径），而服务端只跑本模块 —— 本模块
// 零依赖，不得 import 本文件之外的任何东西。所以原语只能住在这里，由 AI **反向
// import**（rules ← ai 是禁止的方向：那会把整个引擎拖进服务端 bundle）。
//
// 【为什么不各写一份】两份棋型判定迟早会 drift，而且是静默的：改了一处、漏了
// 另一处，只在某些局面下判错。这与 `gomoku-room.ts` 文件头那条「前端单机与服务端
// 就会跑出两份判定」是同一个教训。
//
// 【形状约定】参数一律是**扁平数组 + size**：AI 内部本来就是扁平 `Uint8Array`，
// 直接传进来零转换。`size` 必须是参数而不是常量 —— `GomokuBoard` 支持自定义
// 尺寸（测试里用到）。这些函数全是纯函数，只读 cells，唯一的例外是
// `GomokuBoard` 上的方法（它们自己负责压平与复原）。

/**
 * 过 `pos` 沿 `dir` 的连续同色子数，**含 `pos` 自己**。
 * 调用前 `cells[pos]` 必须已经是 `player`。
 *
 * 这是长连判定的原语：`=== 5` 是五连、`>= 6` 是长连。两侧各最多数 4 格就够了 ——
 * 要区分的只是「恰好 5」与「6 以上」，不需要知道到底几连。
 */
export function runLenAt(
  cells: Uint8Array,
  size: number,
  pos: number,
  player: Player,
  dir: number
): number {
  const r0 = (pos / size) | 0;
  const c0 = pos % size;
  const dr = DIRECTIONS[dir][0];
  const dc = DIRECTIONS[dir][1];
  let n = 1;
  for (let sign = 1; sign >= -1; sign -= 2) {
    for (let s = 1; s <= 4; s++) {
      const r = r0 + sign * s * dr;
      const c = c0 + sign * s * dc;
      if (r < 0 || r >= size || c < 0 || c >= size || cells[r * size + c] !== player) break;
      n++;
    }
  }
  return n;
}

/**
 * 以中心格为原点，沿 dir 取出 11 格（左右各 5）。越界的格子记为**对手子** ——
 * 棋盘边界就是封堵，这样「边上的三不是活三」自动成立，不需要特判。
 *
 * 取 5 而不是 4 是因为判断活四要再看一格：`_XXXX_` 的第二个成五点在 5 格外。
 */
function segment(cells: Uint8Array, size: number, pos: number, player: Player, dir: number): Uint8Array {
  const opp = otherOf(player);
  const r0 = (pos / size) | 0;
  const c0 = pos % size;
  const dr = DIRECTIONS[dir][0];
  const dc = DIRECTIONS[dir][1];
  const seg = new Uint8Array(11);
  for (let k = -5; k <= 5; k++) {
    const r = r0 + k * dr;
    const c = c0 + k * dc;
    if (r < 0 || r >= size || c < 0 || c >= size) seg[k + 5] = opp;
    else if (k === 0) seg[k + 5] = player;
    else seg[k + 5] = cells[r * size + c];
  }
  return seg;
}

/**
 * 某个方向上「再填哪一格就能成五」的空格（扁平下标）。
 *
 * 做法：在 11 格窗口里枚举 5 个**包含中心**的 5 格窗口（起点 1..5）。某个窗口里
 * 没有对手子且恰好有 4 个我方子时，它缺的那一格就是成五点 —— 这一步顺带把跳子
 * 处理掉了，因为「差一格」本来就不要求这 4 个子连续。
 *
 * 调用前 `cells[pos]` 必须已经是 `player`。
 *
 * 【必须去重】同一个空点可能同时属于两个含中心的窗口（例如黑在 0,1,2、中心是 3、
 * 9 也是黑时，窗口 `0..4` 与 `1..5` 都以 4 号格为成五点），会被数两遍。成五点是
 * **集合**，不去重就会把「一个成五点的冲四」变成「两个成五点的活四」，活三与
 * 活四的判定全跟着错。候选位只有 11 个，用位掩码去重，不需要额外分配。
 */
function dirWinCells(
  cells: Uint8Array,
  size: number,
  pos: number,
  player: Player,
  dir: number
): number[] {
  const r0 = (pos / size) | 0;
  const c0 = pos % size;
  const dr = DIRECTIONS[dir][0];
  const dc = DIRECTIONS[dir][1];
  const seg = segment(cells, size, pos, player, dir);
  const out: number[] = [];
  let seen = 0;
  for (let s = 1; s <= 5; s++) {
    let mine = 0;
    let blocked = false;
    let hole = -1;
    for (let k = 0; k < 5; k++) {
      const v = seg[s + k];
      if (v === player) mine++;
      else if (v === EMPTY) hole = s + k;
      else {
        blocked = true;
        break;
      }
    }
    if (blocked || mine !== 4) continue;
    const bit = 1 << hole;
    if (seen & bit) continue;
    seen |= bit;
    const off = hole - 5;
    out.push((r0 + off * dr) * size + (c0 + off * dc));
  }
  return out;
}

/**
 * 落子在 `pos` 后，四个方向上「再填哪一格就能成五」的空格集合（去重）。
 * 个数就是这一手造出的成五点数量：`>= 2` 活四（对手一手挡不住）、`= 1` 冲四/跳四。
 */
export function winCells(cells: Uint8Array, size: number, pos: number, player: Player): number[] {
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const list = dirWinCells(cells, size, pos, player, d);
    for (let i = 0; i < list.length; i++) {
      if (!out.includes(list[i])) out.push(list[i]);
    }
  }
  return out;
}

/** 这一手在几个**方向**上成四（该方向至少有一个成五点）。`>= 2` 即双四。 */
export function countFourDirs(cells: Uint8Array, size: number, pos: number, player: Player): number {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    if (dirWinCells(cells, size, pos, player, d).length > 0) n++;
  }
  return n;
}

/** 该方向上**同一个方向**是否还有 ≥2 个成五点 —— 即「再走一步能成活四」。 */
export function dirHasOpenFour(
  cells: Uint8Array,
  size: number,
  pos: number,
  player: Player,
  dir: number
): boolean {
  const r0 = (pos / size) | 0;
  const c0 = pos % size;
  const dr = DIRECTIONS[dir][0];
  const dc = DIRECTIONS[dir][1];
  for (let k = -5; k <= 5; k++) {
    if (k === 0) continue;
    const r = r0 + k * dr;
    const c = c0 + k * dc;
    if (r < 0 || r >= size || c < 0 || c >= size) continue;
    const flat = r * size + c;
    if (cells[flat] !== EMPTY) continue;
    cells[flat] = player;
    // 【必须只看 dir 这一个方向 —— 这里曾经调四方向版的 `winCells`】那样会把
    // **另一个方向**上已有的成五点一起数进来：本方向补一子只是个冲四，加上别处
    // 那个「1」就凑成 2，眠三被误判成活三。
    const open = dirWinCells(cells, size, pos, player, dir).length >= 2;
    cells[flat] = EMPTY;
    if (open) return true;
  }
  return false;
}

/**
 * 【这里曾经有一个 `makesFive`，已删】它的语义是 `runLenAt >= WIN_LENGTH`，也就是
 * free-style 的「长连也算胜」—— 而禁手上线后那对黑棋是**错的**（长连走不上去）。
 * 引擎侧对应的是 `gomoku-ai.ts` 里按颜色分岔的 `isFiveWin`；规则侧要判五连就直接
 * 用 `runLenAt` 跟 `WIN_LENGTH` 比。**别把 `>= 5` 的版本再加回来**：留着它只会
 * 诱导出「黑棋把长连当成胜」那类静默错误。
 */

/** 把二维棋盘压成扁平数组 —— 上面这些原语的输入形状。 */
export function flatCells(grid: Cell[][], size: number): Uint8Array {
  const cells = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    const row = grid[r];
    for (let c = 0; c < size; c++) {
      const v = row[c];
      if (v !== EMPTY) cells[r * size + c] = v;
    }
  }
  return cells;
}

// ─── 先手禁手（Renju 口径）───────────────────────────────────────────────────

/** 黑棋的三种禁手形状。 */
export type ForbiddenKind = 'overline' | 'double-four' | 'double-three';

/**
 * 黑棋落在 `pos` 会不会形成禁手 —— **落子前的查询**，`cells[pos]` 必须是空格。
 *
 * 判定顺序（顺序是有意义的，别重排）：
 *   ① **恰好五连 → 合法**。五连优先于一切禁手：一手若在某方向恰好成五，那就是胜，
 *      哪怕同时在别的方向形成禁手形状。（长连不是五连，见 ②。）
 *   ② **长连（≥6 连）→ 禁手**。
 *   ③ **四四** —— 落子后在 ≥2 个**方向**上造出「四」。按方向计数，不是按成五点数：
 *      同一方向上有两个成五点是「活四」（合法且是必胜手），两个方向各一个才是四四。
 *   ④ **三三** —— 落子后在 ≥2 个方向上造出活三，**且一个四都没有**时才判。
 *      四三、四三三（一个四 + 两个三）都是合法着法，标准 Renju 亦然。
 *
 * 【保真度边界 · 刻意取的实务口径】完整 Renju 的「活三」是递归定义的：它能够长成
 * 的那个活四，本身不能是禁手四。本实现只用「存在一点补上后本方向有 ≥2 个成五点」
 * 判定活三，没有往下递归。会误判的极端形状是：那个活四的两个成五点**都**是长连点
 * （即补上去只会造出六连）。真要精化，就在 `dirHasOpenFour` 里要求候选补子的
 * `runLenAt` 恰为 5 —— 那一步目前没做。
 *
 * 白棋恒返回 `null`（Renju 只约束先手）。
 */
export function forbiddenKindAt(
  cells: Uint8Array,
  size: number,
  pos: number,
  player: Player
): ForbiddenKind | null {
  if (player !== BLACK || cells[pos] !== EMPTY) return null;
  cells[pos] = BLACK;
  try {
    // ① / ② —— 四个方向的连长。runLenAt 两侧各最多数 4 格，够分辨 5 与 6。
    const n0 = runLenAt(cells, size, pos, BLACK, 0);
    const n1 = runLenAt(cells, size, pos, BLACK, 1);
    const n2 = runLenAt(cells, size, pos, BLACK, 2);
    const n3 = runLenAt(cells, size, pos, BLACK, 3);
    if (n0 === WIN_LENGTH || n1 === WIN_LENGTH || n2 === WIN_LENGTH || n3 === WIN_LENGTH) {
      return null;
    }
    if (n0 > WIN_LENGTH || n1 > WIN_LENGTH || n2 > WIN_LENGTH || n3 > WIN_LENGTH) {
      return 'overline';
    }
    // ③ 四四 —— 按方向数「造出四」的方向数
    let fours = 0;
    for (let d = 0; d < 4; d++) {
      if (dirWinCells(cells, size, pos, BLACK, d).length > 0) fours++;
    }
    if (fours >= 2) return 'double-four';
    // ④ 三三 —— 有四就不判（四三 / 四三三都合法）
    if (fours === 0) {
      let threes = 0;
      for (let d = 0; d < 4; d++) {
        if (dirHasOpenFour(cells, size, pos, BLACK, d)) threes++;
      }
      if (threes >= 2) return 'double-three';
    }
    return null;
  } finally {
    cells[pos] = EMPTY;
  }
}

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

  /**
   * 黑棋落在 (row,col) 会是哪种禁手；不是禁手（含白棋、含非空格）返回 `null`。
   *
   * 【为什么是「落子前的查询」】本站取**拒绝落子**口径：禁手点走不出来，而不是
   * 走了判负。所以调用方在 `placeStone` **之前**问，非 null 就拒绝这一手 ——
   * 这样棋盘一格都不动，满足房间层 `RoomBoard.submit` 的契约「返回 null 时棋盘
   * 未改动」。**不要改成「先落子再 undo」**：`undo` 会污染 `moveHistory`。
   */
  forbiddenKind(row: number, col: number, player: Player): ForbiddenKind | null {
    if (player !== BLACK || !this.isValidMove(row, col)) return null;
    return forbiddenKindAt(
      flatCells(this.grid, this.size),
      this.size,
      row * this.size + col,
      player
    );
  }

  /** (row,col) 是否是黑棋的禁手点。语义见 `forbiddenKind`。 */
  isForbidden(row: number, col: number, player: Player): boolean {
    return this.forbiddenKind(row, col, player) !== null;
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
