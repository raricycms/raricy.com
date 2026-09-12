// ─────────────────────────────────────────────────────────────────────────────
// xiangqi-rules.ts — 中国象棋的**纯规则**：棋盘模型、走法生成与终局判定。
//
// 【为什么在 lib 而不是组件里】联机对战时客户端不可信（否则 POST 一句「我赢了」
// 就行），胜负必须由服务端判定。抽到这里是为了让前端组件与服务端 API **跑同一份
// 代码路径** —— 若两边各写一份，规则迟早会 drift，而且是静默的那种。
// 单机的同机双人也跑这一份。
//
// 【依赖】除 board-shared 的**类型**（import type，编译期擦除、无运行时代码）外
// 不 import 任何东西 —— 它要同时跑在浏览器与服务端。
//
// 【规则口径 · 改动前必读】
//   • 9 列 × 10 行；**红先**（RED=1 = 房间层的先手席），黑后。
//     ⚠ 注意与另外两款棋相反：国际象棋、国际跳棋都是**白**先。房间层的席位 id
//     是 `black`/`white`，那是"第几个座位"不是颜色 —— 象棋的 `black` 席执红。
//   • 棋子编码 `cell = type + (color === BLACK ? 8 : 0)`：红 1..7、黑 9..15。
//     取值 EMPTY=0、KING=1、ADVISOR=2、ELEPHANT=3、HORSE=4、CHARIOT=5、
//     CANNON=6、PAWN=7。
//   • grid[row][col]，**row 0 是黑方底线**，row 9 是红方底线；红方向上走（row 减）。
//   • 红方九宫 = 行 7..9、列 3..5；黑方九宫 = 行 0..2、列 3..5。
//   • 红方半场 = 行 5..9，黑方半场 = 行 0..4，河界在行 4 与行 5 之间。
//   • 象走田不过河、塞象眼；马走日蹩马腿；炮翻山吃子；兵过河才能横走。
//   • **飞将**：两个王不能在同一直线上照面（中间无子）——按"走后局面合法性"实现。
//   • **困毙判负**：无棋可走且未被将军 = **输**。这与国际象棋的逼和判和**正好相反**，
//     是这类实现最常见的错误，也是本文件最该被测试钉住的一条。
//   • 和棋：60 回合（120 个半回合）无吃子；三次重复局面判和。
//     但**长将判负**：若重复的循环里一方**每步都在将军**，则该方判负。
//     长捉判负规则争议极大（各引擎实现都不一致），**不实现**，此处只覆盖长将。
//
// 【正确性靠 perft 钉住】tests/unit/xiangqi-rules.test.ts 用国际通行的 perft 节点数
// （开局 1→44 / 2→1920 / 3→79666）验证走法生成。单条用例只能验证你想得到的情形，
// perft 能抓住"某条规则整体写错"。改本文件后那几个数字若对不上，就是真的错了。
// ─────────────────────────────────────────────────────────────────────────────

import type { Move, MoveInput, Outcome, Player, Square } from './board-shared';

export const ROWS = 10;
export const COLS = 9;
export const EMPTY = 0;

export const RED = 1;
export const BLACK = 2;
export type Color = typeof RED | typeof BLACK;

export const KING = 1;
export const ADVISOR = 2;
export const ELEPHANT = 3;
export const HORSE = 4;
export const CHARIOT = 5;
export const CANNON = 6;
export const PAWN = 7;
export type PieceType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const BLACK_OFFSET = 8;

export function piece(color: Color, type: PieceType): number {
  return color === BLACK ? type + BLACK_OFFSET : type;
}

export function colorOf(cell: number): Color | 0 {
  if (cell === EMPTY) return 0;
  return cell > BLACK_OFFSET ? BLACK : RED;
}

export function typeOf(cell: number): PieceType | 0 {
  if (cell === EMPTY) return 0;
  return (cell > BLACK_OFFSET ? cell - BLACK_OFFSET : cell) as PieceType;
}

export function other(color: Color): Color {
  return color === RED ? BLACK : RED;
}

