// ─────────────────────────────────────────────────────────────────────────────
// chess-rules.ts — 国际象棋的**纯规则**：棋盘模型、走法生成与终局判定。
//
// 【为什么在 lib 而不是组件里】联机对战时客户端不可信（否则 POST 一句「我赢了」
// 就行），胜负必须由服务端判定。抽到这里是为了让前端组件与服务端 API **跑同一份
// 代码路径** —— 若两边各写一份，规则迟早会 drift，而且是静默的那种。
// 单机的同机双人也跑这一份，所以「单机能走的着法」与「联机能走的着法」不可能不一致。
//
// 【依赖】除 board-shared 的**类型**（import type，编译期擦除、无运行时代码）外
// 不 import 任何东西 —— 它要同时跑在浏览器与服务端。
//
// 【规则口径 · 改动前必读】
//   • 8×8；白先（WHITE=1 = 房间层的先手席），黑后。
//   • 棋子编码 `cell = type + (color === BLACK ? 8 : 0)`：
//     白 1..6、黑 9..14，取值 EMPTY=0、PAWN=1、KNIGHT=2、BISHOP=3、ROOK=4、
//     QUEEN=5、KING=6。别改成别的编码 —— 客户端渲染按这套查字形。
//   • grid[row][col]，**row 0 是第 8 横排**（黑方底线），row 7 是第 1 横排。
//   • 王车易位、吃过路兵、升变、走后不能自将全部实现；判终局是**整盘**判定，
//     与最后一手落在哪儿无关。
//   • 终局：将死判负；**逼和判和**（与中国象棋的困毙判负**相反**，别照抄）；
//     五十回合、子力不足、三次重复判和。
//   • **升变必须报兵种**：这一手既没带 promotion、带了又认不出来，一律按非法着法
//     拒绝（submit 返回 null），**服务端不替玩家选后**。理由：升变成马有时是唯一的
//     赢法（抽将），替选等于替玩家下错一盘棋；而联机没有悔棋，选错了收不回来。
//
// 【正确性靠 perft 钉住】tests/unit/chess-rules.test.ts 用国际通行的 perft 节点数
// （开局 1→20/2→400/3→8902/4→197281，Kiwipete 1→48/2→2039/3→97862）验证走法生成。
// 单条用例只能验证你想得到的情形，perft 能抓住"某条规则整体写错"。改本文件后
// 那几个数字若对不上，就是真的错了，别去改期望值。
// ─────────────────────────────────────────────────────────────────────────────

import type { Move, MoveInput, Outcome, Player, Square } from './board-shared';

export const SIZE = 8;
export const EMPTY = 0;
export const WHITE = 1;
export const BLACK = 2;
export type Color = typeof WHITE | typeof BLACK;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;
export type PieceType = 1 | 2 | 3 | 4 | 5 | 6;

/** 黑子加 8：白 1..6 → 黑 9..14。见文件头的编码口径。 */
const BLACK_OFFSET = 8;

export function piece(color: Color, type: PieceType): number {
  return color === BLACK ? type + BLACK_OFFSET : type;
}

/** 0 = 空格。 */
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

/** 升变可选的四种兵种。**变王不在其中**（king 不是合法升变目标）。 */
export const PROMOTION_TYPES: readonly PieceType[] = [QUEEN, ROOK, BISHOP, KNIGHT];

/** 兵种 ↔ 升变字母。也用于 FEN 与走法记号。 */
const LETTER_OF: Record<PieceType, string> = {
  [PAWN]: 'p',
  [KNIGHT]: 'n',
  [BISHOP]: 'b',
  [ROOK]: 'r',
  [QUEEN]: 'q',
  [KING]: 'k',
};

const TYPE_OF_LETTER: Record<string, PieceType> = {
  p: PAWN,
  n: KNIGHT,
  b: BISHOP,
  r: ROOK,
  q: QUEEN,
  k: KING,
};

/** 升变字母 → 兵种；认不出来（含 'k'、'x'、缺省）一律 null。 */
function promotionType(letter: string | undefined): PieceType | null {
  if (!letter) return null;
  return TYPE_OF_LETTER[letter.toLowerCase()] ?? null;
}

