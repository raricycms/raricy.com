// ─────────────────────────────────────────────────────────────────────────────
// board-room.ts — 联机棋类的**通用房间注册表**与服务端权威判定
//
// 【服务端权威】联网之后客户端不可信（否则直接 POST 一句「我赢了」就行）。
// 棋盘、轮次、胜负全部由这里持有；客户端只渲染服务端下发的 grid。
// 规则跑的是**各游戏自己的 rules 模块**，而且前端与服务端共用同一份 ——
// 不存在两份判定。
//
// 【校验与落子之间不得出现 await】单线程 Node + 无 await = 临界区天然原子。
// 这条**由接口形状保证，不只靠注释**：棋盘只暴露一个 `submit()`，解析、判合法、
// 落子、判终局一次完成，房间层没有"先校验再落子"两步可拆，也就没有地方能插进
// 一个 await（"顺手把棋谱落个库"是最容易发生的那次）。半步状态同理不存在：
// 多步棋（跳棋连吃）整条路径一次提交。
// 见 docs/architecture.md §6.9。
//
// 【两类棋共用这一层】落子类（五子棋 / 井字棋）与走子类（象棋 / 国际象棋 /
// 国际跳棋）的房间生命周期一字不差：建房 / 入座 / 观战 / 掉线判胜 / 再来一局 /
// TTL 回收 / revision 语义。差别只有「一手棋怎么表达、怎么判终局」，那条轴由
// RoomBoard 抽象掉（见其注释）。**别在这里按 kind 分支** —— 一旦有第一个分支，
// 后面每加一款棋都会在这里多一个 if，房间层就退化成五个游戏的大杂烩。
//
// 【状态放进程内存】与 chat-bus 同一前提：单进程部署，重启即失、多实例不共享。
// 这是**已知限制不是 bug**（见 docs/architecture.md §10）。房间没进数据库是有意的 ——
// 一局棋是短命会话，为它加表要连带迁移、清理与软删除口径，收益不抵成本。
//
// 【多种棋共用一张表】房号因此全局唯一，`kind` 字段标明归属；每条对外操作都要求
// 调用方声明自己期望的 kind，对不上按 notFound 处理 —— 井字棋的路由拿不到五子棋的
// 房间，也不会泄露「这个房号存在，只是不属于你」。
//
// 【时间戳全是 Date.now() 的 number】不构造 Date 对象，天然不触发 db-time-guard。
// 这些是**真实瞬间**（算掉线时长、TTL），不是库里那种「UTC+8 贴 Z 标签」的墙上时间。
// ─────────────────────────────────────────────────────────────────────────────

import { closeRoom, connectionsIn, publishToRoom, roomConnections } from './game-bus';
import {
  FIRST,
  SECOND,
  isIntegerSquare,
  type Cell,
  type EndReason,
  type Move,
  type MoveInput,
  type Outcome,
  type Player,
  type RoomError,
  type RoomKind,
  type RoomResult,
  type RoomRole,
  type RoomSnapshot,
  type RoomStatus,
  type RoomStreamEvent,
  type RoomView,
  type Seat,
  type SeatView,
  type Square,
  otherSeat,
  seatOfPlayer,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
} from './board-shared';

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

/**
 * 房间层用得上的棋盘能力。**结构性接口**：各游戏的 Board 类按这个形状写即可，
 * 不必 implements。
 *
 * 【为什么只有 submit 一个动作方法】把"校验 / 落子 / 判终局"合成一次调用：
 *   • 原子性从"注释约定"变成"接口上做不到别的"（见文件头）；
 *   • 走子类的合法性判定本来就要看**整个局面**（走后不能自将、飞将、易位穿将），
 *     `isValidMove` 与 `applyMove` 拆开只会诱使实现者把 `inCheck` 之类的结果缓存
 *     在两步之间 —— 那个缓存既容易过期，又会在浏览器里跑（同一份规则前端也用）；
 *   • 非法着法有了统一的出口：返回 null 且**保证棋盘没被改动**，房间层不必关心
 *     实现者是不是先落子后判错。
 *
 * 【submit 的契约】对**任何**输入都不抛异常；不合法返回 null 且不改变棋盘。
 * 这条由各棋的规则测试兜（见 tests/unit/*-rules.test.ts 的 fuzz 用例）——
 * 抛异常会让房间停在"棋盘改了但轮次没翻"的永久错位状态上。
 *
 * 【reset 的语义】回到开局。走子类棋必须连易位权利 / 吃过路兵目标格 / 半回合计数 /
 * 重复局面历史一起清掉 —— 漏掉的表现是"再来一局后还能易位"。房间层自己不用它
 * （再来一局是换一张新棋盘，见 requestRematch），单机的"新对局"用。
 */