/** 红方九宫底/顶行。红在下（行 7..9），黑在上（行 0..2）。 */
const PALACE_ROW_MIN = (c: Color): number => (c === RED ? 7 : 0);
const PALACE_ROW_MAX = (c: Color): number => (c === RED ? 9 : 2);
const PALACE_COL_MIN = 3;
const PALACE_COL_MAX = 5;

function inPalace(r: number, c: number, color: Color): boolean {
  return (
    r >= PALACE_ROW_MIN(color) &&
    r <= PALACE_ROW_MAX(color) &&
    c >= PALACE_COL_MIN &&
    c <= PALACE_COL_MAX
  );
}

/** 该方的半场（象不许过河）：红 5..9，黑 0..4。 */
function inOwnHalf(r: number, color: Color): boolean {
  return color === RED ? r >= 5 : r <= 4;
}

function inside(r: number, c: number): boolean {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

/** 兵/卒是否已过河（过河才能横走）。红过河 = 行 ≤ 4，黑过河 = 行 ≥ 5。 */
function crossedRiver(r: number, color: Color): boolean {
  return color === RED ? r <= 4 : r >= 5;
}

/** 棋盘格名，如 `e4`（列 a..i、行 0..9 自下而上编号，便于对照棋谱）。 */
export function squareName([r, c]: Square): string {
  return `${'abcdefghi'[c]}${9 - r}`;
}

const GLYPH_RED: Record<PieceType, string> = {
  [KING]: '帥', [ADVISOR]: '仕', [ELEPHANT]: '相', [HORSE]: '馬',
  [CHARIOT]: '車', [CANNON]: '炮', [PAWN]: '兵',
};
const GLYPH_BLACK: Record<PieceType, string> = {
  [KING]: '將', [ADVISOR]: '士', [ELEPHANT]: '象', [HORSE]: '馬',
  [CHARIOT]: '車', [CANNON]: '砲', [PAWN]: '卒',
};

/** 棋子字形。红方与黑方用**不同的字**（帥/將、仕/士、相/象、炮/砲、兵/卒）。 */
export function glyphOf(cell: number): string {
  const t = typeOf(cell);
  if (t === 0) return '';
  return colorOf(cell) === RED ? GLYPH_RED[t] : GLYPH_BLACK[t];
}

/** FEN 字母 ↔ 兵种。红大写、黑小写（与国际象棋 FEN 同一习惯）。 */
const TYPE_OF_LETTER: Record<string, PieceType> = {
  k: KING, a: ADVISOR, b: ELEPHANT, n: HORSE, r: CHARIOT, c: CANNON, p: PAWN,
};
const LETTER_OF: Record<PieceType, string> = {
  [KING]: 'k', [ADVISOR]: 'a', [ELEPHANT]: 'b', [HORSE]: 'n',
  [CHARIOT]: 'r', [CANNON]: 'c', [PAWN]: 'p',
};

// ─── 内部记录 ────────────────────────────────────────────────────────────────

interface Applied {
  move: MoveInput;
  color: Color;
  captured: number;
  capturedAt: Square | null;
  prevNoCapture: number;
  /** 本手走完之后是否将了对方的军 —— 长将判负要靠它回溯。 */
  gaveCheck: boolean;
  /** 本手走完之后的局面键。 */
  keyAfter: string;
  prevLastMove: Move | null;
}

/** 一手的日志，用于「重复循环里谁一直在将军」。 */
interface MoveLogEntry {
  color: Color;
  gaveCheck: boolean;
  keyAfter: string;
}

/** 60 回合无吃子 = 120 个半回合。 */
const DRAW_NO_CAPTURE_HALF_MOVES = 120;

function positionKey(grid: number[][], turn: Color): string {
  return `${grid.map((row) => row.join(',')).join('/')}|${turn}`;
}

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

/** 马的八个方向，附「马腿」相对偏移（蹩腿的那一格）。 */
const HORSE_DELTAS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
  [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
];

const ELEPHANT_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-2, -2], [-2, 2], [2, -2], [2, 2],
];

// ─── 棋盘 ────────────────────────────────────────────────────────────────────

