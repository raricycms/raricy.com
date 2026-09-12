// ─────────────────────────────────────────────────────────────────────────────
// gomoku-room.ts — 五子棋联机的房间注册表与服务端权威判定
//
// 【服务端权威】联网之后客户端不可信（否则直接 POST 一句「我赢了」就行）。
// 棋盘、轮次、胜负全部由这里持有；客户端只渲染服务端下发的 grid。
// 规则跑的是与前端**同一个** gomoku-rules.ts，不存在两份判定。
//
// 【校验与落子之间不得出现 await】单线程 Node + 无 await = 临界区天然原子。
// 日后若为了「把棋谱落库」在 playMove 里插一个 await，两个并发请求会同时通过
// 轮次检查，同一格被落两次子 —— 这类 bug 只在生产并发下复现，本地怎么点都没事。
//
// 【状态放进程内存】与 chat-bus 同一前提：单进程部署，重启即失、多实例不共享。
// 这是**已知限制不是 bug**（见 docs/architecture.md §10）。房间没进数据库是有意的 ——
// 一局棋是短命会话，为它加表要连带迁移、清理与软删除口径，收益不抵成本。
//
// 【时间戳全是 Date.now() 的 number】不构造 Date 对象，天然不触发 db-time-guard。
// 这些是**真实瞬间**（算掉线时长、TTL），不是库里那种「UTC+8 贴 Z 标签」的墙上时间。
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLACK,
  GomokuBoard,
  WHITE,
  type Player,
} from './gomoku-rules';
import { closeRoom, connectionsIn, publishToRoom, roomConnections } from './game-bus';
import {
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  type GomokuRoomSnapshot,
  type GomokuRoomView,
  type GomokuStreamEvent,
  type RoomRole,
  type RoomStatus,
  type Seat,
  type SeatView,
} from './gomoku-shared';

/** 同时存在的房间上限：内存是无界资源，匿名可玩的功能必须有天花板。 */
const MAX_ROOMS = 200;
/** 单房观众上限。 */
const MAX_SPECTATORS = 20;
/** 空闲 TTL：这么久没有任何活动（走子/加入/连接）就回收。 */
const IDLE_TTL_MS = 30 * 60 * 1000;
/** 空房 TTL：一个人都没连着且没走过子，这么快就回收（挡脚本批量建房占码）。 */
const EMPTY_TTL_MS = 2 * 60 * 1000;
/** 对手掉线满这么久，本方可以判胜。 */
const DISCONNECT_CLAIM_MS = 60 * 1000;
/** 清扫节拍。 */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** 调用方身份。name 只用于展示（座位栏），userId 才是身份。 */
export interface RoomUser {
  id: string;
  name: string;
}

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

interface SeatHolder {
  userId: string;
  name: string;
  /** null = 在线。否则是掉线那一刻的 ms。 */
  disconnectedAt: number | null;
}

interface Room {
  code: string;
  board: GomokuBoard;
  status: RoomStatus;
  turn: Player;
  winner: Seat | null;
  winningLine: Array<[number, number]>;
  seats: { black: SeatHolder | null; white: SeatHolder | null };
  spectators: Set<string>;
  rematchVotes: Set<string>;
  createdAt: number;
  lastActivityAt: number;
  /** 单调递增，**永不重置**（含再来一局）—— 客户端据此丢弃过期的全量状态。 */
  revision: number;
}

interface RegistryState {
  rooms: Map<string, Room>;
  timer: ReturnType<typeof setInterval> | null;
}

// 挂 globalThis：Next dev 的热更新会重新求值模块，模块级 Map 会被清空，
// 已建立的 SSE 连接就成了孤儿（房间还在服务端但再也收不到推送）。同 chat-bus。
const globalForRooms = globalThis as unknown as { __gomokuRooms?: RegistryState };
const state: RegistryState = (globalForRooms.__gomokuRooms ??= {
  rooms: new Map(),
  timer: null,
});

// ── 内部小工具 ──────────────────────────────────────────────────────────────

function seatOf(room: Room, userId: string): Seat | null {
  if (room.seats.black?.userId === userId) return 'black';
  if (room.seats.white?.userId === userId) return 'white';
  return null;
}

function otherSeat(seat: Seat): Seat {
  return seat === 'black' ? 'white' : 'black';
}

function seatView(holder: SeatHolder | null): SeatView | null {
  if (!holder) return null;
  return { name: holder.name, connected: holder.disconnectedAt === null };
}