function promotionLetter(type: PieceType): string {
  return LETTER_OF[type];
}

export function squareName([r, c]: Square): string {
  return `${'abcdefgh'[c]}${8 - r}`;
}

/** 棋子字形。**大写 = 白**，与 FEN 同口径；客户端按这个渲染。 */
export function glyphOf(cell: number): string {
  const t = typeOf(cell);
  if (t === 0) return '';
  const letter = LETTER_OF[t];
  return colorOf(cell) === WHITE ? letter.toUpperCase() : letter;
}

// ─── 易位权利 / 局面快照 ─────────────────────────────────────────────────────

/** 易位权利。用对象而不是位掩码：这个模块同时跑在浏览器，可读性优先。 */
export interface CastlingRights {
  wk: boolean;
  wq: boolean;
  bk: boolean;
  bq: boolean;
}

function noCastling(): CastlingRights {
  return { wk: false, wq: false, bk: false, bq: false };
}

function castlingKey(c: CastlingRights): string {
  return `${c.wk ? 'K' : ''}${c.wq ? 'Q' : ''}${c.bk ? 'k' : ''}${c.bq ? 'q' : ''}` || '-';
}

/**
 * 局面标识。**必须含轮次、易位权利与吃过路兵目标格** —— 只哈希 grid 会把
 * "同一摆法但权利不同"的两个局面当成同一个，三次重复就会误判（凭空判和）。
 */
function positionKey(
  grid: number[][],
  turn: Color,
  castling: CastlingRights,
  ep: Square | null
): string {
  const rows = grid.map((row) => row.join(',')).join('/');
  return `${rows}|${turn}|${castlingKey(castling)}|${ep ? squareName(ep) : '-'}`;
}

// ─── 走法 ────────────────────────────────────────────────────────────────────

/** 一手棋在同一起点终点下的唯一标识：升变兵种不同就是不同的着法。 */
function moveKey(move: MoveInput): string {
  const from = move.path[0];
  const to = move.path[move.path.length - 1];
  return `${from[0]},${from[1]}-${to[0]},${to[1]}=${move.promotion ?? ''}`;
}

/** 已走一手后，回退它需要还原的全部东西。 */
interface Applied {
  move: MoveInput;
  color: Color;
  /** 被吃子原本的值（0 = 没吃子）。 */
  captured: number;
  /** 被吃子所在的格。吃过路兵时**不等于**终点。 */
  capturedAt: Square | null;
  /** 易位时同时挪动的车。 */
  rook: { from: Square; to: Square } | null;
  prevCastling: CastlingRights;
  prevEp: Square | null;
  prevHalfmove: number;
  /** 走完之后记进 positions 的那个局面键 —— 回退时按**它**减，不能按当前局面算。 */
  recordedKey: string;
  /**
   * 走之前的高亮手。**必须一起还原**：generateMoves 判合法性时会对每个候选着法
   * 试走再回退，如果只还原 turn 不还原 lastMove，一次走法生成就会把 lastMove
   * 留成最后一个被试过的候选 —— 客户端于是高亮一手根本没走过的棋。
   */
  prevLastMove: Move | null;
}

const KNIGHT_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];
const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];
const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
];

