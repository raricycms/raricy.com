// ─────────────────────────────────────────────────────────────────────────────
// chat-bus.ts — 聊天 SSE 的进程内订阅注册表（服务端专用）
//
// 【为什么是进程内 Map 而不是 Redis】本站是单进程 systemd 部署（见 docs/deploy.md §7），
// 与 rate-limit.ts 的「单进程足够，多实例请换 Redis」是同一个前提。多实例部署时
// A 实例发的消息推不到连在 B 实例的客户端 —— 这是**已知限制**，不是 bug；真要水平
// 扩展，这里就是第一个要换掉的模块。
//
// 【为什么挂 globalThis】Next dev 的热更新会重新求值模块，模块级 Map 会被清空，
// 已建立的 SSE 连接就成了孤儿（还能写、但再也收不到推送）。对齐 db.ts 的单例写法。
//
// 【投递语义】at-most-once 的「尽力推送」：推送失败/背压 → 断开该连接，由浏览器的
// EventSource 自动重连 + Last-Event-ID 补齐（见 api/chat/stream/route.ts）。
// 因此这里**不需要**消息队列或重试，可靠性的兜底在「重连补齐」那一层。
// ─────────────────────────────────────────────────────────────────────────────

import { sseFrame } from './sse';
import type { ChatStreamEvent } from './chat-shared';

// sseFrame 的实现已抽到 ./sse（与游戏 SSE 共用同一份帧格式与响应头常量）。
// 这里重导出，保持既有 import 路径（含 tests/service/chat-bus.test.ts）不变。
export { sseFrame };

/** 心跳间隔：防中间设备（反代 / NAT / 运营商）把空闲长连接掐掉。 */
const HEARTBEAT_MS = 25_000;

export interface ChatSubscriber {
  userId: string;
  /** 连接建立时的专注模式：大区广播要跳过开启者（他进不去大区） */
  focusMode: boolean;
  /** 写入一帧；返回 false 表示下游背压（调用方会断开该连接） */
  write: (chunk: string) => boolean;
  /** 关闭连接（背压时由 bus 调用） */
  close: () => void;
}

interface BusState {
  /** userId → 该用户的全部连接（同一用户可能开着多个标签页） */
  subs: Map<string, Set<ChatSubscriber>>;
  /** 心跳定时器；最后一个订阅者离开时清掉 */
  timer: ReturnType<typeof setInterval> | null;
}

const globalForBus = globalThis as unknown as { __chatBus?: BusState };
const state: BusState = (globalForBus.__chatBus ??= { subs: new Map(), timer: null });

function deliverOne(sub: ChatSubscriber, chunk: string): void {
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

function deliver(set: Set<ChatSubscriber> | undefined, chunk: string): void {
  if (!set) return;
  for (const sub of set) deliverOne(sub, chunk);
}

/** 注册一条连接；返回注销函数（路由在 stream 的 cancel 里调用）。 */
export function subscribe(sub: ChatSubscriber): () => void {
  let set = state.subs.get(sub.userId);
  if (!set) {
    set = new Set();
    state.subs.set(sub.userId, set);
  }
  set.add(sub);
  ensureHeartbeat();

  return () => {
    const cur = state.subs.get(sub.userId);
    if (!cur) return;
    cur.delete(sub);
    if (cur.size === 0) state.subs.delete(sub.userId);
    if (state.subs.size === 0) stopHeartbeat();
  };
}

/** 推给指定用户（私聊：全体成员，含发送者自己的其他标签页）。 */
export function publishToUsers(
  userIds: Iterable<string>,
  event: ChatStreamEvent,
  id?: number
): void {
  const chunk = sseFrame(event, id);
  for (const uid of userIds) deliver(state.subs.get(uid), chunk);
}

/**
 * 广播给所有在线连接（大区消息）。
 * skipFocusMode：专注模式开启者看不到大区，不应收到大区消息（对齐服务端访问控制）。
 */
export function publishToAll(
  event: ChatStreamEvent,
  id?: number,
  opts: { skipFocusMode?: boolean } = {}
): void {
  const chunk = sseFrame(event, id);
  for (const set of state.subs.values()) {
    for (const sub of set) {
      if (opts.skipFocusMode && sub.focusMode) continue;
      deliverOne(sub, chunk);
    }
  }
}

/**
 * 踢掉某用户的全部连接（封禁 / 降权 / 专注模式变更时调用）。
 * 连接断开后浏览器会自动重连 → 新连接重新走 requireChatUser 鉴权：
 *   · 已无权 → 403 → EventSource 按规范「fail the connection」不再重试；
 *   · 只是专注模式变了 → 重连成功并带上新的 focusMode。
 */
export function kickUser(userId: string): void {
  const set = state.subs.get(userId);
  if (!set) return;
  for (const sub of set) {
    try {
      sub.close();
    } catch {
      /* 已关闭 */
    }
  }
  state.subs.delete(userId);
}

/** 当前在线连接数（诊断用；同一用户多标签页算多条）。 */
export function onlineConnections(): number {
  let n = 0;
  for (const set of state.subs.values()) n += set.size;
  return n;
}

// ── 心跳 ────────────────────────────────────────────────────────────────────

function ensureHeartbeat(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    for (const set of state.subs.values()) deliver(set, ': ping\n\n');
  }, HEARTBEAT_MS);
  // 不因心跳定时器拖住进程退出（测试 / 优雅重启）。Node 的 Timeout 才有 unref，
  // 浏览器/Edge 的 setInterval 返回 number —— 运行时判一下，不依赖类型定义。
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

function stopHeartbeat(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

/** 仅供测试：清空全部订阅与定时器。 */
export function __resetChatBus(): void {
  state.subs.clear();
  stopHeartbeat();
}
