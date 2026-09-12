// ─────────────────────────────────────────────────────────────────────────────
// game-bus.ts — 联机对战的进程内订阅注册表（服务端专用）
//
// 【与 chat-bus.ts 同构】投递语义、心跳、globalThis 单例、背压即断开 —— 那几条
// 判断的理由见 chat-bus.ts 的文件头，此处不重复。**改动其中一个请对照另一个。**
//
// 【为什么不把两者抽成一个泛型实现】真正通用的只有 sseFrame（已抽到 ./sse）、
// deliverOne（12 行）与心跳循环（15 行），省不到 60 行；而生命周期需求本就不同：
// chat 无 TTL、按 userId 踢人、只有一个订阅维度；game 要按房间 GC、要并发连接上限、
// 要按 viewer 跨房间踢人、上层还要拿连接数算「在座/掉线」。硬抽会为此长出钩子与
// 参数，而 chat-bus 是安全敏感模块（封禁/降权/专注模式的 kickUser 都走它）。
//
// 【本模块的边界】只管「连接 → 房间」的登记与投递。**不含棋盘、不含席位、不含
// 房间 TTL** —— 那些在 board-room.ts。这里不 import 任何游戏内容，事件类型泛型化。
//
// 【为什么挂 globalThis】同 chat-bus：Next dev 的热更新会重新求值模块，模块级 Map
// 会被清空，已建立的 SSE 连接就成了孤儿（还能写、但再也收不到推送）。
// ─────────────────────────────────────────────────────────────────────────────

import { sseFrame } from './sse';

/** 心跳间隔：防中间设备（反代 / NAT / 运营商）把空闲长连接掐掉。
 *  25s 卡在 nginx 默认 60s 的 proxy_read_timeout 之下。 */
const HEARTBEAT_MS = 25_000;

/** 单个用户的并发 SSE 连接上限（多标签页 + 观战页会叠加）。
 *  超限时 subscribe 返回 null，上层回 429 —— 换浏览器 profile 无门槛，故这只是防误用。 */
export const MAX_CONNECTIONS_PER_VIEWER = 4;

export interface GameSubscriber {
  /** 订阅的房间码（已是规范化后的小写形式） */
  roomCode: string;
  /** 订阅者身份：登录用户 id。用于并发上限与 kickViewer。 */
  viewerId: string;
  /** 写入一帧；返回 false 表示下游背压（调用方会断开该连接） */
  write: (chunk: string) => boolean;
  /** 关闭连接（背压 / 房间回收 / 踢人时由 bus 调用） */
  close: () => void;
}

interface BusState {
  /** roomCode → 该房间的全部连接（在座玩家与观众都在里面） */
  subs: Map<string, Set<GameSubscriber>>;
  /** 心跳定时器；最后一个订阅者离开时清掉 */
  timer: ReturnType<typeof setInterval> | null;
}

const globalForBus = globalThis as unknown as { __gameBus?: BusState };
const state: BusState = (globalForBus.__gameBus ??= { subs: new Map(), timer: null });