function inside(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// ─── 棋盘 ────────────────────────────────────────────────────────────────────

export class ChessBoard {
  readonly rows = SIZE;
  readonly cols = SIZE;
  grid: number[][] = [];
  turn: Color = WHITE;
  castling: CastlingRights = noCastling();
  /** 吃过路兵的目标格（可被吃掉的兵**落点**）；无则 null。只在紧接的一步内有效。 */
  ep: Square | null = null;
  /** 半回合计数：双方各走一步且无吃子无兵动就 +2。满 100（= 50 回合）判和。 */
  halfmove = 0;
  /** 三次重复用的局面计数。**含开局局面**。 */
  private positions = new Map<string, number>();
  lastMove: Move | null = null;
  /** 已走着的完整记录，供单机悔棋 / 调试。 */
  private history: Applied[] = [];

  constructor() {
    this.reset();
  }

  // ── 开局 / FEN ────────────────────────────────────────────────────────────

  /** 回到国际象棋标准开局。 */
  reset(): void {
    this.loadFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }

  /**
   * 摆一个 FEN 局面。测试（尤其是 perft）靠它摆外部公认的局面，
   * 免得手写摆子摆错却以为是规则错了。
   */
  loadFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    const [placement, side = 'w', castleField = '-', epField = '-', halfField = '0'] = parts;

    const grid: number[][] = [];
    for (const rank of placement.split('/')) {
      const row: number[] = [];
      for (const ch of rank) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < Number(ch); i++) row.push(EMPTY);
        } else {
          const type = TYPE_OF_LETTER[ch.toLowerCase()];
          if (!type) throw new Error(`FEN 里有认不出的棋子：${ch}`);
          const color: Color = ch === ch.toUpperCase() ? WHITE : BLACK;
          row.push(piece(color, type));
        }
      }
      if (row.length !== SIZE) throw new Error(`FEN 的 ${rank} 不是 8 格`);
      grid.push(row);
    }
    if (grid.length !== SIZE) throw new Error('FEN 不是 8 行');

    this.grid = grid;
    this.turn = side === 'b' ? BLACK : WHITE;
    this.castling = {
      wk: castleField.includes('K'),
      wq: castleField.includes('Q'),
      bk: castleField.includes('k'),
      bq: castleField.includes('q'),
    };
    this.ep = epField === '-' ? null : parseSquareName(epField);
    this.halfmove = Number(halfField) || 0;
    this.lastMove = null;
    this.history = [];
    this.positions = new Map();
    this.positions.set(positionKey(this.grid, this.turn, this.castling, this.ep), 1);
  }

  /** 完整深拷贝。perft 与单机悔棋都用它 —— 比手写 undo 少一整类"没还原干净"的 bug。 */
  clone(): ChessBoard {
    const b = new ChessBoard();
    b.grid = this.grid.map((row) => row.slice());
    b.turn = this.turn;
    b.castling = { ...this.castling };
    b.ep = this.ep ? [this.ep[0], this.ep[1]] : null;
    b.halfmove = this.halfmove;
    b.positions = new Map(this.positions);
    b.lastMove = this.lastMove
      ? { path: this.lastMove.path.map(([r, c]) => [r, c] as Square), player: this.lastMove.player }
      : null;
    // prevCastling 是对象，浅拷贝会让两份 history 共享它 —— 各自复制一份
    b.history = this.history.map((h) => ({ ...h, prevCastling: { ...h.prevCastling } }));
    return b;
  }

  getLastMove(): Move | null {
    return this.lastMove;
  }

  /** 单机悔棋用：把最后一手撤掉。没有可撤的返回 false。 */
  undo(): boolean {
    const a = this.history.pop();
    if (!a) return false;
    this.unmake(a);
    this.lastMove =
      this.history.length > 0
        ? { path: this.history[this.history.length - 1].move.path.map(([r, c]) => [r, c] as Square), player: this.history[this.history.length - 1].color }
        : null;
    return true;
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  at(r: number, c: number): number {
    return this.grid[r][c];
  }

  /** 某方的王所在格；王不可能不存在（被吃了就说明上一步非法），找不到返回 null 兜底。 */
  kingSquare(color: Color): Square | null {
    const target = piece(color, KING);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (this.grid[r][c] === target) return [r, c];
    }
    return null;
  }

  /** 走子权在 `color` 手上时，他是否正被将军。 */
  inCheck(color: Color): boolean {
    const k = this.kingSquare(color);
    if (!k) return false;
    return this.isAttacked(k[0], k[1], other(color));
  }

  /** (r,c) 是否被 `by` 方攻击。不含"王对王"这种情形（国际象棋没有）。 */
  isAttacked(r: number, c: number, by: Color): boolean {
    // 兵：白兵在 (r+1, c±1) 攻击 (r,c)；黑兵在 (r-1, c±1)。
    const pawnRow = by === WHITE ? r + 1 : r - 1;
    const pawn = piece(by, PAWN);
    if (inside(pawnRow, c - 1) && this.grid[pawnRow][c - 1] === pawn) return true;
    if (inside(pawnRow, c + 1) && this.grid[pawnRow][c + 1] === pawn) return true;

    // 马
    const knight = piece(by, KNIGHT);
    for (const [dr, dc] of KNIGHT_DELTAS) {
      if (inside(r + dr, c + dc) && this.grid[r + dr][c + dc] === knight) return true;
    }

    // 王（相邻）
    const king = piece(by, KING);
    for (const [dr, dc] of KING_DELTAS) {
      if (inside(r + dr, c + dc) && this.grid[r + dr][c + dc] === king) return true;
    }

    // 斜线：象 / 后
    const bishop = piece(by, BISHOP);
    const queen = piece(by, QUEEN);
    for (const [dr, dc] of BISHOP_DIRS) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        const cell = this.grid[rr][cc];
        if (cell !== EMPTY) {
          if (cell === bishop || cell === queen) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }

    // 直线：车 / 后
    const rook = piece(by, ROOK);
    for (const [dr, dc] of ROOK_DIRS) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        const cell = this.grid[rr][cc];
        if (cell !== EMPTY) {
          if (cell === rook || cell === queen) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }

    return false;
  }

  // ── 走法生成 ──────────────────────────────────────────────────────────────

  /** `color` 的全部**合法**着法（已滤掉走后自将的）。perft 与 submit 都用它。 */
  generateMoves(color: Color): MoveInput[] {
    const legal: MoveInput[] = [];
    for (const move of this.pseudoMoves(color)) {
      const a = this.make(move, color);
      const bad = this.inCheck(color);
      this.unmake(a);
      if (!bad) legal.push(move);
    }
    return legal;
  }

  private pseudoMoves(color: Color): MoveInput[] {
    const moves: MoveInput[] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = this.grid[r][c];
        if (colorOf(cell) !== color) continue;
        const type = typeOf(cell);
        if (type === PAWN) this.pawnMoves(r, c, color, moves);
        else if (type === KNIGHT) this.stepMoves(r, c, color, KNIGHT_DELTAS, moves);
        else if (type === KING) this.stepMoves(r, c, color, KING_DELTAS, moves);
        else if (type === BISHOP) this.slideMoves(r, c, color, BISHOP_DIRS, moves);
        else if (type === ROOK) this.slideMoves(r, c, color, ROOK_DIRS, moves);
        else if (type === QUEEN) {
          this.slideMoves(r, c, color, BISHOP_DIRS, moves);
          this.slideMoves(r, c, color, ROOK_DIRS, moves);
        }
      }
    }
    this.castlingMoves(color, moves);
    return moves;
  }

  private stepMoves(
    r: number,
    c: number,
    color: Color,
    deltas: ReadonlyArray<readonly [number, number]>,
    out: MoveInput[]
  ): void {
    for (const [dr, dc] of deltas) {
      const rr = r + dr;
      const cc = c + dc;
      if (!inside(rr, cc)) continue;
      if (colorOf(this.grid[rr][cc]) === color) continue; // 自己的子挡住
      out.push({ path: [[r, c], [rr, cc]] });
    }
  }

  private slideMoves(
    r: number,
    c: number,
    color: Color,
    dirs: ReadonlyArray<readonly [number, number]>,
    out: MoveInput[]
  ): void {
    for (const [dr, dc] of dirs) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        const cell = this.grid[rr][cc];
        if (cell === EMPTY) {
          out.push({ path: [[r, c], [rr, cc]] });
        } else {
          if (colorOf(cell) !== color) out.push({ path: [[r, c], [rr, cc]] }); // 吃子
          break; // 撞上任何子都停
        }
        rr += dr;
        cc += dc;
      }
    }
  }

  private pawnMoves(r: number, c: number, color: Color, out: MoveInput[]): void {
    // 白往上走（row 递减），黑往下走。
    const dir = color === WHITE ? -1 : 1;
    const startRow = color === WHITE ? 6 : 1;
    const lastRow = color === WHITE ? 0 : 7;

    const push = (to: Square): void => {
      if (to[0] === lastRow) {
        // 走到最后一排必须升变，四种兵种各是一条**不同的**着法
        for (const t of PROMOTION_TYPES) {
          out.push({ path: [[r, c], to], promotion: promotionLetter(t) });
        }
      } else {
        out.push({ path: [[r, c], to] });
      }
    };

    // 直进一格
    const one = r + dir;
    if (inside(one, c) && this.grid[one][c] === EMPTY) {
      push([one, c]);
      // 直进两格：只在起始排、且中间那格也空
      const two = r + 2 * dir;
      if (r === startRow && this.grid[two][c] === EMPTY) {
        out.push({ path: [[r, c], [two, c]] });
      }
    }

    // 斜吃
    for (const dc of [-1, 1]) {
      const rr = r + dir;
      const cc = c + dc;
      if (!inside(rr, cc)) continue;
      const target = this.grid[rr][cc];
      if (target !== EMPTY && colorOf(target) !== color) {
        push([rr, cc]);
      } else if (target === EMPTY && this.ep && this.ep[0] === rr && this.ep[1] === cc) {
        // 吃过路兵：落点是空格，被吃的兵在**同一行**的相邻列
        out.push({ path: [[r, c], [rr, cc]] });
      }
    }
  }

  /**
   * 王车易位。四条前提都要满足：
   *   1. 王与对应的车都没动过（权利还在）
   *   2. 王与车之间没有子
   *   3. 王**当前**不在被将
   *   4. 王经过的格与落点都不被攻击 —— 注意**车经过的格不管**（b1 可以被攻击）
   */
  private castlingMoves(color: Color, out: MoveInput[]): void {
    const home = color === WHITE ? 7 : 0;
    const king = piece(color, KING);
    const rook = piece(color, ROOK);
    if (this.grid[home][4] !== king) return;

    const kingSide = color === WHITE ? this.castling.wk : this.castling.bk;
    const queenSide = color === WHITE ? this.castling.wq : this.castling.bq;

    if (kingSide && this.grid[home][7] === rook) {
      if (
        this.grid[home][5] === EMPTY &&
        this.grid[home][6] === EMPTY &&
        !this.isAttacked(home, 4, other(color)) &&
        !this.isAttacked(home, 5, other(color)) &&
        !this.isAttacked(home, 6, other(color))
      ) {
        out.push({ path: [[home, 4], [home, 6]] });
      }
    }

    if (queenSide && this.grid[home][0] === rook) {
      // 王走 e1→c1，经过 d1；b1 只要求空，**不要求不被攻击**
      if (
        this.grid[home][1] === EMPTY &&
        this.grid[home][2] === EMPTY &&
        this.grid[home][3] === EMPTY &&
        !this.isAttacked(home, 4, other(color)) &&
        !this.isAttacked(home, 3, other(color)) &&
        !this.isAttacked(home, 2, other(color))
      ) {
        out.push({ path: [[home, 4], [home, 2]] });
      }
    }
  }

  // ── 落子 / 回退 ───────────────────────────────────────────────────────────

  /** 把一手棋落到棋盘上（不做合法性判定 —— 调用方保证它来自 generateMoves）。 */
  private make(move: MoveInput, color: Color): Applied {
    const [from, to] = [move.path[0], move.path[move.path.length - 1]];
    const moving = this.grid[from[0]][from[1]];
    const type = typeOf(moving);

    const applied: Applied = {
      move,
      color,
      captured: EMPTY,
      capturedAt: null,
      rook: null,
      prevCastling: { ...this.castling },
      prevEp: this.ep,
      prevHalfmove: this.halfmove,
      recordedKey: '',
      prevLastMove: this.lastMove,
    };

    const target = this.grid[to[0]][to[1]];

    // 吃过路兵：目标是空格，但斜走的是兵 —— 被吃的兵在起点那一行、终点的列
    if (type === PAWN && from[1] !== to[1] && target === EMPTY) {
      applied.capturedAt = [from[0], to[1]];
      applied.captured = this.grid[from[0]][to[1]];
      this.grid[from[0]][to[1]] = EMPTY;
    } else if (target !== EMPTY) {
      applied.capturedAt = to;
      applied.captured = target;
    }

    this.grid[to[0]][to[1]] = moving;
    this.grid[from[0]][from[1]] = EMPTY;

    // 升变
    if (type === PAWN && (to[0] === 0 || to[0] === SIZE - 1)) {
      const t = promotionType(move.promotion) ?? QUEEN;
      this.grid[to[0]][to[1]] = piece(color, t);
    }

    // 易位：王横走两格，车跟过去
    if (type === KING && Math.abs(to[1] - from[1]) === 2) {
      const rookFrom: Square = [from[0], to[1] > from[1] ? 7 : 0];
      const rookTo: Square = [from[0], to[1] > from[1] ? 5 : 3];
      this.grid[rookTo[0]][rookTo[1]] = this.grid[rookFrom[0]][rookFrom[1]];
      this.grid[rookFrom[0]][rookFrom[1]] = EMPTY;
      applied.rook = { from: rookFrom, to: rookTo };
    }

    // 易位权利：王一动就没了两边；车离开原位就没那一边；
    // 车**被吃**在原位也一样（否则会出现"用对方的权利易位"）
    if (type === KING) {
      if (color === WHITE) {
        this.castling.wk = false;
        this.castling.wq = false;
      } else {
        this.castling.bk = false;
        this.castling.bq = false;
      }
    }
    this.revokeRookRight(from);
    this.revokeRookRight(to);

    // 吃过路兵目标格：只有兵直进两格才设
    if (type === PAWN && Math.abs(to[0] - from[0]) === 2) {
      this.ep = [(from[0] + to[0]) / 2, from[1]];
    } else {
      this.ep = null;
    }

    // 半回合计数：兵动或吃子归零，否则 +1
    this.halfmove = type === PAWN || applied.captured !== EMPTY ? 0 : this.halfmove + 1;

    this.turn = other(color);
    this.lastMove = { path: move.path.map(([r, c]) => [r, c] as Square), player: color };
    applied.recordedKey = this.positionNow();
    this.positions.set(applied.recordedKey, (this.positions.get(applied.recordedKey) ?? 0) + 1);
    this.history.push(applied);
    return applied;
  }

  /** 车离开或被吃出原位 → 该边易位权利作废。 */
  private revokeRookRight([r, c]: Square): void {
    if (r === 7 && c === 0) this.castling.wq = false;
    else if (r === 7 && c === 7) this.castling.wk = false;
    else if (r === 0 && c === 0) this.castling.bq = false;
    else if (r === 0 && c === 7) this.castling.bk = false;
  }

  private unmake(a: Applied): void {
    const [from, to] = [a.move.path[0], a.move.path[a.move.path.length - 1]];
    const moved = this.grid[to[0]][to[1]];

    // 升变：格子上现在是后/车/象/马，要走之前那一步的其实是个兵
    this.grid[from[0]][from[1]] = a.move.promotion ? piece(a.color, PAWN) : moved;
    this.grid[to[0]][to[1]] = EMPTY;

    if (a.capturedAt) {
      this.grid[a.capturedAt[0]][a.capturedAt[1]] = a.captured;
    }
    if (a.rook) {
      this.grid[a.rook.from[0]][a.rook.from[1]] = this.grid[a.rook.to[0]][a.rook.to[1]];
      this.grid[a.rook.to[0]][a.rook.to[1]] = EMPTY;
    }

    this.castling = { ...a.prevCastling };
    this.ep = a.prevEp;
    this.halfmove = a.prevHalfmove;
    this.turn = a.color;
    this.lastMove = a.prevLastMove;

    // 局面计数：按 make 当时记下的那个键减 —— 此刻的 positionNow() 已经是**走之前**
    // 的局面了，拿它去减会减错一个键（计数越走越乱，三次重复随机误判）。
    const n = this.positions.get(a.recordedKey);
    if (n !== undefined) {
      if (n <= 1) this.positions.delete(a.recordedKey);
      else this.positions.set(a.recordedKey, n - 1);
    }

    this.history.pop();
  }

  private positionNow(): string {
    return positionKey(this.grid, this.turn, this.castling, this.ep);
  }

  // ── 终局 ──────────────────────────────────────────────────────────────────

  /** 当前局面下了多少次（含现在这一次）。三次重复判和。 */
  repetitionCount(): number {
    return this.positions.get(this.positionNow()) ?? 1;
  }

  /**
   * 子力不足（死局）。判"双方**都不可能**将死"的常见简版：
   * K vs K、K+轻子 vs K、K+B vs K+B 且象同色。
   * 有兵 / 车 / 后就一定还有将死的可能，直接返回 false。
   */
  insufficientMaterial(): boolean {
    const minors: Array<{ type: PieceType; squareColor: number; color: Color }> = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = this.grid[r][c];
        if (cell === EMPTY) continue;
        const type = typeOf(cell);
        if (type === KING) continue;
        if (type === PAWN || type === ROOK || type === QUEEN) return false;
        minors.push({ type, squareColor: (r + c) % 2, color: colorOf(cell) as Color });
      }
    }
    if (minors.length === 0) return true; // K vs K
    if (minors.length === 1) return true; // K+轻子 vs K
    if (minors.length === 2) {
      const [a, b] = minors;
      // K+B vs K+B 且**两象同色格** → 死局。要求双方各一象：同色两象（只能靠升变
      // 得到）是能杀单王的，把它判成死局会凭空判和。
      return (
        a.type === BISHOP &&
        b.type === BISHOP &&
        a.color !== b.color &&
        a.squareColor === b.squareColor
      );
    }
    return false;
  }

  /**
   * 终局判定。**先判有无着法**（将死 / 逼和），再判各种和棋 ——
   * 将死优先于五十回合：最后一手既将死又凑满 50 回合时，那是赢棋不是和棋。
   */
  private outcomeFor(color: Color): Outcome {
    const moves = this.generateMoves(color);
    const checked = this.inCheck(color);

    if (moves.length === 0) {
      if (checked) {
        const k = this.kingSquare(color);
        return { status: 'won', highlight: k ? [k] : [], reason: 'checkmate' };
      }
      // 逼和 = 和棋。**这不是中国象棋的困毙**（那边无棋可走判负），别混。
      return { status: 'draw', reason: 'stalemate' };
    }

    if (this.halfmove >= 100) return { status: 'draw', reason: 'fifty-move' };
    if (this.insufficientMaterial()) return { status: 'draw', reason: 'insufficient-material' };
    if (this.repetitionCount() >= 3) return { status: 'draw', reason: 'repetition' };

    return { status: 'playing', check: checked ? this.kingSquare(color) : null };
  }

  // ── 房间层接口 ────────────────────────────────────────────────────────────

  /**
   * 走一手。**唯一入口**：解析、判合法、落子、判终局一次完成（见 board-room.ts 的
   * RoomBoard 注释）。非法返回 null 且**棋盘一点没动**。
   */
  submit(player: Player, move: MoveInput): Outcome | null {
    if (player !== this.turn) return null;
    if (!Array.isArray(move.path) || move.path.length !== 2) return null;

    const wanted = moveKey(move);
    const legal = this.generateMoves(this.turn).find((m) => moveKey(m) === wanted);
    // 找不到 = 不合法。**升变没报兵种也走这条** —— 生成出来的升变着法都带 promotion，
    // 报不出兵种就对不上任何一条，于是被拒。服务端不替玩家选后（见文件头）。
    if (!legal) return null;

    this.make(legal, this.turn);
    return this.outcomeFor(this.turn);
  }

  /**
   * perft：数 `depth` 层内的合法着法树节点数。**测试的正确性硬锚**（见文件头）。
   *
   * 用 make/unmake 而不是每节点 clone —— 后者在第 4 层（19 万节点）就慢到进不了 CI。
   * `generateMoves` 内部本来就对每个候选试走再回退，所以这条路已经被走法生成走熟了。
   */
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

/** 'e4' → [4, 4]。 */
function parseSquareName(name: string): Square {
  const col = 'abcdefgh'.indexOf(name[0]);
  const row = 8 - Number(name[1]);
  return [row, col];
}

/** 供测试与 UI 用：这一手是不是升变（客户端据此在提交前弹兵种选择）。 */
export function isPromotionMove(board: ChessBoard, move: MoveInput): boolean {
  if (move.path.length !== 2) return false;
  const [from, to] = [move.path[0], move.path[1]];
  const cell = board.at(from[0], from[1]);
  return typeOf(cell) === PAWN && (to[0] === 0 || to[0] === SIZE - 1);
}

// perft 是 ChessBoard 的一个方法（见类里），因为它必须用私有的 make/unmake ——
// 每个节点 clone 一整张棋盘的话，第 4 层（19 万个节点）就已经慢到不能进 CI 了。

