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
// 【席位不是"谁先进谁坐"】进房只把人放到**观战台**（spectators），坐哪一席由本人点
// （见 takeSeat）—— 先手/后手是两个人各自的选择，不该由"谁先点开链接"决定。
//
// 【非对局中，掉线即释放席位】`playing` 时不释放（只标记掉线，对手据此判胜），
// 其余状态（waiting / won / draw）里一个人从席位上断开就把他放回观战台。理由：席位是
// **资源**（每席只一人，坐满了别人就进不来），而中场休息时占着席位掉线只是挡住别人。
// 代价是"切到别的标签页"也算断开（客户端省连接时会关掉 SSE），所以重连回来时客户端
// 会自动坐回原来那一席 —— 只要还空着（见 RoomStreamEvent 的 `you`：那一帧就是为它准备的）。
// 由此得到一条不变量：**`playing` ⇒ 两席都有人**（释放只发生在非对局中，所以对局进行中
// 新人永远偷不走座位）。
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
  type SpectatorView,
  type Square,
  type UndoRequest,
  otherSeat,
  playerOfSeat,
  seatOfPlayer,
  undoPlies,
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
 *
 * 【undo 与 submit 是同一类东西】同样是**单步**：撤掉已经落在盘上的最后一手，没有
 * "先校验再撤"两步可拆，也就同样没有地方能插进一个 await。契约：没有可撤的返回 false
 * 且棋盘不动；否则必须把这一手造成的**全部**影响还原（走子类棋包括易位权利、过路兵
 * 目标格、半回合计数与重复局面历史 —— 各棋的 unmake 已经这么做了，别在这里另写一份）。
 * 房间层只在自己核对过"撤得动"之后才调它（见 respondUndo）。
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
  /** 撤掉最后一手。没有可撤的返回 false（见上面 undo 的契约）。 */
  undo(): boolean;
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

/**
 * 观战台上的一条。**没有"释放"这回事**：观战台不占地儿、也不挡着别人坐下，
 * 所以掉线只标（掉线），不把人移出去 —— 否则切一下标签页，围观的人就在名单里
 * 忽隐忽现。名字在进房 / 退座那一刻记下来（房间层只有 userId，查库要 IO）。
 */
interface BenchEntry {
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
  /** 观战台：房间里**没在对战席上**的人（进房、退座、席位被释放都落到这儿）。 */
  spectators: Map<string, BenchEntry>;
  rematchVotes: Set<string>;
  /**
   * 每一手**走子前**的 check（与棋盘自己的历史一一对应，长度即 plyCount）。
   * 悔棋要把「被将军」高亮也退回去，而那是历史信息 —— 撤回之后重算不出来
   * （要走子类的棋盘生成整棵着法树才知道上一手走完时谁在被将），所以走一手压一条。
   */
  checkStack: (Square | null)[];
  /** 待回应的悔棋请求；没有则为 null。同一时刻只允许一个。 */
  undoRequest: UndoRequest | null;
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
    id: holder.userId,
    name: holder.name,
    connected: holder.disconnectedAt === null,
    disconnectedForMs: holder.disconnectedAt === null ? null : now - holder.disconnectedAt,
  };
}

/** 观战台的一条。与席位同形（两处渲染的是同一样东西）。 */
function benchView(userId: string, entry: BenchEntry, now: number): SpectatorView {
  return {
    id: userId,
    name: entry.name,
    connected: entry.disconnectedAt === null,
    disconnectedForMs: entry.disconnectedAt === null ? null : now - entry.disconnectedAt,
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
    // 对局中下发空名单：大厅的规矩是「开局后隐藏观战台」，顺带也就不把「现在谁在看」
    // 推给全房（`spectatorCount` 照旧给，席位栏在对局中仍显示「围观 N」）。
    spectators:
      room.status === 'playing'
        ? []
        : [...room.spectators].map(([id, entry]) => benchView(id, entry, now)),
    spectatorCount: room.spectators.size,
    plyCount: room.checkStack.length,
    // 拷一份再发：客户端拿到的那份改不动房间里的请求
    undoRequest: room.undoRequest ? { ...room.undoRequest } : null,
    rematchVotes: room.rematchVotes.size,
    revision: room.revision,
    now,
  };
}