export class XiangqiBoard {
  readonly rows = ROWS;
  readonly cols = COLS;
  grid: number[][] = [];
  turn: Color = RED;
  lastMove: Move | null = null;
  /** 距上一次吃子过了多少个半回合（满 120 判和）。 */
  noCapture = 0;
  private positions = new Map<string, number>();
  private moveLog: MoveLogEntry[] = [];
  private history: Applied[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    // 标准开局：上路黑（小写），下路红（大写），红先
    this.loadFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
  }

  loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    const [placement, side = 'w', , , halfField = '0'] = parts;

    const grid: number[][] = [];
    for (const rank of placement.split('/')) {
      const row: number[] = [];
      for (const ch of rank) {
        if (ch >= '1' && ch <= '9') {
          for (let i = 0; i < Number(ch); i++) row.push(EMPTY);
        } else {
          const type = TYPE_OF_LETTER[ch.toLowerCase()];
          if (!type) throw new Error(`FEN 里有认不出的棋子：${ch}`);
          // 象棋 FEN 的习惯：**大写 = 红**
          const color: Color = ch === ch.toUpperCase() ? RED : BLACK;
          row.push(piece(color, type));
        }
      }
      if (row.length !== COLS) throw new Error(`FEN 的 ${rank} 不是 9 列`);
      grid.push(row);
    }
    if (grid.length !== ROWS) throw new Error('FEN 不是 10 行');

