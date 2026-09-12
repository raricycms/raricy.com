// ─────────────────────────────────────────────────────────────────────────────
// 联机棋类接口的公共管道：鉴权、限频、错误码 → HTTP 映射，以及**八个 handler 工厂**。
// （Next App Router 把 `_` 开头的文件当非路由，不会被当成 API 端点。）
//
// 【为什么所有棋共用一份】五款棋的权限档位、错误码集合、限频档、响应形状完全一致 ——
// 各写一份必然出现「同一个错误在 A 游戏回 409、在 B 游戏回 400」这种静默的不一致。
//
// 【为什么连 handler 都工厂化】每款棋 8 条路由 × 5 款棋 = 40 个 route.ts。除掉
// 换掉 import 的那一行，它们是逐字相同的 —— 40 份拷贝的代价不是多打几千行，而是
// 改一处（比如给流加一个响应头、给建房换一个限频档）要记得改 40 处，忘掉的那几处
// 不会有任何测试转红。所以这里把每条路由的实现各写一遍，route.ts 只剩「声明式」的
// import + 一行赋值（见各 route.ts 的文件头）。
//
// 【路径字面量仍在各游戏的组件里】客户端的接口地址是**写全的字面量**，不是由这里
// 拼出来的：scripts/check-links.mjs 静态校验源码里的接口路径有没有对应路由，而
// 拼接出来的路径它看不见。服务端这一侧没有这个约束（路由是文件系统决定的）。
// ─────────────────────────────────────────────────────────────────────────────

import { getCurrentUser, isCoreUser, type SafeUser } from '@/lib/auth';
import type {
  MoveInput,
  RoomError,
  RoomKind,
  RoomResult,
  RoomSnapshot,
} from '@/lib/board-shared';
import { normalizeRoomCode, type RoomStreamEvent } from '@/lib/board-shared';
import type { RoomUser } from '@/lib/board-room';
import { refreshPresence } from '@/lib/board-room';
import { apiErr, apiOk } from '@/lib/format';
import { FOCUS_MODE_BLOCKED_TITLE } from '@/lib/focus-mode';
import { canSubscribe, subscribe } from '@/lib/game-bus';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { SSE_HEADERS, SSE_QUEUE_LIMIT, SSE_RETRY_MS, sseFrame } from '@/lib/sse';

export type GameUserResult = SafeUser | Response;

/**
 * 联机接口的统一闸门：登录 → core+ → 非专注模式。
 *
 * 【为什么比单机严】单机 /game/* 匿名可玩、专注模式也能直达。联机是**社交行为**
 * （对面坐着真人），与聊天大区同等对待：这里是服务端硬闸门，不只是 UI 隐藏。
 * 对齐 api/chat/_auth.ts。
 *
 * 【为什么要求 core+】站内既有门槛：发评论、聊天、投票、剪贴板都是 core+。
 * 「把房号发给朋友」的前提是朋友进得来 —— core+ 靠邀请码升级，这一步是有意的。
 *
 * 【不加禁言判定】站内封禁的语义是「不能说话」，而下棋不是发言。
 */
export async function requireGameUser(): Promise<GameUserResult> {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (user.focusMode) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);
  return user;
}

/** 房间错误 → HTTP。集中一处，免得每种棋的八条路由各写一份不一致的映射。 */
export function roomErrorResponse(error: RoomError): Response {
  switch (error) {
    case 'notFound':
      return apiErr(404, '房间不存在或已过期');
    case 'notASeat':
      return apiErr(403, '你不在这一局里');
    case 'notPlaying':
      return apiErr(409, '对局尚未开始或已结束');
    case 'notYourTurn':
      return apiErr(409, '还没轮到你');
    case 'illegalMove':
      return apiErr(400, '这步棋不合法');
    case 'tooManyRooms':
      return apiErr(503, '房间太多了，请稍后再试');
    case 'tooManySpectators':
      return apiErr(409, '观战人数已满');
    case 'opponentPresent':
      return apiErr(409, '对手还在线');
    case 'notDisconnectedLongEnough':
      return apiErr(409, '对手刚掉线，请稍候再试');
    case 'nothingToRematch':
      return apiErr(409, '对局尚未结束');
  }
}

/**
 * 一种棋的房间层对外函数集。`makeRoomApi()` 的返回值结构上就满足它
 * （多出来的 `__reset` / `__roomCount` 是测试用的，这里不需要）。
 */
export interface GameRoomApi {
  createRoom(user: RoomUser): RoomResult<RoomSnapshot>;
  joinRoom(code: string, user: RoomUser): RoomResult<RoomSnapshot>;
  getSnapshot(code: string, userId: string): RoomResult<RoomSnapshot>;
  playMove(code: string, userId: string, move: MoveInput): RoomResult<RoomSnapshot>;
  resign(code: string, userId: string): RoomResult<RoomSnapshot>;
  claimAbandoned(code: string, userId: string): RoomResult<RoomSnapshot>;
  requestRematch(code: string, userId: string): RoomResult<RoomSnapshot>;
}