function snapshotFor(room: Room, userId: string, now: number): RoomSnapshot {
  const seat = seatOf(room, userId);
  const role: RoomRole = seat ? 'player' : 'spectator';
  return { view: viewOf(room, now), you: { id: userId, role, seat } };
}

/** 推一次全量状态。所有变更路径都走它，不存在「改了但忘了推」。 */
function publishState(room: Room, now: number): void {
  publishToRoom<RoomStreamEvent>(room.code, { type: 'state', view: viewOf(room, now) });
}

function touch(room: Room, now: number): void {
  room.lastActivityAt = now;
  room.revision++;
}

/**
 * 把某人放到观战台上（三种情形共用：退座、席位被释放、掉线被移出席位）。
 *
 * 【票跟着席位走】顺手删掉他的「再来一局」票：不在座上的票不算数，否则一间已分出
 * 胜负的房间会靠"一个已经离开的人 + 一个还在的人"凑够两票而重开。
 *
 * 【不再卡观众上限】MAX_SPECTATORS 是给「进房」挡脚本用的；这里的人是**从席位上
 * 下来的**（本就已在房间里），把他挡回去只会让席位空着而人不见了。
 */
function toBench(room: Room, userId: string, name: string, now: number): void {
  room.spectators.set(userId, {
    name,
    // 入座/退座的那一刻可能还有活连接（重连自动回座、另开一个标签页）
    disconnectedAt: connectionsIn(room.code, userId) > 0 ? null : now,
  });
  room.rematchVotes.delete(userId);
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
  opts: { winner: Seat | null; reason: EndReason; highlight: Square[] },
  now: number
): void {
  room.status = status;
  room.winner = opts.winner;
  room.endReason = opts.reason;
  room.highlight = opts.highlight;
  // 将军与终局互斥：分出结果之后 check 不再有意义
  room.check = null;
  // 局面已定，待回应的悔棋请求随之作废（认输 / 判胜不经过 playMove，这里必须补一刀）
  room.undoRequest = null;

  // 顺便把已经掉线的一方从席位上放下来。**掉线是边沿触发的**（只在连线数变化那一刻
  // 重算，见 refreshPresence），所以「中途掉线、随后对手认输或将死收场」那个人不会再有
  // 第二次触发 —— 不在这里补一次，他的席位就一直挂着，谁也别想坐进来。
  for (const seat of ['black', 'white'] as const) {
    const holder = room.seats[seat];
    if (!holder) continue;
    if (connectionsIn(room.code, holder.userId) > 0) continue;
    room.seats[seat] = null;
    toBench(room, holder.userId, holder.name, now);
  }
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
    //   建房即占座（开房的人先坐下），此后进来的人一律先落观战台 —— 坐哪一席由本人点。
    spectators: new Map(),
    rematchVotes: new Set(),
    checkStack: [],
    undoRequest: null,
    createdAt: now,
    lastActivityAt: now,
    revision: 1,
  };
  state.rooms.set(code, room);
  ensureSweeper();
  return { ok: true, value: snapshotFor(room, user.id, now) };
}

/**
 * 进入房间。**幂等**：已在座 / 已在观战台的调用者拿回原有身份，不重置任何状态。
 * 这条同时免费提供了「刷新页面回到原座」与「断线重连不丢座」。
 *
 * 【进房不自动入座】落点是**观战台**，坐哪一席由本人点（见 takeSeat）——
 * 谁先手谁后手是两个人的选择，不该由"谁先点开链接"决定。
 */