/** 组装公开状态。**不含「你是谁」** —— 那一份由 snapshotFor 单独给。 */
function viewOf(room: Room, now: number): GomokuRoomView {
  return {
    code: room.code,
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    winningLine: room.winningLine.map(([r, c]) => [r, c] as [number, number]),
    grid: room.board.grid.map((row) => row.slice()),
    lastMove: room.board.getLastMove(),
    seats: { black: seatView(room.seats.black), white: seatView(room.seats.white) },
    spectatorCount: room.spectators.size,
    rematchVotes: room.rematchVotes.size,
    revision: room.revision,
    now,
  };
}

function snapshotFor(room: Room, userId: string, now: number): GomokuRoomSnapshot {
  const seat = seatOf(room, userId);
  const role: RoomRole = seat ? 'player' : 'spectator';
  return { view: viewOf(room, now), you: { role, seat } };
}

/** 推一次全量状态。所有变更路径都走它，不存在「改了但忘了推」。 */
function publishState(room: Room, now: number): void {
  publishToRoom<GomokuStreamEvent>(room.code, { type: 'state', view: viewOf(room, now) });
}

function touch(room: Room, now: number): void {
  room.lastActivityAt = now;
  room.revision++;
}

/** 房号生成：随机取 6 位，撞了就重试。 */
function generateCode(): string | null {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!state.rooms.has(code)) return code;
  }
  return null; // 理论上到不了（31^6 的空间 + 200 房上限）
}

// ── 对外操作 ────────────────────────────────────────────────────────────────

/** 建房：建房者执黑先手，状态 waiting 等对手。 */
export function createRoom(
  user: RoomUser,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  if (state.rooms.size >= MAX_ROOMS) return { ok: false, error: 'tooManyRooms' };

  const code = generateCode();
  if (!code) return { ok: false, error: 'tooManyRooms' };

  const room: Room = {
    code,
    board: new GomokuBoard(),
    status: 'waiting',
    turn: BLACK,
    winner: null,
    winningLine: [],
    seats: { black: { userId: user.id, name: user.name, disconnectedAt: now }, white: null },
    // ↑ 建房者此刻还没连上 SSE，先当掉线；SSE 一订阅就 refreshPresence 转在线。
    //   这样「建完房没连上就跑了」不会留下一个显示在线的假席位。
    spectators: new Set(),
    rematchVotes: new Set(),
    createdAt: now,
    lastActivityAt: now,
    revision: 1,
  };
  state.rooms.set(code, room);
  ensureSweeper();
  return { ok: true, value: snapshotFor(room, user.id, now) };
}

/**
 * 加入房间。**幂等**：已在座/已在观众席的调用者拿回原有身份，不重置任何状态。
 * 这条同时免费提供了「刷新页面回到原座」与「断线重连不丢座」。
 */
export function joinRoom(
  code: string,
  user: RoomUser,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };

  // 已在座 / 已在观众席 → 原样返回（幂等）。
  // 只续 lastActivityAt（免得房间被当成空闲回收），**不动 revision、不推流** ——
  // 状态没有任何变化，推一帧空的只会让所有客户端的「丢弃过期状态」判断白白抖动。
  // 这条路径正是「刷新页面回到原座」与「断线重连」走的，必须零副作用。
  if (seatOf(room, user.id) || room.spectators.has(user.id)) {
    room.lastActivityAt = now;
    return { ok: true, value: snapshotFor(room, user.id, now) };
  }

  // 还有空位就入座（黑先占，白次之）。只在 waiting 时开放入座 ——
  // 对局进行中不让新人顶替掉线者的位置（那等于偷走别人的局）。
  if (room.status === 'waiting') {
    const free: Seat | null = room.seats.black === null ? 'black' : room.seats.white === null ? 'white' : null;
    if (free) {
      room.seats[free] = { userId: user.id, name: user.name, disconnectedAt: now };
      if (room.seats.black && room.seats.white) {
        room.status = 'playing';
        // 双方就位，白方等黑方落子
        room.turn = BLACK;
      }
      touch(room, now);
      publishState(room, now);
      return { ok: true, value: snapshotFor(room, user.id, now) };
    }
  }

  // 满员 → 观众
  if (room.spectators.size >= MAX_SPECTATORS) return { ok: false, error: 'tooManySpectators' };
  room.spectators.add(user.id);
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, user.id, now) };
}

