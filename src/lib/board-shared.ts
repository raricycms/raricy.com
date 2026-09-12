// ─────────────────────────────────────────────────────────────────────────────
// board-shared.ts — 联机棋类的**通用协议**：房间码、席位、DTO、SSE 事件（前后端共享）
//
// 【为什么抽通用】所有联机棋类的房间生命周期**完全一致**（建房 / 入座 / 观战 /
// 掉线判胜 / 再来一局 / TTL 回收），差别只在棋盘规则。所以房间层（board-room.ts）
// 与协议层（本文件）只写一份，各游戏只提供自己的 rules 模块
// ——两边各写一份房间逻辑必然 drift，而且是静默的那种（同 gomoku-rules 的口径）。
//
// 【两类棋】房间层托管两类棋盘，差别只有「一手棋怎么表达、怎么判终局」：
//   • 落子类（五子棋 / 井字棋）：`path` 只有一格；胜负是"最后一手连成一条线"。
//   • 走子类（中国象棋 / 国际象棋 / 国际跳棋）：`path` 是起点→终点（连吃则更长）；
//     目标格可以是敌子（吃子）；胜负是**整盘**判定（将死 / 无棋可走），与最后一手
//     落在哪儿无关。
// 房间层自己不解释 `grid` 里放的是什么 —— 各棋自定编码（见 Cell 的注释），
// 它只负责原样转发与服务端权威。
//
// 【零依赖】不得 import prisma / next/headers / server-only，也不得 import
// board-room.ts（那是服务端模块）—— 客户端组件要直接引用这里的类型与
// normalizeRoomCode。board-room.ts 反过来 import 本文件，方向单向。
//
// 【协议：每次变化都推全量状态】最大棋盘 15×15 = 225 格（约 1KB JSON），而一局
// 走子间隔以秒计；走子类的棋盘反而更小（象棋 9×10、国际象棋 8×8、跳棋 10×10）。
// 全量推送换来的是**没有增量协议的那一整类 bug**：漏推、乱序、断线后增量对不上。
// 断线重连也不需要 Last-Event-ID 补齐 —— SSE 一连上服务端就推一次当前状态，
// 客户端按 revision 丢弃过期的即可。
// 因此这里没有 delta 事件、没有环形缓冲、没有 resync。**也不要为了"判重复局面"
// 把着法历史塞进 DTO** —— 那是棋盘私有状态，过线的只有 endReason。
// ─────────────────────────────────────────────────────────────────────────────

/** 房间码长度。 */
export const ROOM_CODE_LENGTH = 6;

/**
 * 房间码字母表：31 个字符，剔掉 0/o/1/l/i —— 房号要靠人念、手抄、发消息，
 * 这五个字符是抄错的主要来源。约 8.9e8 种组合。
 * 展示用大写，存储与 URL 一律小写（normalizeRoomCode 归一小写）。
 */
export const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/**
 * 把用户输入/URL 参数规范化成房间码；非法返回 null。
 * 容忍用户抄成大写、带空格或连字符、粘贴时带上首尾空白。
 */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ROOM_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

// ── 棋盘口径 ────────────────────────────────────────────────────────────────
// 【空格是全局唯一的公共值】`EMPTY = 0` 对每一款棋都是"这一格没有子"。
// 除此之外的取值**由各棋自己定义**，房间层一概不解释：
//   • 五子棋 / 井字棋：1 = 先手子，2 = 后手子（一格只可能是这两者之一）
//   • 走子类：自己编（颜色 + 兵种，如 `color * 8 + type`）
// 所以 `Cell` 只是 `number`。**客户端渲染前必须按本游戏的编码收窄**（见各游戏
// 组件里的 `asXxxGrid`）—— 收到一个本棋不认识的数就当空格 / 报错，别让它
// 落进渲染分支：五子棋的画布把"非黑"一律当白子画，一个野生数字会静默变成白棋。

export const EMPTY = 0;
export const FIRST = 1;
export const SECOND = 2;
export type Cell = number;
/** 落子类棋的格子取值。走子类棋不用这个类型，自己定编码。 */
export type PlacementCell = typeof EMPTY | typeof FIRST | typeof SECOND;
export type Player = typeof FIRST | typeof SECOND;

/** 棋盘坐标 `[行, 列]`。 */
export type Square = [number, number];

/** 坐标是否是「两个整数」。盘内与否由各棋棋盘自己判（它才知道自己是 9×10 还是 8×8）。 */
export function isIntegerSquare(sq: unknown): sq is Square {
  return (
    Array.isArray(sq) &&
    sq.length === 2 &&
    Number.isInteger(sq[0]) &&
    Number.isInteger(sq[1])
  );
}