export function joinRoom(
  def: GameDefinition,
  code: string,
  user: RoomUser,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  // 已在座 / 已在观战台 → 原样返回（幂等）。
  // 只续 lastActivityAt（免得房间被当成空闲回收），**不动 revision、不推流** ——
  // 状态没有任何变化，推一帧空的只会让所有客户端的「丢弃过期状态」判断白白抖动。
  // 这条路径正是「刷新页面回到原座」与「断线重连」走的，必须零副作用。
  if (seatOf(room, user.id) || room.spectators.has(user.id)) {
    room.lastActivityAt = now;
    return { ok: true, value: snapshotFor(room, user.id, now) };
  }

  if (room.spectators.size >= MAX_SPECTATORS) return { ok: false, error: 'tooManySpectators' };
  // 已经连着 SSE 的（重连自动回到观战台、另开一个标签页）不该先被标成掉线
  room.spectators.set(user.id, {
    name: user.name,
    disconnectedAt: connectionsIn(code, user.id) > 0 ? null : now,
  });
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, user.id, now) };
}

/**
 * 坐上空着的那一席（观战台上的人点「加入」）。
 *
 * 【也是换先】已经坐在另一席的人点过来，就是把原来的席空出来换个先后手 ——
 * 只允许换到**空着的**那一席：与对手互换要挪动别人的头像，那是另一回事（没做）。
 *
 * 【为什么不在对局中进行】中途换人等于偷走别人的局（这一条原先写在 joinRoom 里，
 * 现在由 takeSeat 负责）。配合「非对局中掉线即释放席位」，还得到一条不变量：
 * **`playing` ⇒ 两席都有人** —— 所以对局进行中既空不出席位、也坐不进去。
 */
export function takeSeat(
  def: GameDefinition,
  code: string,
  user: RoomUser,
  seat: Seat,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  if (room.status === 'playing') return { ok: false, error: 'inGame' };

  const mine = seatOf(room, user.id);
  if (mine === seat) {
    // 已经坐在这一席：幂等（客户端重连后自动坐回原席会撞上这条）
    room.lastActivityAt = now;
    return { ok: true, value: snapshotFor(room, user.id, now) };
  }
  if (room.seats[seat]) return { ok: false, error: 'seatTaken' };

  if (mine) room.seats[mine] = null; // 换先：原席位空出来
  room.spectators.delete(user.id);

  room.seats[seat] = {
    userId: user.id,
    name: user.name,
    disconnectedAt: connectionsIn(code, user.id) > 0 ? null : now,
  };

  // 【只在 waiting 时开战】已分出胜负的房间（won/draw）里坐人只是补位，不是重开 ——
  // 否则棋盘、赢家、endReason 都还是上一局的，状态却变回 playing，两队人又能接着走子。
  // 要再来一局仍然得双方各点一次 rematch。
  if (room.status === 'waiting' && room.seats.black && room.seats.white) {
    room.status = 'playing';
    // 双方就位，后手方等先手方走子
    room.turn = FIRST;
  }

  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, user.id, now) };
}