export interface RoomBoard {
  readonly rows: number;
  readonly cols: number;
  grid: Cell[][];
  /** 回到开局。见上面 reset 的语义。 */
  reset(): void;
  /**
   * 走一手。`player` 是**走这一手的人**（房间层已校验过轮次）。
   * 判终局要判的是**对手**还有没有解 —— 别拿"当前该谁走"去判，会差一步。
   */
  submit(player: Player, move: MoveInput): Outcome | null;
  getLastMove(): Move | null;
  /**
   * **可选**：`color` 的全部合法着法，会随每次全量状态下发给客户端做高亮。
   *
   * 走子类棋必须实现 —— 它们的合法着法取决于棋盘**之外**的状态（易位权利、
   * 吃过路兵目标格、重复局面历史），客户端光看 grid 推不出来，刷新或重连之后
   * 更推不出来（DTO 里没有着法历史）。落子类棋不必实现：空格点下去就行，
   * 客户端自己看 grid 就知道哪格能落。
   */
  generateMoves?(color: Player): MoveInput[];
}

/**
 * 一种棋的规格：房间层只需要知道怎么造一张空棋盘，别的（尺寸、走法、胜负）由棋盘
 * 自己带着 —— 与其把 rows/cols 之类的参数透传一路，不如让棋盘自己说了算。
 * （`createBoard` 同时是"再来一局"的实现：换一张新棋盘，比 reset 少一整类漏字段的 bug。）
 */
export interface GameDefinition {
  kind: RoomKind;
  createBoard(): RoomBoard;
}

interface SeatHolder {
  userId: string;
  name: string;
  /** null = 在线。否则是掉线那一刻的 ms。 */
  disconnectedAt: number | null;
}

interface Room {
  code: string;
  kind: RoomKind;
  board: RoomBoard;
  status: RoomStatus;
  turn: Player;
  winner: Seat | null;
  endReason: EndReason | null;
  highlight: Square[];
  check: Square | null;
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
const globalForRooms = globalThis as unknown as { __boardRooms?: RegistryState };
const state: RegistryState = (globalForRooms.__boardRooms ??= {
  rooms: new Map(),
  timer: null,
});

// ── 内部小工具 ──────────────────────────────────────────────────────────────

function seatOf(room: Room, userId: string): Seat | null {
  if (room.seats.black?.userId === userId) return 'black';
  if (room.seats.white?.userId === userId) return 'white';
  return null;
}

function seatView(holder: SeatHolder | null, now: number): SeatView | null {
  if (!holder) return null;
  return {
    name: holder.name,
    connected: holder.disconnectedAt === null,
    disconnectedForMs: holder.disconnectedAt === null ? null : now - holder.disconnectedAt,
  };
}

/** 组装公开状态。**不含「你是谁」** —— 那一份由 snapshotFor 单独给。 */
function viewOf(room: Room, now: number): RoomView {
  return {
    code: room.code,
    kind: room.kind,
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    endReason: room.endReason,
    highlight: room.highlight.map(([r, c]) => [r, c] as Square),
    // 逐行浅拷贝：客户端拿到的那份改不动服务端棋盘
    grid: room.board.grid.map((row) => row.slice()),
    rows: room.board.rows,
    cols: room.board.cols,
    lastMove: room.board.getLastMove(),
    // 合法着法由棋盘自己算（走子类棋依赖棋盘之外的状态，客户端推不出来）。
    // 只在"对局进行中且有这个能力"时给，免得客户端在终局后还标出可走的格子。
    legalMoves:
      room.status === 'playing' ? (room.board.generateMoves?.(room.turn) ?? []) : [],
    check: room.check,
    seats: { black: seatView(room.seats.black, now), white: seatView(room.seats.white, now) },
    spectatorCount: room.spectators.size,
    rematchVotes: room.rematchVotes.size,
    revision: room.revision,
    now,
  };
}

function snapshotFor(room: Room, userId: string, now: number): RoomSnapshot {
  const seat = seatOf(room, userId);
  const role: RoomRole = seat ? 'player' : 'spectator';
  return { view: viewOf(room, now), you: { role, seat } };
}

/** 推一次全量状态。所有变更路径都走它，不存在「改了但忘了推」。 */
function publishState(room: Room, now: number): void {
  publishToRoom<RoomStreamEvent>(room.code, { type: 'state', view: viewOf(room, now) });
}

function touch(room: Room, now: number): void {
  room.lastActivityAt = now;
  room.revision++;
}

/** 取房间并核对归属；不是本游戏的一律当不存在（不泄露房号是否存在）。 */
function roomOf(def: GameDefinition, code: string): Room | null {
  const room = state.rooms.get(code);
  if (!room || room.kind !== def.kind) return null;
  return room;
}

/**
 * 把客户端发来的东西收成一份形状可信的 MoveInput；形状不对返回 null。
 *
 * 【这里只管"像不像一手棋"，不管"这手棋合不合法"】坐标是不是整数、path 是不是
 * 非空数组、promotion 是不是单个字符 —— 这些不依赖任何棋的规则，收在一处免得
 * 五条路由各写一份（漏掉的那条在线上是 500 而不是干净的 400）。
 * 走法本身（挡子、自将、飞将、最大吃子…）一律交给各棋的 `submit`。
 *
 * 【整数校验必须留在这里】五子棋的 `isValidMove` 只判边界不判整数，
 * 而井字棋的自己判了 —— 依赖各棋自觉就会漏。tests/service/gomoku-room.test.ts
 * 有 `1.5` / `NaN` / `'7'` 三条钉子钉着这个行为。
 */
function sanitizeMoveInput(board: RoomBoard, raw: unknown): MoveInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as { path?: unknown; promotion?: unknown };

