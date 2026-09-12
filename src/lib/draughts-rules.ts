// ─────────────────────────────────────────────────────────────────────────────
// draughts-rules.ts — 国际跳棋（International / 10×10 draughts）的**纯规则**。
//
// 【为什么在 lib 而不是组件里】联机对战时客户端不可信（否则 POST 一句「我赢了」
// 就行），胜负必须由服务端判定。抽到这里是为了让前端组件与服务端 API **跑同一份
// 代码路径** —— 若两边各写一份，规则迟早会 drift，而且是静默的那种。
// 单机的同机双人也跑这一份。
//
// 【依赖】除 board-shared 的**类型**（import type，编译期擦除、无运行时代码）外
// 不 import 任何东西 —— 它要同时跑在浏览器与服务端。
//
// 【规则口径 · 改动前必读】（国际跳棋，不是英式/俄式，差别很大）
//   • 10×10，只走**深色格**（`(row + col) % 2 === 1`），每方 20 子；**白先**
//     （WHITE=1 = 房间层的先手席）。白向上走（row 减），黑向下走（row 加）。
//   • 编码 `cell = type + (color === BLACK ? 8 : 0)`：白兵=1、白王=2、黑兵=9、黑王=10。
//   • **兵**：不吃的走法只能向前斜走一格；**吃子可以向前也可以向后**，而且能连吃。
//   • **王（dam）**：不吃时沿对角线走任意格；吃子时"飞吃"——
//     同一条对角线上越过**恰好一个**敌子，且它与王之间全是空格，落点在该敌子
//     之后的**任意**空格（到下一个占用格或边界为止），可以继续连吃。
//   • **吃子强制**：只要有吃子，就必须吃。
//   • **最大吃子规则**：必须选吃子数**最多**的那条路径。吃 2 个的走法优先于吃 1 个的，
//     哪怕后者看起来更划算。
//   • **升变时机**：兵在连吃**途中**经过底线**不升变**（继续以兵的身份吃），
//     只有连吃在底线**结束**才升王。
//   • **被吃的子整条连吃结束后才一并移除**，且它们在这期间仍然占着格子（王的飞吃
//     会被它们挡住），同一个子也不能被跳两次。
//   • **无棋可走判负**（不是和棋）。和棋：三次重复局面；25 回合内只有王在动且无吃子。
//
// 【正确性靠 perft 钉住】tests/unit/draughts-rules.test.ts 用国际通行值
// （开局 1→9 / 2→81 / 3→658 / 4→4265 / 5→27117）验证走法生成。
// 吃子强制与最大吃子这两条**只要写错一条**，这几个数字立刻就对不上。
// ─────────────────────────────────────────────────────────────────────────────

import type { Move, MoveInput, Outcome, Player, Square } from './board-shared';

export const SIZE = 10;
export const EMPTY = 0;
export const WHITE = 1;
export const BLACK = 2;
export type Color = typeof WHITE | typeof BLACK;

export const MAN = 1;
export const KING = 2;
export type PieceType = 1 | 2;

const BLACK_OFFSET = 8;

export function piece(color: Color, type: PieceType): number {
  return color === BLACK ? type + BLACK_OFFSET : type;
}

export function colorOf(cell: number): Color | 0 {
  if (cell === EMPTY) return 0;
  return cell > BLACK_OFFSET ? BLACK : WHITE;
}

export function typeOf(cell: number): PieceType | 0 {
  if (cell === EMPTY) return 0;
  return (cell > BLACK_OFFSET ? cell - BLACK_OFFSET : cell) as PieceType;
}

export function other(color: Color): Color {
  return color === WHITE ? BLACK : WHITE;
}

/**
 * 是不是可走的深色格。棋盘上有一半格子永远用不到 ——
 * 界面上也要按这个把浅色格画成不可点。
 */
export function isDark(r: number, c: number): boolean {
  return (r + c) % 2 === 1;
}