    this.grid = grid;
    this.turn = side === 'b' ? BLACK : RED;
    this.noCapture = Number(halfField) || 0;
    this.lastMove = null;
    this.moveLog = [];
    this.history = [];
    this.positions = new Map();
    this.positions.set(positionKey(this.grid, this.turn), 1);
  }

  clone(): XiangqiBoard {
    const b = new XiangqiBoard();
    b.grid = this.grid.map((row) => row.slice());
    b.turn = this.turn;
    b.lastMove = this.lastMove
      ? { path: this.lastMove.path.map(([r, c]) => [r, c] as Square), player: this.lastMove.player }
      : null;
    b.noCapture = this.noCapture;
    b.positions = new Map(this.positions);
    b.moveLog = this.moveLog.map((e) => ({ ...e }));
    b.history = this.history.map((h) => ({ ...h }));
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

  kingSquare(color: Color): Square | null {
    const target = piece(color, KING);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (this.grid[r][c] === target) return [r, c];
    }
    return null;
  }

  /**
   * 两个王是否在同一直线上照面（中间无子）。**飞将**。
   * 这是"走后局面合法不合法"的判据 —— 任何造成照面的着法一律非法。
   */
  kingsFacing(): boolean {
    const rk = this.kingSquare(RED);
    const bk = this.kingSquare(BLACK);
    if (!rk || !bk) return false;
    if (rk[1] !== bk[1]) return false;
    const col = rk[1];
    const lo = Math.min(rk[0], bk[0]);
    const hi = Math.max(rk[0], bk[0]);
    for (let r = lo + 1; r < hi; r++) if (this.grid[r][col] !== EMPTY) return false;
    return true;
  }

  /** 走子权在 `color` 手上时，他是否正被将军。 */
  inCheck(color: Color): boolean {
    const k = this.kingSquare(color);
    if (!k) return false;
    return this.isAttacked(k[0], k[1], other(color));
  }

  /** (r,c) 是否被 `by` 方的棋子攻击。 */
  isAttacked(r: number, c: number, by: Color): boolean {
    // 兵/卒：红兵在 (r+1, c) 向前攻；过河的红兵还能从 (r, c±1) 横攻。
    const pawn = piece(by, PAWN);
    const forwardFrom = by === RED ? r + 1 : r - 1;
    if (inside(forwardFrom, c) && this.grid[forwardFrom][c] === pawn) return true;
    for (const dc of [-1, 1]) {
      if (!inside(r, c + dc)) continue;
      if (this.grid[r][c + dc] !== pawn) continue;
      if (crossedRiver(r, by)) return true; // 只有过了河的兵才能横着攻
    }

    // 马：反着看八个方向，注意蹩的是**它**的马腿
    const horse = piece(by, HORSE);
    for (const [dr, dc, lr, lc] of HORSE_DELTAS) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inside(rr, cc) || this.grid[rr][cc] !== horse) continue;
      // 马腿在马的旁边：马在 (rr,cc)，它走向 (r,c)，腿位 = 马 + 方向上的第一步
      const legR = rr - lr;
      const legC = cc - lc;
      if (inside(legR, legC) && this.grid[legR][legC] === EMPTY) return true;
    }

    // 车 / 炮：沿四个方向扫
    const chariot = piece(by, CHARIOT);
    const cannonCell = piece(by, CANNON);
    for (const [dr, dc] of ORTHO) {
      let rr = r + dr;
      let cc = c + dc;
      let screen = 0;
      while (inside(rr, cc)) {
        const cell = this.grid[rr][cc];
        if (cell === EMPTY) {
          rr += dr;
          cc += dc;
          continue;
        }
        if (screen === 0) {
          if (cell === chariot) return true; // 车的直线攻击（第一个子就是它）
          screen = 1; // 炮需要一个炮架，继续往外找
        } else {
          // 越过炮架之后的第一个子：是炮就构成攻击
          if (cell === cannonCell) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }

    // 王：贴身一格（王不能出九宫，所以只可能相邻）
    const king = piece(by, KING);
    for (const [dr, dc] of ORTHO) {
      if (inside(r + dr, c + dc) && this.grid[r + dr][c + dc] === king) return true;
    }

    return false;
  }

  // ── 走法生成 ──────────────────────────────────────────────────────────────

  generateMoves(color: Color): MoveInput[] {
    const legal: MoveInput[] = [];
    for (const move of this.pseudoMoves(color)) {
      const a = this.make(move, color);
      // 合法 = 自己没被将 **且** 两个王没有照面
      const bad = this.inCheck(color) || this.kingsFacing();
      this.unmake(a);
      if (!bad) legal.push(move);
    }
    return legal;
  }

  private pseudoMoves(color: Color): MoveInput[] {
    const moves: MoveInput[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.grid[r][c];
        if (colorOf(cell) !== color) continue;
        switch (typeOf(cell)) {
          case KING: this.kingMoves(r, c, color, moves); break;
          case ADVISOR: this.advisorMoves(r, c, color, moves); break;
          case ELEPHANT: this.elephantMoves(r, c, color, moves); break;
          case HORSE: this.horseMoves(r, c, color, moves); break;
          case CHARIOT: this.slideMoves(r, c, color, false, moves); break;
          case CANNON: this.slideMoves(r, c, color, true, moves); break;
          case PAWN: this.pawnMoves(r, c, color, moves); break;
        }
      }
    }
    return moves;
  }

  private pushIfFree(r: number, c: number, color: Color, out: MoveInput[], from: Square): void {
    if (!inside(r, c)) return;
    if (colorOf(this.grid[r][c]) === color) return; // 自己的子挡住
    out.push({ path: [from, [r, c]] });
  }

  private kingMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    for (const [dr, dc] of ORTHO) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inPalace(rr, cc, color)) continue; // 出九宫非法
      this.pushIfFree(rr, cc, color, out, [r, c]);
    }
  }

  private advisorMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inPalace(rr, cc, color)) continue;
      this.pushIfFree(rr, cc, color, out, [r, c]);
    }
  }

  private elephantMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    for (const [dr, dc] of ELEPHANT_DELTAS) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inside(rr, cc)) continue;
      if (!inOwnHalf(rr, color)) continue; // 象不过河
      // 塞象眼：田字中心那格必须空
      if (this.grid[r + dr / 2][c + dc / 2] !== EMPTY) continue;
      this.pushIfFree(rr, cc, color, out, [r, c]);
    }
  }

  private horseMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    for (const [dr, dc, lr, lc] of HORSE_DELTAS) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inside(rr, cc)) continue;
      // 蹩马腿：走"日"时先直行的那一格必须空
      if (this.grid[r + lr][c + lc] !== EMPTY) continue;
      this.pushIfFree(rr, cc, color, out, [r, c]);
    }
  }

  /**
   * 车与炮共用一套扫描：
   *   非吃子时两者都是"沿直线走，直到撞上任何子为止"。
   *   吃子时车要求"第一个撞上的子就是敌子"；炮要求"先翻过一个炮架，
   *   再撞上的第一个子是敌子"。
   * `asCannon` 只影响吃子那一段。
   */
  private slideMoves(
    r: number,
    c: number,
    color: Color,
    asCannon: boolean,
    out: MoveInput[]
  ): void {
    for (const [dr, dc] of ORTHO) {
      let rr = r + dr;
      let cc = c + dc;
      /** 炮是否已经翻过炮架。翻过之后**只能吃子，不能再落空格**。 */
      let jumped = false;
      while (inside(rr, cc)) {
        const cell = this.grid[rr][cc];

        if (jumped) {
          // 越过炮架之后：沿路只看第一个子，是敌子就吃、然后无论敌友都停
          if (cell !== EMPTY) {
            if (colorOf(cell) !== color) out.push({ path: [[r, c], [rr, cc]] });
            break;
          }
        } else if (cell === EMPTY) {
          out.push({ path: [[r, c], [rr, cc]] }); // 空格：走得到
        } else if (!asCannon) {
          if (colorOf(cell) !== color) out.push({ path: [[r, c], [rr, cc]] });
          break; // 车撞上第一个子就停
        } else {
          jumped = true; // 这个子就是炮架，继续往外找
        }

        rr += dr;
        cc += dc;
      }
    }
  }

  private pawnMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    const forward = color === RED ? -1 : 1;
    this.pushIfFree(r + forward, c, color, out, [r, c]);
    // 过河之后才能横走；永远不能后退
    if (crossedRiver(r, color)) {
      this.pushIfFree(r, c - 1, color, out, [r, c]);
      this.pushIfFree(r, c + 1, color, out, [r, c]);
    }
  }

  // ── 落子 / 回退 ───────────────────────────────────────────────────────────

  private make(move: MoveInput, color: Color): Applied {
    const [from, to] = [move.path[0], move.path[move.path.length - 1]];
    const moving = this.grid[from[0]][from[1]];
    const target = this.grid[to[0]][to[1]];

    const applied: Applied = {
      move,
      color,
      captured: target,
      capturedAt: target !== EMPTY ? [to[0], to[1]] : null,
      prevNoCapture: this.noCapture,
      gaveCheck: false,
      keyAfter: '',
      prevLastMove: this.lastMove,
    };

    this.grid[to[0]][to[1]] = moving;
    this.grid[from[0]][from[1]] = EMPTY;

    this.noCapture = target !== EMPTY ? 0 : this.noCapture + 1;
    this.turn = other(color);
    this.lastMove = { path: move.path.map(([r, c]) => [r, c] as Square), player: color };

    applied.gaveCheck = this.inCheck(this.turn);
    applied.keyAfter = positionKey(this.grid, this.turn);
    this.positions.set(applied.keyAfter, (this.positions.get(applied.keyAfter) ?? 0) + 1);
    this.moveLog.push({ color, gaveCheck: applied.gaveCheck, keyAfter: applied.keyAfter });
    this.history.push(applied);
    return applied;
  }

  private unmake(a: Applied): void {
    const [from, to] = [a.move.path[0], a.move.path[a.move.path.length - 1]];
    this.grid[from[0]][from[1]] = this.grid[to[0]][to[1]];
    this.grid[to[0]][to[1]] = EMPTY;

    if (a.capturedAt) this.grid[a.capturedAt[0]][a.capturedAt[1]] = a.captured;

    this.noCapture = a.prevNoCapture;
    this.turn = a.color;
    this.lastMove = a.prevLastMove;

    // 按 make 当时记下的键减 —— 此刻的局面已经是走之前的了，不能现算
    const n = this.positions.get(a.keyAfter);
    if (n !== undefined) {
      if (n <= 1) this.positions.delete(a.keyAfter);
      else this.positions.set(a.keyAfter, n - 1);
    }
    this.moveLog.pop();
    this.history.pop();
  }

  repetitionCount(): number {
    return this.positions.get(positionKey(this.grid, this.turn)) ?? 1;
  }

  // ── 终局 ──────────────────────────────────────────────────────────────────

  private outcomeFor(color: Color): Outcome {
    const moves = this.generateMoves(color);
    const checked = this.inCheck(color);
    const king = this.kingSquare(color);

    if (moves.length === 0) {
      // 无论将死还是困毙，**都是输** —— 这与国际象棋的逼和判和正好相反。
      // reason 分开只是为了文案（「将死」vs「困毙」），胜负完全一样。
      // 走不动的是 `color`，赢的是刚走完的那一方。
      return {
        status: 'won',
        winner: other(color),
        highlight: king ? [king] : [],
        reason: checked ? 'checkmate' : 'no-moves',
      };
    }

    if (this.noCapture >= DRAW_NO_CAPTURE_HALF_MOVES) {
      return { status: 'draw', reason: 'no-capture' };
    }

    if (this.repetitionCount() >= 3) {
      const loser = this.perpetualChecker();
      if (loser) {
        // 长将判负：循环里一直在将军的那一方（= 刚走完的那一方）**输**。
        // 所以赢家是 `other(loser)`，正好是此刻轮到走棋的 `color` ——
        // 若按"走的人赢"去推就判反了，这正是 Outcome 要显式带 winner 的原因。
        const loserKing = this.kingSquare(loser);
        return {
          status: 'won',
          winner: other(loser),
          highlight: loserKing ? [loserKing] : [],
          reason: 'perpetual-check',
        };
      }
      return { status: 'draw', reason: 'repetition' };
    }

    return { status: 'playing', check: checked ? king : null };
  }

  /**
   * 长将判负：若三次重复的循环里，**某一方每一步都在将军**，返回那一方（判负方）。
   *
   * 做法：从日志里找到本局面上一次出现的位置，取那之后到现在这一段（就是一个完整的
   * 循环），看每一方的着法是不是"全是将军"。只有恰好一方满足才算长将 ——
   * 双方都在将军（互相长将）按和棋处理，那属于罕见的争议局面，不硬判。
   */
  private perpetualChecker(): Color | null {
    const key = positionKey(this.grid, this.turn);
    let prev = -1;
    // 从**倒数第二条**往回找：最后一条就是刚走完的这一手（它的 keyAfter 正是当前
    // 局面），拿它当"上一次出现"会让循环切成空数组，长将永远判不出来。
    for (let i = this.moveLog.length - 2; i >= 0; i--) {
      if (this.moveLog[i].keyAfter === key) {
        prev = i;
        break;
      }
    }
    if (prev < 0) return null;

    // 循环 = 上一次出现之后的那些着法（不含造成上一次出现的那个 keyAfter）
    const cycle = this.moveLog.slice(prev + 1);
    if (cycle.length === 0) return null;

    const allCheck = (color: Color): boolean => {
      const mine = cycle.filter((e) => e.color === color);
      return mine.length > 0 && mine.every((e) => e.gaveCheck);
    };

    const redAll = allCheck(RED);
    const blackAll = allCheck(BLACK);
    if (redAll && !blackAll) return RED;
    if (blackAll && !redAll) return BLACK;
    return null;
  }

  // ── 房间层接口 ────────────────────────────────────────────────────────────

  submit(player: Player, move: MoveInput): Outcome | null {
    if (player !== this.turn) return null;
    if (!Array.isArray(move.path) || move.path.length !== 2) return null;

    const from = move.path[0];
    const to = move.path[1];
    const legal = this.generateMoves(this.turn).find(
      (m) => m.path[0][0] === from[0] && m.path[0][1] === from[1] &&
             m.path[1][0] === to[0] && m.path[1][1] === to[1]
    );
    if (!legal) return null;

    this.make(legal, this.turn);
    return this.outcomeFor(this.turn);
  }

  /** perft：数 `depth` 层内的合法着法树节点数。测试的正确性硬锚。 */
  perft(depth: number): number {
    if (depth === 0) return 1;
    const moves = this.generateMoves(this.turn);
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