/**
 * 房号规范化 + 限频 + 鉴权的公共前置。房号解析不出来就直接给 404。
 *
 * 限频键按 `game:<棋种>:<档>:<userId>` 拼 —— **按棋种分开**，五款棋的额度不互相挤占
 * （五子棋连点不会把象棋的额度吃掉）。档位取自 RULES，数值的唯一权威在那边的 RULES 表。
 */
async function gate(
  kind: RoomKind,
  rawCode: string,
  scope: 'room' | 'poll' | 'move',
  limitKey: 'gameRoom' | 'gameMove' | 'gamePoll'
): Promise<{ code: string; user: SafeUser } | Response> {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  // 规范化放在查表之前：非法房号与不存在的房号回同一个 404，
  // 免得把「这个房号格式对不对」变成一个可探测的信号。
  const code = normalizeRoomCode(rawCode);
  if (!code) return apiErr(404, '房间不存在或已过期');

  const limited = rateLimit(`game:${kind}:${scope}:${user.id}`, RULES[limitKey]);
  if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

  return { code, user };
}

/** 路由上下文。Next 的 params 是 Promise（15+）。 */
type CodeCtx = { params: Promise<{ code: string }> };

// ── 八个 handler 工厂 ───────────────────────────────────────────────────────

/**
 * POST /rooms —— 建房。
 * 建房者执先手席，房间进入 waiting 等对手。房号就是邀请凭证 ——
 * 把 `?mode=online&room=<code>` 发给朋友即可，不需要额外的邀请接口。
 *
 * 【两道界】限频挡脚本，MAX_ROOMS 挡内存无界增长（房间活在进程内存里，见 board-room.ts）。
 */
export function makeCreateRoomHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(): Promise<Response> {
    const user = await requireGameUser();
    if (user instanceof Response) return user;

    const limited = rateLimit(`game:${kind}:room:${user.id}`, RULES.gameRoom);
    if (!limited.allowed) return apiErr(429, '操作太频繁，请稍后再试');

    const res = api.createRoom({ id: user.id, name: user.username });
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value }, '房间已创建');
  };
}

/**
 * GET /rooms/:code —— 取全量快照。
 * 用于刷新页面 / 断线重连 / 只读观战。**不改变任何状态**（入座是 POST join 的事）。
 * SSE 一连上也会推一份当前状态，这条是给「还没连上 SSE」和「resync 兜底」用的。
 */
export function makeSnapshotHandler(kind: RoomKind, api: GameRoomApi) {
  return async function GET(_req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'poll', 'gamePoll');
    if (g instanceof Response) return g;

    const res = api.getSnapshot(g.code, g.user.id);
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value });
  };
}

/**
 * POST /rooms/:code/join —— 入座 / 转观众。
 *
 * **幂等**：已在座或已在观众席的调用者拿回原身份，服务端不重置任何状态。
 * 这条路径正是「刷新页面回到原座」与「断线重连不丢座」走的 —— 见 joinRoom 的注释。
 * 两席坐满后自动转观众（观战是白送的：走子本来就是公开信息）。
 */
export function makeJoinHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(_req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'room', 'gameRoom');
    if (g instanceof Response) return g;

    const res = api.joinRoom(g.code, { id: g.user.id, name: g.user.username });
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value });
  };
}

/**
 * POST /rooms/:code/moves —— 走子。body 是 `MoveInput`（`{ path, promotion? }`）。
 *
 * 客户端只报「我走了哪条路径」，轮次、合法性、胜负一律由服务端判定 ——
 * 这个接口的返回值里带的服务端状态才是权威，客户端的乐观更新只是观感。
 *
 * **棋路的具体形状校验不在这里**（那是 board-shared 的 isIntegerSquare 与
 * board-room 的 sanitizeMoveInput 的事），本路由只把 body 原样递下去：
 * 校验散在五条路由里必然漏，而漏掉的那条线上是 500 而不是干净的 400。
 *
 * 成功即由房间层向全房推一帧 SSE，所以本接口**不需要**自己广播。
 */
export function makeMoveHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'move', 'gameMove');
    if (g instanceof Response) return g;

    const body = (await req.json().catch(() => ({}))) as MoveInput;
    const res = api.playMove(g.code, g.user.id, body);
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value });
  };
}

/** POST /rooms/:code/resign —— 认输。无请求体。对局进行中才可用。 */
export function makeResignHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(_req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'move', 'gameMove');
    if (g instanceof Response) return g;

    const res = api.resign(g.code, g.user.id);
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value }, '已认输');
  };
}

/**
 * POST /rooms/:code/rematch —— 投票「再来一局」。无请求体。
 * 双方各点一次即重开（同席不换先）。一票时对局仍是终局状态，
 * 客户端据 room.view.rematchVotes 显示「已申请，等对手」。
 */
export function makeRematchHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(_req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'move', 'gameMove');
    if (g instanceof Response) return g;

    const res = api.requestRematch(g.code, g.user.id);
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value }, '已申请再来一局');
  };
}