/**
 * 客户端提交的一手棋。**整手一次提交，没有半步状态。**
 *
 * - `path`：走过的格子，含起点与终点。
 *   - 长度 1 = 落子（五子棋 / 井字棋）——只有终点，没有起点。
 *   - 长度 2 = 普通走子（象棋 / 国际象棋的绝大多数着法）。
 *   - 长度 > 2 = 连吃（国际跳棋的兵连跳、王的飞吃连跳）。
 *   为什么把多步棋压成一条路径而不是拆成几次请求：半步状态会让棋盘停在
 *   "一个不存在的局面"上，而全量推送的前提正是"服务端手里的 grid 永远是一个
 *   合法局面"；何况还得再配一套"这半步多久没人管就作废"的超时，与掉线判胜 /
 *   TTL 回收 / 再来一局全都要交互。整条路径一次提交，这些统统不存在。
 *
 * - `promotion`：升变选择，只在国际象棋用（`'q'|'r'|'b'|'n'`）。
 *   **不是可选的**：走到升变却报不出兵种，服务端一律按非法着法拒绝，**不替玩家
 *   选后**。理由有两条：一是升变成马有时是唯一的赢法（抽将），替玩家选后就等于
 *   下错了一盘棋；二是联机没有悔棋，选错了收不回来。客户端跑的是同一份规则模块，
 *   它自己就知道这一手要不要升变，所以"拒绝"不会让正常玩家卡住。
 */
export interface MoveInput {
  path: Square[];
  promotion?: string;
}

/** 已走的一手（房间里公开的信息，供客户端高亮）。 */
export interface Move {
  path: Square[];
  player: Player;
}

/** 一手棋的起点；落子类棋没有起点。 */
export function moveFrom(move: Move | MoveInput): Square | null {
  return move.path.length > 1 ? move.path[0] : null;
}

/** 一手棋的终点。 */
export function moveTo(move: Move | MoveInput): Square {
  return move.path[move.path.length - 1];
}

/**
 * 终局原因。**类型化的联合而不是自由字符串** —— 两条理由：
 *   1. 它要过线（RoomView.endReason），自由字符串迟早会把中文 UI 文案写进协议，
 *      而协议是前后端共用、还带零依赖约束的模块；
 *   2. 光有和棋原因不够：**赢棋也有原因**。认输与掉线判胜在 RoomView 里同样是
 *      `winner` 非空，客户端分不出「将死」与「对手认输」，只能靠"highlight 是不是
 *      空的"这种没人写下来的约定去猜。
 * 前一段是各棋棋盘产生的，后一段是房间层写的（认输 / 判胜与棋盘无关）。
 */
export type EndReason =
  // ── 落子类 ──
  | 'line' // 连成线（五连 / 三连）
  | 'board-full' // 下满无连线
  // ── 走子类 ──
  | 'checkmate' // 将死
  | 'stalemate' // 逼和：无棋可走且未被将军 → **和棋**（仅国际象棋）
  | 'no-moves' // 无棋可走 → **判负**（象棋困毙 / 跳棋走不动）
  | 'fifty-move' // 国际象棋：50 回合无吃子无兵动
  | 'insufficient-material' // 国际象棋：子力不足
  | 'repetition' // 三次重复局面
  | 'no-capture' // 象棋：60 回合无吃子
  | 'perpetual-check' // 象棋：长将判负
  // ── 房间层（与棋盘无关，由 board-room 写入）──
  | 'resign' // 认输
  | 'abandoned'; // 掉线判胜

/**
 * 一手棋走完之后的局面。
 *
 * 【为什么判定放在"走完之后"而不是"某一格连线"】落子类棋看最后一手就能判胜负，
 * 走子类棋不行：将死取决于**整盘**有没有解，与最后一手落在哪儿无关。
 * 统一成"走完这一手，局面是什么"，两类棋就都装得下了。
 *
 * `check`：走完之后**轮到走棋那一方**是否正被将军（被将军的王的格子）。落子类棋恒为 null。
 * `highlight`：高亮用的格子。落子类是成五 / 成三的那条线；走子类通常只有被将死的王一格。
 */
export type Outcome =
  | { status: 'playing'; check: Square | null }
  /**
   * `winner` **必须显式给出，不能默认是刚走完的那一方**。绝大多数终局确实是
   * "走的人赢了"（将死 / 困毙 / 连成线），但**长将判负是走的人输** —— 一直在将军
   * 的那方判负，而判终局正是在他刚走完那一刻触发的。靠约定去推就会把长将的胜负
   * 判反，而那是一个只有下出长将才暴露、且双方都觉得自己赢了的错误。
   */
  | { status: 'won'; winner: Player; highlight: Square[]; reason: EndReason }
  | { status: 'draw'; reason: EndReason };

