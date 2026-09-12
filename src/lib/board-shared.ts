// ─────────────────────────────────────────────────────────────────────────────
// board-shared.ts — 联机棋类的**通用协议**：房间码、席位、DTO、SSE 事件（前后端共享）
//
// 【为什么抽通用】五子棋与井字棋的房间生命周期**完全一致**（建房 / 入座 / 观战 /
// 掉线判胜 / 再来一局 / TTL 回收），差别只在棋盘规则与格子尺寸。所以房间层
// （board-room.ts）与协议层（本文件）只写一份，各游戏只提供自己的 rules 模块
// ——两边各写一份房间逻辑必然 drift，而且是静默的那种（同 gomoku-rules 的口径）。
//
// 【零依赖】不得 import prisma / next/headers / server-only，也不得 import
// board-room.ts（那是服务端模块）—— 客户端组件要直接引用这里的类型与
// normalizeRoomCode。board-room.ts 反过来 import 本文件，方向单向。
//
// 【协议：每次变化都推全量状态】棋盘最大 15×15 = 225 格（约 1KB JSON），而一局
// 走子间隔以秒计。全量推送换来的是**没有增量协议的那一整类 bug**：漏推、乱序、
// 断线后增量对不上。断线重连也不需要 Last-Event-ID 补齐 —— SSE 一连上服务端就
// 推一次当前状态，客户端按 revision 丢弃过期的即可。
// 因此这里没有 delta 事件、没有环形缓冲、没有 resync。
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
// 两个游戏共用同一套格子取值：0 空、1 先手、2 后手。五子棋的 1/2 就是黑白子，
// 井字棋的 1/2 就是 X/O —— 各自的 rules 模块用自己的名字（BLACK/WHITE、X/O）
// 重新导出这些字面量，但**值必须一致**：房间层靠「1 = 先手席（black）」这条
// 不变量把 turn 映射到席位。

export const EMPTY = 0;
export const FIRST = 1;
export const SECOND = 2;
export type Cell = typeof EMPTY | typeof FIRST | typeof SECOND;
export type Player = typeof FIRST | typeof SECOND;

export type Move = { row: number; col: number; player: Player };

/** 席位。黑 = 先手（建房者），白 = 后手。 */
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
 * 游戏种类。房间注册表是**两个游戏共用**的一张表（房号因此全局唯一，不会
 * 出现「井字棋的房间码撞上五子棋的房间码」），每条路由据此校验自己拿到的
 * 房间是不是本游戏的 —— 拿错了按 notFound 处理，不泄露「这个房号存在」。
 */
export type RoomKind = 'gomoku' | 'tictactoe';

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
  winningLine: Array<[number, number]>;
  /** 服务端权威棋盘。客户端只渲染，不据此判定。 */
  grid: Cell[][];
  /** 棋盘边长（grid.length 的显式版本，免得客户端各处自己数）。 */
  size: number;
  lastMove: Move | null;
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