/**
 * POST /rooms/:code/claim —— 对手掉线判胜。无请求体。
 *
 * 「我等了多久」由服务端自己算 —— 客户端只负责点按钮。
 * 掉线满 DISCONNECT_CLAIM_MS 才判胜（不满 → 409），对手重新连上即撤销资格（→ 409）。
 *
 * 【为什么不做服务端定时器】定时器要在房间状态机之外再维护一套「到点了判谁赢」，
 * 是另一类 bug 的来源。这里改成惰性判定：不变量是「disconnectedAt 为 null 就是在线」，
 * 判胜时现算。代价是必须有人点一下按钮，收益是少一整类状态。
 */
export function makeClaimHandler(kind: RoomKind, api: GameRoomApi) {
  return async function POST(_req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'move', 'gameMove');
    if (g instanceof Response) return g;

    const res = api.claimAbandoned(g.code, g.user.id);
    if (!res.ok) return roomErrorResponse(res.error);

    return apiOk({ room: res.value }, '已判胜');
  };
}

/**
 * GET /rooms/:code/stream —— 对局实时流（SSE）。
 *
 * 单向推送足够：走子仍走 POST /rooms/:code/moves，白拿 CSRF 同源校验、限频与鉴权。
 * 开 WebSocket 需要自定义 server，会顶掉 next start 与 systemd unit
 * （详见 docs/architecture.md 的取舍）。棋是回合制，SSE 的延迟完全够用。
 *
 * 【响应头】全部取自 @/lib/sse 的 SSE_HEADERS —— 那边的文件头记着 no-transform
 * 为什么不可省。**本工厂不要手写响应头**，五款棋共用的就是这一份。
 *
 * 【断线补齐就是「一连上推一次全量状态」】不需要 Last-Event-ID、环形缓冲或 resync：
 * 每帧都是完整状态，客户端按 revision 丢弃过期的即可。见 board-shared.ts 文件头。
 *
 * 【鉴权在每次建立连接时重做】所以封禁/降权/专注模式变更后只要踢掉旧连接
 * （game-bus.kickViewer / user-service），重连就会重新判定 —— 拿 403 时
 * EventSource 按规范直接 fail 且不再重试。
 */
export function makeStreamHandler(kind: RoomKind, api: GameRoomApi) {
  return async function GET(req: Request, ctx: CodeCtx): Promise<Response> {
    const { code: raw } = await ctx.params;
    const g = await gate(kind, raw, 'poll', 'gamePoll');
    if (g instanceof Response) return g;
    const { code, user } = g;

    // 房间不存在就别建流了 —— 建完再关掉只会让 EventSource 反复重连。
    const snapshot = api.getSnapshot(code, user.id);
    if (!snapshot.ok) return roomErrorResponse(snapshot.error);

    // 并发上限在建流**之前**判：等 subscribe 返回 null 时流已经建好，
    // 那时只能关掉流让客户端打转，回不了 429。
    if (!canSubscribe(user.id)) {
      return apiErr(429, '连接数过多，请关掉多余的标签页再试');
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      // 断开后重算在线状态并把「已掉线」广播出去（对手据此显示并计时判胜）。
      // 必须在 unsubscribe **之后**调 —— 那时 connectionsIn 才数得准。
      refreshPresence(code, user.id);
    };

    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const write = (chunk: string): boolean => {
            if (closed) return false;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              return false; // 已关闭 / 已取消
            }
            // desiredSize ≤ 0 = 队列积压到 highWaterMark → 交给 bus 断开重连
            return (controller.desiredSize ?? 1) > 0;
          };

          const closeStream = () => {
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          };

          // 首帧：重连节奏 + 注释帧（让浏览器/中间层立刻见到字节，避免被当成空响应）
          if (!write(`retry: ${SSE_RETRY_MS}\n\n: connected\n\n`)) {
            // 首帧就写不进去 = 流已经废了，别再注册订阅（否则要等 abort 才回收）
            cleanup();
            closeStream();
            return;
          }

          const off = subscribe({
            roomCode: code,
            viewerId: user.id,
            write,
            close: () => {
              cleanup();
              closeStream();
            },
          });
          if (!off) {
            // 上面已用 canSubscribe 拦过，走到这里说明是并发竞态 —— 同样收摊。
            cleanup();
            closeStream();
            return;
          }
          unsubscribe = off;

          // 一连上就推当前全量状态：这就是断线补齐（见文件头）。
          write(sseFrame<RoomStreamEvent>({ type: 'state', view: snapshot.value.view }));

          // 订阅**之后**才刷新在线状态：早于订阅会数到 0，把刚连上的自己判成掉线。
          refreshPresence(code, user.id);

          // 客户端主动断开（关标签页 / 网络断）时 Next 会 cancel 流；这里再挂一道
          // 保险，防止某些运行时下 cancel 不被触发导致订阅泄漏。
          req.signal.addEventListener('abort', () => {
            cleanup();
            closeStream();
          });
        },
        cancel() {
          cleanup();
        },
      },
      { highWaterMark: SSE_QUEUE_LIMIT }
    );

    return new Response(stream, { headers: SSE_HEADERS });
  };
}