/**
 * 席位 id。**它是"第几个座位"，不是棋子的颜色** —— 先手方在各棋里颜色不同：
 * 五子棋执黑、井字棋执 X、**中国象棋执红**、国际象棋与国际跳棋执白。
 * 所以 `winner: 'black'` 在象棋里读作「红方胜」，`data-seat="black"` 选中的是红棋。
 * 颜色与记号的映射由各游戏自己做（见各游戏组件里的 SEAT_LABEL 一类常量），
 * 本层不掺和 —— 一旦这里改叫 `red`，五子棋那边就得反过来解释。
 */
export type Seat = 'black' | 'white';

/** `1 → black`、`2 → white`。房间层唯一一处席位/先手的映射。 */
export function seatOfPlayer(player: Player): Seat {
  return player === FIRST ? 'black' : 'white';
}

/** `black → 1`、`white → 2`。 */
export function playerOfSeat(seat: Seat): Player {
  return seat === 'black' ? FIRST : SECOND;
}

export function otherSeat(seat: Seat): Seat {
  return seat === 'black' ? 'white' : 'black';
}

export type RoomStatus = 'waiting' | 'playing' | 'won' | 'draw';
export type RoomRole = 'player' | 'spectator';

/**
 * 游戏种类。房间注册表是**所有游戏共用**的一张表（房号因此全局唯一，不会
 * 出现「井字棋的房间码撞上五子棋的房间码」），每条路由据此校验自己拿到的
 * 房间是不是本游戏的 —— 拿错了按 notFound 处理，不泄露「这个房号存在」。
 */
export type RoomKind = 'gomoku' | 'tictactoe' | 'xiangqi' | 'chess' | 'draughts';

/** 席位在快照里的公开信息 —— **绝不含 userId**。 */
export interface SeatView {
  name: string;
  connected: boolean;
  /**
   * 已掉线多久（ms）；在线时为 null。
   * **由服务端算**（now - disconnectedAt）而不是让客户端拿时间戳自己减：
   * 客户端的钟可能偏，而且刷新页面后光有 connected 是推不出「等了多久」的 ——
   * 那会让判胜按钮永远不出现。客户端收到后按本地计时继续累加。
   */
  disconnectedForMs: number | null;
}

/**
 * 房间的公开状态。同一房间里所有连接收到的都是这一份（走子是公开信息），
 * 因此**不含「你是谁」** —— 角色由 join / 快照接口单独返回（见 RoomSnapshot）。
 */
export interface RoomView {
  code: string;
  kind: RoomKind;
  status: RoomStatus;
  /** 轮到谁走（1 = 先手席）。终局时无意义。 */
  turn: Player;
  winner: Seat | null;
  /** 终局原因；对局中为 null。见 EndReason —— 客户端据此分辨「将死」与「对手认输」。 */
  endReason: EndReason | null;
  /** 高亮格：落子类是成线的那几格，走子类通常是被将死的王。由棋盘给出，认输 / 判胜时为空。 */
  highlight: Square[];
  /** 服务端权威棋盘。客户端只渲染，不据此判定。取值语义由各棋自己定义。 */
  grid: Cell[][];
  /**
   * 棋盘尺寸。**是 rows/cols 而不是单个 size** —— 中国象棋是 9 列 × 10 行，
   * 用一个 size 表达不了，而"棋盘是方的"这个假设一旦写进协议就很难再拿掉。
   */
  rows: number;
  cols: number;
  lastMove: Move | null;
  /** 轮到走棋那一方正被将军时，是被将的王所在格；否则 null。落子类棋恒为 null。 */
  check: Square | null;
  seats: { black: SeatView | null; white: SeatView | null };
  spectatorCount: number;
  /** 已经点了「再来一局」的人数（满 2 即重开）。 */
  rematchVotes: number;
  /** 单调递增，永不重置（含再来一局）。客户端据此丢弃过期的全量状态。 */
  revision: number;
  /** 服务端此刻的时间（ms），供客户端算「对手掉线多久了」。 */
  now: number;
}

/** join / 快照接口的返回：公开状态 + 「你是谁」。 */
export interface RoomSnapshot {
  view: RoomView;
  you: { role: RoomRole; seat: Seat | null };
}

/** SSE 事件。只有全量状态一种，理由见文件头。 */
export type RoomStreamEvent = { type: 'state'; view: RoomView };

/** 房间操作的失败原因。各游戏的 service 与路由共用同一套（→ HTTP 映射见 api/game/_shared.ts）。 */
export type RoomError =
  | 'notFound'
  | 'notASeat'
  | 'notPlaying'
  | 'notYourTurn'
  | 'illegalMove'
  | 'tooManyRooms'
  | 'tooManySpectators'
  | 'opponentPresent'
  | 'notDisconnectedLongEnough'
  | 'nothingToRematch';

export type RoomResult<T> = { ok: true; value: T } | { ok: false; error: RoomError };