/** 取快照（重连 / 刷新 / 只读观战都走它）。不改变任何状态。 */
export function getSnapshot(
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 走子。**校验与落子之间不得 await**（见文件头）。
 * 校验顺序刻意从便宜到贵：房间 → 在座 → 对局中 → 轮次 → 合法性。
 */
export function playMove(
  code: string,
  userId: string,
  row: number,
  col: number,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' }; // 观众不能走子

  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  const turnSeat: Seat = room.turn === BLACK ? 'black' : 'white';
  if (seat !== turnSeat) return { ok: false, error: 'notYourTurn' };

  if (!Number.isInteger(row) || !Number.isInteger(col)) return { ok: false, error: 'illegalMove' };
  if (!room.board.isValidMove(row, col)) return { ok: false, error: 'illegalMove' };

  // ── 临界区开始：到 publish 为止不得出现 await ──
  room.board.placeStone(row, col, room.turn);

  const win = room.board.checkWinAt(row, col, room.turn);
  if (win.won) {
    room.status = 'won';
    room.winner = seat;
    room.winningLine = win.line;
  } else if (room.board.isFull()) {
    room.status = 'draw';
    room.winner = null;
    room.winningLine = [];
  } else {
    room.turn = room.turn === BLACK ? WHITE : BLACK;
  }
  // ── 临界区结束 ──

  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/** 认输。对局进行中才可用。 */
export function resign(
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  room.status = 'won';
  room.winner = otherSeat(seat);
  room.winningLine = [];
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 对手掉线满 DISCONNECT_CLAIM_MS 后判胜。
 * **不做服务端定时器**（少一类状态机 bug）：时间由服务端在这里复核，
 * 所以客户端伪造不了「已经过了 60 秒」。
 */
export function claimAbandoned(
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  const opponent = room.seats[otherSeat(seat)];
  if (!opponent) return { ok: false, error: 'notPlaying' };
  if (opponent.disconnectedAt === null) return { ok: false, error: 'opponentPresent' };
  if (now - opponent.disconnectedAt < DISCONNECT_CLAIM_MS) {
    return { ok: false, error: 'notDisconnectedLongEnough' };
  }

  room.status = 'won';
  room.winner = seat;
  room.winningLine = [];
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 投票「再来一局」。双方各点一次即重开。
 * **保持同色不换先** —— 换先要引入席位与颜色的映射，边界情况多而收益为零。
 */
export function requestRematch(
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<GomokuRoomSnapshot> {
  const room = state.rooms.get(code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'won' && room.status !== 'draw') {
    return { ok: false, error: 'nothingToRematch' };
  }

  room.rematchVotes.add(userId);

  if (room.rematchVotes.size >= 2) {
    room.board.reset();
    room.status = 'playing';
    room.turn = BLACK;
    room.winner = null;
    room.winningLine = [];
    room.rematchVotes.clear();
  }
  // revision 继续递增，**不重置** —— 重置会让客户端的「丢弃过期状态」判断失效
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 连接数变化后重算席位在线状态，并向全房广播。
 * SSE 路由在 subscribe 之后与 unsubscribe 之后各调一次。
 * 观众不占席位，不进这里（他们的进出只影响 spectatorCount，由 join 处理）。
 */
export function refreshPresence(code: string, userId: string, now = Date.now()): void {
  const room = state.rooms.get(code);
  if (!room) return;

  const seat = seatOf(room, userId);
  if (!seat) return;
  const holder = room.seats[seat];
  if (!holder) return;

  const connected = connectionsIn(code, userId) > 0;
  const wasConnected = holder.disconnectedAt === null;
  if (connected === wasConnected) return; // 无变化，不推流

  holder.disconnectedAt = connected ? null : now;
  touch(room, now);
  publishState(room, now);
}

// ── 回收 ────────────────────────────────────────────────────────────────────

/**
 * 清扫：空房快回收，空闲房慢回收。
 * 回收时关掉该房全部 SSE 连接 —— 客户端会重连拿到 404，据此显示「房间已失效」。
 */
export function sweepRooms(now = Date.now()): void {
  for (const [code, room] of [...state.rooms]) {
    const idleFor = now - room.lastActivityAt;
    const empty = roomConnections(code) === 0;

    if (empty && idleFor >= EMPTY_TTL_MS) {
      state.rooms.delete(code);
      closeRoom(code);
      continue;
    }
    if (idleFor >= IDLE_TTL_MS) {
      state.rooms.delete(code);
      closeRoom(code);
    }
  }
  if (state.rooms.size === 0) stopSweeper();
}

function ensureSweeper(): void {
  if (state.timer) return;
  state.timer = setInterval(() => sweepRooms(), SWEEP_INTERVAL_MS);
  // 不因定时器拖住进程退出（测试 / 优雅重启）。同 chat-bus。
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

function stopSweeper(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

// ── 仅供测试 ────────────────────────────────────────────────────────────────

export function __resetGomokuRooms(): void {
  for (const code of [...state.rooms.keys()]) closeRoom(code);
  state.rooms.clear();
  stopSweeper();
}

/** 仅供测试：当前房间数 / 取房间（断言内部状态用）。 */
export function __roomCount(): number {
  return state.rooms.size;
}

export const __constants = {
  MAX_ROOMS,
  MAX_SPECTATORS,
  IDLE_TTL_MS,
  EMPTY_TTL_MS,
  DISCONNECT_CLAIM_MS,
} as const;