/** 从席位上退到观战台（对局进行中不许退）。 */
export function leaveSeat(
  def: GameDefinition,
  code: string,
  user: RoomUser,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  if (room.status === 'playing') return { ok: false, error: 'inGame' };

  const seat = seatOf(room, user.id);
  if (!seat) return { ok: false, error: 'notASeat' };

  room.seats[seat] = null;
  toBench(room, user.id, user.name, now);

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

  // 悔棋要连「被将军」高亮一起退回去，而那是历史信息 —— 撤回后重算不出来
  // （得遍历整棵着法树才知道上一手走完时谁在被将），所以走一手就压一条。栈长即 plyCount。
  room.checkStack.push(room.check);
  // 局面变了，待回应的悔棋请求指的就不再是现在这个局面 —— 一并作废（见 requestUndo）
  room.undoRequest = null;

  if (outcome.status === 'won') {
    // 赢家取自 outcome，**不是**"刚走完的那个人" —— 长将判负是走的人输（见 Outcome）
    settle(
      room,
      'won',
      {
        winner: seatOfPlayer(outcome.winner),
        reason: outcome.reason,
        highlight: outcome.highlight,
      },
      now
    );
  } else if (outcome.status === 'draw') {
    settle(room, 'draw', { winner: null, reason: outcome.reason, highlight: [] }, now);
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

  settle(room, 'won', { winner: otherSeat(seat), reason: 'resign', highlight: [] }, now);
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

  settle(room, 'won', { winner: seat, reason: 'abandoned', highlight: [] }, now);
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 请求悔棋 —— **同一个按钮的两面**：发请求，或者撤回自己刚发的那条。
 *
 * 【为什么要对手同意】悔棋悔的是自己上一步，而在「对手已经应招」的那半局里，退回去
 * 意味着**对手那一步也一并作废**（撤 2 步，见 undoPlies）。那步棋是他的，所以要他点头。
 * 同意权在他手上，也就不存在「看完对手应招再反悔」这种不公平。
 *
 * 【请求不冻结棋局，也不过期】它只是挂在局面上的一条意向：任何一手走子都会把它清掉
 * （局面都变了，悔的就不再是那个局面），终局与再来一局同理。所以它既不需要服务端
 * 定时器，也不会把房间卡在一个"等回应"的死状态上 —— 不想等了就走棋，或者自己撤回。
 */
export function requestUndo(
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

  if (room.undoRequest) {
    // 自己发的再点一次 = 撤回（客户端上按钮写的就是「撤回」）
    if (room.undoRequest.by !== seat) return { ok: false, error: 'undoPending' };
    room.undoRequest = null;
    touch(room, now);
    publishState(room, now);
    return { ok: true, value: snapshotFor(room, userId, now) };
  }

  // 「撤到轮到我走」要几步由 turn 与席位现算；够不够撤看 checkStack 的长度（栈长即步数，
  // 两者由 playMove / respondUndo 一起维护）。开局第一手之前点悔棋就是在这里被挡掉的。
  const plies = undoPlies(room.turn, seat);
  if (room.checkStack.length < plies) return { ok: false, error: 'nothingToUndo' };

  room.undoRequest = { by: seat, plies };
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 回应悔棋请求（同意 / 拒绝）。**只有对手能回应** —— 撤回自己的请求走 requestUndo。
 *
 * 同意时退回到「轮到请求方走」的那一刻：`room.turn` 因此直接写成请求方的席位，
 * 而不是连翻两次 —— 席位与先手的映射只有 seatOfPlayer / playerOfSeat 一处，
 * 翻次数那种写法迟早与 undoPlies 的口径对不上。
 */
export function respondUndo(
  def: GameDefinition,
  code: string,
  userId: string,
  accept: boolean,
  now = Date.now()
): RoomResult<RoomSnapshot> {
  const room = roomOf(def, code);
  if (!room) return { ok: false, error: 'notFound' };

  const seat = seatOf(room, userId);
  if (!seat) return { ok: false, error: 'notASeat' };
  if (room.status !== 'playing') return { ok: false, error: 'notPlaying' };

  const req = room.undoRequest;
  if (!req || req.by === seat) return { ok: false, error: 'noUndoRequest' };

  if (accept) {
    // ── 临界区：与 playMove 同一个理由，撤销同样是一次调用走完，中间不得出现 await ──
    for (let i = 0; i < req.plies; i++) {
      if (!room.board.undo()) {
        // 理论上到不了：requestUndo 已按 checkStack 的长度核过步数，两者同生同灭。
        // 真到了这里就只能整手拒绝（房间一动不动）—— 半撤的状态下 room.turn 与棋盘
        // 内部的 turn 会错开，那之后双方每一手都是 illegalMove，没有路径能掰回来。
        room.undoRequest = req; // 请求原样留着（这一帧没推出去，客户端看到的也还是它）
        return { ok: false, error: 'nothingToUndo' };
      }
      room.check = room.checkStack.pop() ?? null;
    }
    room.turn = playerOfSeat(req.by);
    // ── 临界区结束 ──
  }

  room.undoRequest = null;
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
    // 【新棋盘必须连悔棋的账一起清】checkStack 是「棋盘的步数 + 每步之前的 check」，
    // 换了棋盘却不换它，第二局第一手悔棋就会按上一局的步数去撤 —— 撤到一半 board.undo()
    // 返回 false，而更糟的是 room.turn 与棋盘内部的 turn 就此错开，双方永久 illegalMove。
    room.checkStack = [];
    room.undoRequest = null;
  }
  // revision 继续递增，**不重置** —— 重置会让客户端的「丢弃过期状态」判断失效
  touch(room, now);
  publishState(room, now);
  return { ok: true, value: snapshotFor(room, userId, now) };
}

/**
 * 连接数变化后重算在线状态，并向全房广播。
 * SSE 路由在 subscribe 之后与 unsubscribe 之后各调一次。
 *
 * 两种身份处理不同，理由见文件头的席位规则：
 *   • **席位上的人**：对局中只标记掉线（对手据此判胜）；**没在对局中就释放席位**
 *     （人回到观战台，席位腾给下一个想坐的人）。
 *   • **观战台上的人**：只标记掉线，不移出名单 —— 名单不占资源也不挡人坐下。
 *
 * 不需要 def：只按房号取房，任何一局棋的 presence 语义都一样。
 */
export function refreshPresence(code: string, userId: string, now = Date.now()): void {
  const room = state.rooms.get(code);
  if (!room) return;

  const connected = connectionsIn(code, userId) > 0;
  const seat = seatOf(room, userId);

  if (seat) {
    const holder = room.seats[seat];
    if (!holder) return;
    if (connected === (holder.disconnectedAt === null)) return; // 无变化，不推流

    if (connected) {
      holder.disconnectedAt = null;
    } else if (room.status === 'playing') {
      // 对局中不释放席位，只标记掉线 —— 对手据此看到倒计时并可判胜（见 claimAbandoned）
      holder.disconnectedAt = now;
    } else {
      // 没在对局中：席位直接空出，人回到观战台（见文件头的席位规则）。
      // 回来时客户端会自动坐回这一席（只要还空着），所以"切个标签页"不至于把座位丢了 ——
      // 除非这期间正好有人进来坐了（那本来就是这个功能的用意）。
      room.seats[seat] = null;
      toBench(room, holder.userId, holder.name, now);
    }

    touch(room, now);
    publishState(room, now);
    return;
  }

  // 观战台上的人：只更新在线状态，**不移出名单**（名单没有"占位"问题，掉了就标一下，
  // 否则切个标签页名单就来回收缩）。席位那一半才有释放规则。
  const entry = room.spectators.get(userId);
  if (!entry) return;
  if (connected === (entry.disconnectedAt === null)) return;

  entry.disconnectedAt = connected ? null : now;
  touch(room, now);
  publishState(room, now);
}

// ── 按游戏绑定的门面 ────────────────────────────────────────────────────────

/**
 * 把一种棋绑到房间层上，返回该游戏的对外函数集。
 *
 * 【为什么要有它】各游戏的房间层封装是一模一样的一串「把 def 塞进第一个参数」，
 * 抄第二遍就是抄第十遍 —— 而漏掉某一个函数的 def 透传会编译不过，反倒不是风险；
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
    takeSeat: (code: string, user: RoomUser, seat: Seat, now?: number) =>
      takeSeat(def, code, user, seat, now),
    leaveSeat: (code: string, user: RoomUser, now?: number) => leaveSeat(def, code, user, now),
    getSnapshot: (code: string, userId: string, now?: number) =>
      getSnapshot(def, code, userId, now),
    playMove: (code: string, userId: string, move: MoveInput, now?: number) =>
      playMove(def, code, userId, move, now),
    resign: (code: string, userId: string, now?: number) => resign(def, code, userId, now),
    claimAbandoned: (code: string, userId: string, now?: number) =>
      claimAbandoned(def, code, userId, now),
    requestUndo: (code: string, userId: string, now?: number) =>
      requestUndo(def, code, userId, now),
    respondUndo: (code: string, userId: string, accept: boolean, now?: number) =>
      respondUndo(def, code, userId, accept, now),
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