function deliverOne(sub: GameSubscriber, chunk: string): void {
  let ok = true;
  try {
    ok = sub.write(chunk);
  } catch {
    ok = false; // 已关闭的 controller 会抛错 → 当作背压断开处理
  }
  if (!ok) {
    // 背压（客户端读得太慢 / 已经断了）：断开这条连接，让 EventSource 重连补齐。
    // 不在服务端无限缓冲，否则慢客户端会变成内存泄漏。
    try {
      sub.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 某用户在指定房间的连接数。
 * 上层（board-room）靠它判断席位主人是否「掉线」——归零即视为掉线，
 * 而非零即视为还在看。**按需扫描而非维护计数**：连接建立/断开是低频事件，
 * 而手维护的计数表一旦漏减就会永久偏移，那种 bug 极难查。
 */
export function connectionsIn(roomCode: string, viewerId: string): number {
  const set = state.subs.get(roomCode);
  if (!set) return 0;
  let n = 0;
  for (const sub of set) if (sub.viewerId === viewerId) n++;
  return n;
}

/** 某房间的连接总数（空房回收用：归零且无人走子即可回收）。 */
export function roomConnections(roomCode: string): number {
  return state.subs.get(roomCode)?.size ?? 0;
}

/**
 * 该用户还能不能再建连接。
 * 给 SSE 路由在建流**之前**判定用 —— 等 subscribe 返回 null 时流已经建好了，
 * 那时只能关掉流让 EventSource 打转，回不了正经的 429。
 */
export function canSubscribe(viewerId: string): boolean {
  return connectionsOf(viewerId) < MAX_CONNECTIONS_PER_VIEWER;
}

/** 某用户在全部房间的连接总数（并发上限用）。 */
function connectionsOf(viewerId: string): number {
  let n = 0;
  for (const set of state.subs.values()) {
    for (const sub of set) if (sub.viewerId === viewerId) n++;
  }
  return n;
}

/**
 * 注册一条连接；返回注销函数。
 * 超过每用户并发上限时返回 **null**（上层回 429，不要注册，否则要等 abort 才回收）。
 */
export function subscribe(sub: GameSubscriber): (() => void) | null {
  if (connectionsOf(sub.viewerId) >= MAX_CONNECTIONS_PER_VIEWER) return null;

  let set = state.subs.get(sub.roomCode);
  if (!set) {
    set = new Set();
    state.subs.set(sub.roomCode, set);
  }
  set.add(sub);
  ensureHeartbeat();

  return () => {
    const cur = state.subs.get(sub.roomCode);
    if (!cur) return;
    cur.delete(sub);
    if (cur.size === 0) state.subs.delete(sub.roomCode);
    if (state.subs.size === 0) stopHeartbeat();
  };
}

/** 推给某房间的全部连接（在座玩家与观众收到的是同一份公开信息）。 */
export function publishToRoom<T>(roomCode: string, event: T, id?: number): void {
  const set = state.subs.get(roomCode);
  if (!set) return;
  const chunk = sseFrame(event, id);
  for (const sub of set) deliverOne(sub, chunk);
}

/**
 * 关掉某房间的全部连接（房间被 GC / 判负后清理时调用）。
 * 客户端表现：EventSource 断开后自动重连 → 服务端 404 → 按规范不再重试 → 页面显示「房间已失效」。
 */
export function closeRoom(roomCode: string): void {
  const set = state.subs.get(roomCode);
  if (!set) return;
  for (const sub of set) {
    try {
      sub.close();
    } catch {
      /* 已关闭 */
    }
  }
  state.subs.delete(roomCode);
  if (state.subs.size === 0) stopHeartbeat();
}

/**
 * 踢掉某用户的**全部**连接（跨房间）。封禁 / 降权 / 专注模式变更时调用。
 * 连接断开后浏览器会自动重连 → 新连接重新走鉴权：已无权 → 403 →
 * EventSource 按规范「fail the connection」不再重试。
 */
export function kickViewer(viewerId: string): void {
  for (const [code, set] of [...state.subs]) {
    for (const sub of [...set]) {
      if (sub.viewerId !== viewerId) continue;
      try {
        sub.close();
      } catch {
        /* 已关闭 */
      }
      set.delete(sub);
    }
    if (set.size === 0) state.subs.delete(code);
  }
  if (state.subs.size === 0) stopHeartbeat();
}

/** 当前在线连接数（诊断用；同一用户多标签页算多条）。 */
export function onlineConnections(): number {
  let n = 0;
  for (const set of state.subs.values()) n += set.size;
  return n;
}

/** 当前有连接的房间数（诊断用）。 */
export function activeRooms(): number {
  return state.subs.size;
}

// ── 心跳 ────────────────────────────────────────────────────────────────────

function ensureHeartbeat(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    for (const set of state.subs.values()) {
      for (const sub of set) deliverOne(sub, ': ping\n\n');
    }
  }, HEARTBEAT_MS);
  // 不因心跳定时器拖住进程退出（测试 / 优雅重启）。Node 的 Timeout 才有 unref，
  // 运行时判一下，不依赖类型定义（同 chat-bus）。
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

function stopHeartbeat(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

/** 仅供测试：清空全部订阅与定时器。 */
export function __resetGameBus(): void {
  state.subs.clear();
  stopHeartbeat();
}