  if (!Array.isArray(input.path)) return null;
  // 上限 = 盘面格子数：连吃再长也不可能超过"每步吃掉一个子"。给了上限就不必担心
  // 有人拿一个十万项的数组来撑爆内存 —— 校验本身也要是廉价的。
  if (input.path.length === 0 || input.path.length > board.rows * board.cols) return null;

  const path: Square[] = [];
  for (const sq of input.path) {
    if (!isIntegerSquare(sq)) return null;
    path.push([sq[0], sq[1]]);
  }

  let promotion: string | undefined;
  if (input.promotion != null) {
    // 只挡形状（单个字符）。**字符本身认不认识交给 rules 模块** —— 它才知道
    // 这一手是不是升变、"k" 这种乱填该按非法拒掉。
    if (typeof input.promotion !== 'string' || input.promotion.length !== 1) return null;
    promotion = input.promotion;
  }

  return { path, ...(promotion ? { promotion } : {}) };
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

/**
 * 终局落账。三条终局路径（走子判终局 / 认输 / 掉线判胜）共用，
 * 免得某一条忘了清 check 或忘了写 endReason。
 */
function settle(
  room: Room,
  status: 'won' | 'draw',
  opts: { winner: Seat | null; reason: EndReason; highlight: Square[] }
): void {
  room.status = status;
  room.winner = opts.winner;
  room.endReason = opts.reason;
  room.highlight = opts.highlight;
  // 将军与终局互斥：分出结果之后 check 不再有意义
  room.check = null;
}

// ── 对外操作 ────────────────────────────────────────────────────────────────

/** 建房：建房者执先手席（black），状态 waiting 等对手。 */
export function createRoom(
  def: GameDefinition,
  user: RoomUser,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  if (state.rooms.size >= MAX_ROOMS) return { ok: false, error: 'tooManyRooms' };

  const code = generateCode();
  if (!code) return { ok: false, error: 'tooManyRooms' };

  const room: Room = {
    code,
    kind: def.kind,
    board: def.createBoard(),
    status: 'waiting',
    turn: FIRST,
    winner: null,
    endReason: null,
    highlight: [],
    check: null,
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
  def: GameDefinition,
  code: string,
  user: RoomUser,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
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
    const free: Seat | null =
      room.seats.black === null ? 'black' : room.seats.white === null ? 'white' : null;
    if (free) {
      room.seats[free] = { userId: user.id, name: user.name, disconnectedAt: now };
      if (room.seats.black && room.seats.white) {
        room.status = 'playing';
        // 双方就位，后手方等先手方走子
        room.turn = FIRST;
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
  def: GameDefinition,
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 走子。**从校验到落子到判终局是棋盘的 `submit` 一次调用，中间不可能有 await。**
 * 房间层自己只做最便宜的几道闸：房间 → 在座 → 对局中 → 轮次 → 形状。
 */
export function playMove(
  def: GameDefinition,
  code: string,
  userId: string,
  rawMove: MoveInput,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' }; // 观众不能走子

  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  if (seat !== seatOfPlayer(room.turn)) return { ok: false, error: 'notYourTurn' };

  const move = sanitizeMoveInput(room.board, rawMove);
  if (!move) return { ok: false, error: 'illegalMove' };

  // ── 临界区开始：一次调用走完校验与落子，到 publish 为止不得出现 await ──
  const outcome = room.board.submit(room.turn, move);
  if (!outcome) return { ok: false, error: 'illegalMove' }; // 契约：此时棋盘未被改动

  if (outcome.status === 'won') {
    // 赢家取自 outcome，**不是**"刚走完的那个人" —— 长将判负是走的人输（见 Outcome）
    settle(room, 'won', {
      winner: seatOfPlayer(outcome.winner),
      reason: outcome.reason,
      highlight: outcome.highlight,
    });
  } else if (outcome.status === 'draw') {
    settle(room, 'draw', { winner: null, reason: outcome.reason, highlight: [] });
  } else {
    room.endReason = null;
    room.highlight = [];
    room.check = outcome.check;
    room.turn = room.turn === FIRST ? SECOND : FIRST;
  }
  // ── 临界区结束 ──

  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/** 认输。对局进行中才可用。 */
export function resign(
  def: GameDefinition,
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  settle(room, 'won', { winner: otherSeat(seat), reason: 'resign', highlight: [] });
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
  def: GameDefinition,
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
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

  settle(room, 'won', { winner: seat, reason: 'abandoned', highlight: [] });
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 投票「再来一局」。双方各点一次即重开。
 *
 * 【换一张新棋盘，而不是 board.reset()】走子类棋的"开局"不止是格子摆回去：
 * 易位权利、吃过路兵目标格、半回合计数、重复局面历史都在 grid 之外。
 * 靠 reset 逐个清，漏一个就是"再来一局后还能易位"这种只有下到特定局面才暴露的
 * 静默错误；而 `createBoard()` 天然给出一个干净开局，一个字段都不会漏。
 * （单机的"新对局"仍走 reset —— 那条路径由各棋的规则测试盯着 reset 与全新棋盘等价。）
 *
 * **保持同色不换先** —— 换先要引入席位与颜色的映射，边界情况多而收益为零。
 */
export function requestRematch(
  def: GameDefinition,
  code: string,
  userId: string,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'won' && room.status !== 'draw') {
    return { ok: false, error: 'nothingToRematch' };
  }

  room.rematchVotes.add(userId);

  if (room.rematchVotes.size >= 2) {
    room.board = def.createBoard();
    room.status = 'playing';
    room.turn = FIRST;
    room.winner = null;
    room.endReason = null;
    room.highlight = [];
    room.check = null;
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
 *
 * 不需要 def：只按房号取房，任何一局棋的 presence 语义都一样。
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

// ── 按游戏绑定的门面 ────────────────────────────────────────────────────────

/**
 * 把一种棋绑到房间层上，返回该游戏的对外函数集。
 *
 * 【为什么要有它】各游戏的房间层封装是一模一样的七次「把 def 塞进第一个参数」，
 * 抄第二遍就是抄第九遍 —— 而漏掉某一个函数的 def 透传会编译不过，反倒不是风险；
 * 真正的风险是两边各自演化出「只在某个游戏里多做的事」。这里一次写死。
 *
 * 返回的函数**不带 def 参数**（调用方只关心自己的棋），名字与 board-room 的
 * 同名函数一致。refreshPresence / sweepRooms 不在这里：它们只需要房号，
 * 与游戏无关，直接从 board-room 导出。
 */
export function makeRoomApi(def: GameDefinition) {
  return {
    createRoom: (user: RoomUser, now?: number) => createRoom(def, user, now),
    joinRoom: (code: string, user: RoomUser, now?: number) => joinRoom(def, code, user, now),
    getSnapshot: (code: string, userId: string, now?: number) =>
      getSnapshot(def, code, userId, now),
    playMove: (code: string, userId: string, move: MoveInput, now?: number) =>
      playMove(def, code, userId, move, now),
    resign: (code: string, userId: string, now?: number) => resign(def, code, userId, now),
    claimAbandoned: (code: string, userId: string, now?: number) =>
      claimAbandoned(def, code, userId, now),
    requestRematch: (code: string, userId: string, now?: number) =>
      requestRematch(def, code, userId, now),
    /** 仅供测试：清空本游戏的房间。 */
    __reset: () => __resetRooms(def.kind),
    /** 仅供测试：本游戏当前的房间数。 */
    __roomCount: () => __roomCount(def.kind),
  };
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

/** 清空房间。传 kind 只清该游戏的；不传清全部。 */
export function __resetRooms(kind?: RoomKind): void {
  for (const [code, room] of [...state.rooms]) {
    if (kind && room.kind !== kind) continue;
    closeRoom(code);
    state.rooms.delete(code);
  }
  if (state.rooms.size === 0) stopSweeper();
}

/** 仅供测试：当前房间数（可按游戏过滤）。 */
export function __roomCount(kind?: RoomKind): number {
  if (!kind) return state.rooms.size;
  let n = 0;
  for (const room of state.rooms.values()) if (room.kind === kind) n++;
  return n;
}

export const __constants = {
  MAX_ROOMS,
  MAX_SPECTATORS,
  IDLE_TTL_MS,
  EMPTY_TTL_MS,
  DISCONNECT_CLAIM_MS,
} as const;