function inside(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

/** 兵的升变行：白到 row 0，黑到 row 9。 */
function promotionRow(color: Color): number {
  return color === WHITE ? 0 : SIZE - 1;
}

/** 兵的"向前"方向：白 -1（row 减），黑 +1。 */
function forward(color: Color): number {
  return color === WHITE ? -1 : 1;
}

export function squareName([r, c]: Square): string {
  // 跳棋惯例：格子按行从左到右编号 1..50（只数深色格）
  let n = 0;
  for (let rr = 0; rr < SIZE; rr++) {
    for (let cc = 0; cc < SIZE; cc++) {
      if (!isDark(rr, cc)) continue;
      n++;
      if (rr === r && cc === c) return String(n);
    }
  }
  return '-';
}

/** 棋子字形：大写 = 白。`M`/`m` 是兵，`K`/`k` 是王。 */
export function glyphOf(cell: number): string {
  const t = typeOf(cell);
  if (t === 0) return '';
  const letter = t === KING ? 'k' : 'm';
  return colorOf(cell) === WHITE ? letter.toUpperCase() : letter;
}

const DIAG: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

/** 25 回合（双方各 25 手 = 50 个半回合）内只有王在动且无吃子即判和。 */
const DRAW_KING_ONLY_HALF_MOVES = 50;

function positionKey(grid: number[][], turn: Color): string {
  return `${grid.map((row) => row.join(',')).join('/')}|${turn}`;
}

/** 一条合法的吃子路径（含起点）与被吃掉的子。 */
interface LegalMove {
  path: Square[];
  captured: Square[];
}

interface Applied {
  move: LegalMove;
  color: Color;
  /** 被吃的子（值），回退时放回去。 */
  capturedCells: Array<{ at: Square; cell: number }>;
  promoted: boolean;
  prevKingOnly: number;
  keyAfter: string;
  prevLastMove: Move | null;
}

export class DraughtsBoard {
  readonly rows = SIZE;
  readonly cols = SIZE;
  grid: number[][] = [];
  turn: Color = WHITE;
  lastMove: Move | null = null;
  /** 连续"只有王在动且无吃子"的半回合数（满 50 判和）。 */
  kingOnlyHalfMoves = 0;
  private positions = new Map<string, number>();
  private history: Applied[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    // 标准开局：黑在上四行（rows 0..3），白在下四行（rows 6..9），中间两行空，白先。
    //
    // 【深色格的列号**逐行交替**】`(row+col)%2===1` 意味着偶数行的深色格是
    // 1,3,5,7,9，奇数行是 0,2,4,6,8。所有行都写成 `1m1m1m1m1m` 会把奇数行的子
    // 摆到浅色格上 —— 那样"每个子都能往前走"，开局着法数会翻倍（perft 立刻抓到：
    // 18 而不是 9），而棋盘看上去仍然"摆满了四行"，肉眼完全看不出错。
    const EVEN = '1m1m1m1m1m'; // cols 1,3,5,7,9
    const ODD = 'm1m1m1m1m1'; // cols 0,2,4,6,8
    this.loadFen(
      [EVEN, ODD, EVEN, ODD, '10', '10', EVEN.toUpperCase(), ODD.toUpperCase(), EVEN.toUpperCase(), ODD.toUpperCase()].join('/')
    );
  }

  /**
   * 摆一个局面。每行 10 格，`M`/`m` 是白/黑的兵，`K`/`k` 是白/黑的主，数字是空格。
   * 与另两款棋的 FEN 同一习惯（**大写 = 白**），只是没有王车易位之类的附加字段。
   *
   * `turn` 默认白先（标准开局就是白先）；摆"该黑走"的局面时要显式传 ——
   * 否则测出来的是"白方在这局面下没棋可走"，看起来像规则坏了。
   */
  loadFen(placement: string, turn: Color = WHITE): void {
    const grid: number[][] = [];
    for (const rank of placement.trim().split('/')) {
      const row: number[] = [];
      // 【数字要按整段读】棋盘宽 10，空格最长的连续段就是 "10" ——
      // 逐字符读会把 "10" 当成两个 1 空格，整行就只剩 2 格。
      let i = 0;
      while (i < rank.length) {
        const ch = rank[i];
        if (ch >= '0' && ch <= '9') {
          let digits = '';
          while (i < rank.length && rank[i] >= '0' && rank[i] <= '9') digits += rank[i++];
          for (let k = 0; k < Number(digits); k++) row.push(EMPTY);
        } else {
          const lower = ch.toLowerCase();
          const type: PieceType = lower === 'k' ? KING : MAN;
          const color: Color = ch === ch.toUpperCase() ? WHITE : BLACK;
          row.push(piece(color, type));
          i++;
        }
      }
      if (row.length !== SIZE) throw new Error(`FEN 的 ${rank} 不是 10 格`);
      grid.push(row);
    }
    if (grid.length !== SIZE) throw new Error('FEN 不是 10 行');

    this.grid = grid;
    this.turn = turn;
    this.lastMove = null;
    this.kingOnlyHalfMoves = 0;
    this.history = [];
    this.positions = new Map();
    this.positions.set(positionKey(this.grid, this.turn), 1);
  }

  clone(): DraughtsBoard {
    const b = new DraughtsBoard();
    b.grid = this.grid.map((row) => row.slice());
    b.turn = this.turn;
    b.lastMove = this.lastMove
      ? { path: this.lastMove.path.map(([r, c]) => [r, c] as Square), player: this.lastMove.player }
      : null;
    b.kingOnlyHalfMoves = this.kingOnlyHalfMoves;
    b.positions = new Map(this.positions);
    b.history = this.history.map((h) => ({ ...h, capturedCells: h.capturedCells.map((x) => ({ ...x })) }));
    return b;
  }

  getLastMove(): Move | null {
    return this.lastMove;
  }

  undo(): boolean {
    const a = this.history.pop();
    if (!a) return false;
    this.unmake(a);
    return true;
  }

  at(r: number, c: number): number {
    return this.grid[r][c];
  }

  /** 该方还有没有子。子被吃光也是一种终局（走不动 → 判负）。 */
  countPieces(color: Color): number {
    let n = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (colorOf(this.grid[r][c]) === color) n++;
    }
    return n;
  }

  // ── 走法生成 ──────────────────────────────────────────────────────────────

  /**
   * 全部的合法着法。**吃子强制 + 最大吃子**都在这里实现：
   * 只要存在任何吃子，就只返回吃子；而且只返回吃子数最多的那些。
   */
  generateLegal(color: Color): LegalMove[] {
    let best: LegalMove[] = [];
    let bestCount = 0;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = this.grid[r][c];
        if (colorOf(cell) !== color) continue;
        for (const seq of this.captureSequences([r, c], color, typeOf(cell) as PieceType)) {
          if (seq.captured.length > bestCount) {
            bestCount = seq.captured.length;
            best = [seq];
          } else if (seq.captured.length === bestCount) {
            best.push(seq);
          }
        }
      }
    }

    if (best.length > 0) return best; // 吃子强制
    return this.quietMoves(color);
  }

  generateMoves(color: Color): MoveInput[] {
    return this.generateLegal(color).map((m) => ({ path: m.path.map(([r, c]) => [r, c] as Square) }));
  }

  /** 不吃子的走法。兵只向前一步；王沿对角线任意格。 */
  private quietMoves(color: Color): LegalMove[] {
    const out: LegalMove[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = this.grid[r][c];
        if (colorOf(cell) !== color) continue;

        if (typeOf(cell) === MAN) {
          const fr = r + forward(color);
          for (const dc of [-1, 1]) {
            const fc = c + dc;
            if (!inside(fr, fc) || !isDark(fr, fc)) continue;
            if (this.grid[fr][fc] !== EMPTY) continue;
            out.push({ path: [[r, c], [fr, fc]], captured: [] });
          }
        } else {
          for (const [dr, dc] of DIAG) {
            let rr = r + dr;
            let cc = c + dc;
            while (inside(rr, cc) && isDark(rr, cc) && this.grid[rr][cc] === EMPTY) {
              out.push({ path: [[r, c], [rr, cc]], captured: [] });
              rr += dr;
              cc += dc;
            }
          }
        }
      }
    }
    return out;
  }

  /**
   * 从 (r,c) 出发的全部吃子序列（**含更短的**，由调用方按最大吃子筛）。
   *
   * 【为什么把短序列也返回】最大吃子规则要求"必须吃到最多"，所以一个能继续吃的
   * 位置不允许提前停手。这里把所有前缀都记下来、由 `generateLegal` 取最长的一批，
   * 正好等价于"必须继续吃"，同时天然处理了"多个方向吃一样多"的并列情形。
   */
  private captureSequences(start: Square, color: Color, type: PieceType): LegalMove[] {
    const results: LegalMove[] = [];
    const eaten = new Set<number>();

    /** 这个格子此刻是不是空的。**整条路径上的格子都算空**（子已经离开了），
     *  另外被吃的子虽然还画在盘上，但它**仍然占位** —— 王的飞吃会被它挡住。 */
    const vacant = (r: number, c: number, path: Square[]): boolean => {
      if (this.grid[r][c] === EMPTY) return true;
      return path.some(([pr, pc]) => pr === r && pc === c);
    };

    const walk = (r: number, c: number, path: Square[], captured: Square[]): void => {
      for (const [dr, dc] of DIAG) {
        if (type === MAN) {
          // 兵：跳过紧邻的一个敌子，落在它后面那一格（前后方向都可以）
          const mr = r + dr;
          const mc = c + dc;
          const lr = r + 2 * dr;
          const lc = c + 2 * dc;
          if (!inside(lr, lc) || !isDark(lr, lc)) continue;
          const mid = this.grid[mr][mc];
          if (mid === EMPTY || colorOf(mid) === color) continue;
          const key = mr * SIZE + mc;
          if (eaten.has(key)) continue; // 同一个子不能被跳两次
          if (!vacant(lr, lc, path)) continue;

          eaten.add(key);
          const nextPath = [...path, [lr, lc] as Square];
          const nextCaptured = [...captured, [mr, mc] as Square];
          results.push({ path: nextPath, captured: nextCaptured });
          walk(lr, lc, nextPath, nextCaptured);
          eaten.delete(key);
        } else {
          // 王：飞吃。先掠过空格找到第一个子，它必须是没吃过的敌子
          let rr = r + dr;
          let cc = c + dc;
          while (inside(rr, cc) && isDark(rr, cc) && vacant(rr, cc, path)) {
            rr += dr;
            cc += dc;
          }
          if (!inside(rr, cc) || !isDark(rr, cc)) continue;
          const mid = this.grid[rr][cc];
          if (colorOf(mid) === color) continue; // 自己人挡路
          const key = rr * SIZE + cc;
          if (eaten.has(key)) continue; // 已经吃过的子不能当跳板

          eaten.add(key);
          // 越过它之后，直到下一个占用格之前的**每一个**空格都是合法落点
          let lr = rr + dr;
          let lc = cc + dc;
          while (inside(lr, lc) && isDark(lr, lc) && vacant(lr, lc, path)) {
            const nextPath = [...path, [lr, lc] as Square];
            const nextCaptured = [...captured, [rr, cc] as Square];
            results.push({ path: nextPath, captured: nextCaptured });
            walk(lr, lc, nextPath, nextCaptured);
            lr += dr;
            lc += dc;
          }
          eaten.delete(key);
        }
      }
    };

    walk(start[0], start[1], [start], []);
    return results;
  }

  // ── 落子 / 回退 ───────────────────────────────────────────────────────────

  private make(move: LegalMove, color: Color): Applied {
    const from = move.path[0];
    const to = move.path[move.path.length - 1];
    const cell = this.grid[from[0]][from[1]];
    const type = typeOf(cell);

    const applied: Applied = {
      move,
      color,
      capturedCells: [],
      promoted: false,
      prevKingOnly: this.kingOnlyHalfMoves,
      keyAfter: '',
      prevLastMove: this.lastMove,
    };

    // 先记下被吃的子再拿掉 —— 整条连吃走完之后一并移除（规则如此）
    for (const [r, c] of move.captured) {
      applied.capturedCells.push({ at: [r, c], cell: this.grid[r][c] });
      this.grid[r][c] = EMPTY;
    }

    this.grid[from[0]][from[1]] = EMPTY;
    // **升变只在连吃结束时判**：途中经过底线不算（这里本来就只在终点判，
    // 因为 make 只在整条路径走完之后调用一次）
    const reachesLastRow = to[0] === promotionRow(color);
    if (type === MAN && reachesLastRow) {
      this.grid[to[0]][to[1]] = piece(color, KING);
      applied.promoted = true;
    } else {
      this.grid[to[0]][to[1]] = cell;
    }

    // 25 回合计数：只有"王在动且没吃子"才累加，出现兵动或吃子就归零
    if (type === KING && move.captured.length === 0) {
      this.kingOnlyHalfMoves = this.kingOnlyHalfMoves + 1;
    } else {
      this.kingOnlyHalfMoves = 0;
    }

    this.turn = other(color);
    this.lastMove = { path: move.path.map(([r, c]) => [r, c] as Square), player: color };

    applied.keyAfter = positionKey(this.grid, this.turn);
    this.positions.set(applied.keyAfter, (this.positions.get(applied.keyAfter) ?? 0) + 1);
    this.history.push(applied);
    return applied;
  }

  private unmake(a: Applied): void {
    const from = a.move.path[0];
    const to = a.move.path[a.move.path.length - 1];

    // 把子放回起点：升变过的要还原成兵
    this.grid[from[0]][from[1]] = piece(a.color, a.promoted ? MAN : (typeOf(this.grid[to[0]][to[1]]) as PieceType));
    this.grid[to[0]][to[1]] = EMPTY;

    for (const { at, cell } of a.capturedCells) this.grid[at[0]][at[1]] = cell;

    this.kingOnlyHalfMoves = a.prevKingOnly;
    this.turn = a.color;
    this.lastMove = a.prevLastMove;

    const n = this.positions.get(a.keyAfter);
    if (n !== undefined) {
      if (n <= 1) this.positions.delete(a.keyAfter);
      else this.positions.set(a.keyAfter, n - 1);
    }
    this.history.pop();
  }

  repetitionCount(): number {
    return this.positions.get(positionKey(this.grid, this.turn)) ?? 1;
  }

  // ── 终局 ──────────────────────────────────────────────────────────────────

  private outcomeFor(color: Color): Outcome {
    const moves = this.generateLegal(color);

    if (moves.length === 0) {
      // 无棋可走（子被吃光或被封死）→ **判负**，不是和棋
      return {
        status: 'won',
        winner: other(color),
        highlight: [],
        reason: 'no-moves',
      };
    }

    if (this.kingOnlyHalfMoves >= DRAW_KING_ONLY_HALF_MOVES) {
      return { status: 'draw', reason: 'fifty-move' };
    }
    if (this.repetitionCount() >= 3) {
      return { status: 'draw', reason: 'repetition' };
    }

    return { status: 'playing', check: null };
  }

  // ── 房间层接口 ────────────────────────────────────────────────────────────

  /**
   * 走一手。**整条连吃路径一次提交**（`MoveInput.path` 含起点与每个落点）——
   * 半步状态会让棋盘停在一个不存在的局面上，见 board-shared.ts 的 MoveInput 注释。
   * 非法返回 null 且**棋盘一点没动**。
   */
  submit(player: Player, move: MoveInput): Outcome | null {
    if (player !== this.turn) return null;
    if (!Array.isArray(move.path) || move.path.length < 2) return null;

    const legal = this.generateLegal(this.turn).find((m) => samePath(m.path, move.path));
    if (!legal) return null; // 不合法的路径、或不是吃子最多的那条

    this.make(legal, this.turn);
    return this.outcomeFor(this.turn);
  }

  /** perft：数 `depth` 层内的合法着法树节点数。测试的正确性硬锚。 */
  perft(depth: number): number {
    if (depth === 0) return 1;
    const moves = this.generateLegal(this.turn);
    if (depth === 1) return moves.length;

    let total = 0;
    for (const move of moves) {
      const a = this.make(move, this.turn);
      total += this.perft(depth - 1);
      this.unmake(a);
    }
    return total;
  }
}

/** 两条路径是不是同一条（逐格相同，含起点与顺序）。 */
function samePath(a: Square[], b: Square[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}
