// ─────────────────────────────────────────────────────────────────────────────
// topbar-bus.ts — 顶栏指示器 SSE 的进程内订阅注册表（服务端专用）
//
// 【为什么单开一个注册表而不是复用 chat-bus】sse.ts 的文件头说「订阅注册表因生命周期
// 不同而各自实现」—— 这里是那句话的第二个实例：讨论流只在 /chat 页存在，顶栏流在每一页
// 都存在，两者的连接数、鉴权档位、事件类型都不一样。共用一张表会把「踢掉某用户」的语义
// 搅在一起（禁言要踢讨论流，但顶栏流关心的却是别的东西）。
// 真要出现第三条流再来谈合并 —— 两个 Map 的代价，远小于一个语义含糊的通用注册表。
//
// 【单进程前提】与 chat-bus / rate-limit 相同（systemd 单进程部署，见 docs/deploy.md §7）。
// 多实例时 A 实例产生的通知推不到连在 B 实例的客户端 —— **已知限制**。注意它比讨论流
// 更难自愈：讨论漏推可以靠 Last-Event-ID 补齐，顶栏漏推要等下一次重连或兜底轮询。
//
// 【为什么挂 globalThis】Next dev 的热更新会重新求值模块，模块级 Map 会被清空，
// 已建立的 SSE 连接就成了孤儿。对齐 db.ts / chat-bus.ts 的单例写法。
//
// 【投递语义】at-most-once 的「尽力推送」：推送失败/背压 → 断开该连接，由浏览器的
// EventSource 自动重连。可靠性兜底是**重连后的首帧全量快照**（见 api/notifications/stream），
// 所以这里**不需要**消息队列、重试或顺序保证 —— patch 带的是绝对值而非增量，
// 后到的旧帧最多让某个指示器短暂回到旧值，下一次事件或兜底轮询就会纠正。
//
// 【调用方的纪律】publishToUser 绝不抛异常（内部吞掉并断开坏连接）。但**计算值的那一段
// 不在这里**：调用方必须把「算」和「推」一起放进一个同步早退 + 吞异常的函数里，
// 不要写成 `publishToUser(id, { count: await getCount(id) })` —— await 先于调用求值，
// 异常照样逃逸到调用方（见 notification-service 的 pushUnreadCount）。
// ─────────────────────────────────────────────────────────────────────────────

import { SSE_HEARTBEAT_MS, sseFrame } from './sse';

/**
 * 推给客户端的**增量补丁**：只带变化的字段，客户端 merge 进本地状态。
 *
 * 为什么是 patch 而不是全量快照：两个字段的主人不同 —— `count` 只有 notification-service
 * 算得出来，`chatUnread` 只有 chat-service 算得出来（依赖方向所限，见 chat-service 的
 * getChatDotFor）。让每一方只推自己那一格，谁也不必去 import 另一方。
 *
 * 三个字段都是**绝对值**（不是增量）：重复投递、乱序投递都无害。
 */
export interface TopbarPatch {
  /** 站内通知未读数（= /notifications 列表里数得出来的条数，讨论不计入） */
  count?: number;
  /** 讨论红点：私聊有未读 / 大区被 @（口径见 chat-service.getChatUnreadSummary） */
  chatUnread?: boolean;
  /**
   * 「让你的值重算」—— 客户端收到就重新拉一次 /api/notifications/count。
   *
   * 用于**够不着计算函数**的调用点：admin-user-service / user-service 不能 import
   * chat-service（chat-service → admin-user-service → user-service，会成环），
   * 那些地方只能推一个「我不确定新值，你去重算」的信号。闸门因此只有一份。
   */
  refresh?: true;
}

export interface TopbarSubscriber {
  userId: string;
  /** 写入一帧；返回 false 表示下游背压（调用方会断开该连接） */
  write: (chunk: string) => boolean;
  /** 关闭连接（背压时由 bus 调用） */
  close: () => void;
}

interface BusState {
  /** userId → 该用户的全部连接（同一用户可能开着多个标签页） */
  subs: Map<string, Set<TopbarSubscriber>>;
  /** 心跳定时器；最后一个订阅者离开时清掉 */
  timer: ReturnType<typeof setInterval> | null;
}

const globalForBus = globalThis as unknown as { __topbarBus?: BusState };
const state: BusState = (globalForBus.__topbarBus ??= { subs: new Map(), timer: null });

/** 该用户当前有没有活着的连接。**同步**返回 —— 调用方靠它决定要不要去算值。 */
export function hasSubscriber(userId: string): boolean {
  return (state.subs.get(userId)?.size ?? 0) > 0;
}

function deliverOne(sub: TopbarSubscriber, chunk: string): void {
  let ok = true;
  try {
    ok = sub.write(chunk);
  } catch {
    ok = false; // 已关闭的 controller 会抛错 → 当作背压断开处理
  }
  if (!ok) {
    // 背压（客户端读得太慢 / 已经断了）：断开这条连接，让 EventSource 重连后拿首帧快照。
    // 不在服务端无限缓冲，否则慢客户端会变成内存泄漏。
    try {
      sub.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 推一帧给某用户的全部连接。**不抛异常**（写失败按背压断开处理）。
 *
 * 注意它不做「有没有订阅者」的判断 —— 那个判断该由调用方在**算值之前**做（见
 * hasSubscriber 的注释），否则算完了才发现没人听，白花一次查询。
 */
export function publishToUser(userId: string, patch: TopbarPatch): void {
  const set = state.subs.get(userId);
  if (!set) return;
  const chunk = sseFrame(patch);
  for (const sub of set) deliverOne(sub, chunk);
}

/** 注册一条连接；返回注销函数（路由在 stream 的 cancel 里调用）。 */
export function subscribe(sub: TopbarSubscriber): () => void {
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

/**
 * 踢掉某用户的全部顶栏连接。
 *
 * 用于**会话已废**的动作：禁言（会递增 sessionVersion）、重置密码、强制下线。
 * 断开后浏览器自动重连 → 路由重新鉴权 → getCurrentUser() 为 null → 401 →
 * EventSource 按规范 fail the connection，不再重试（这正是我们要的：别空转）。
 *
 * 反过来，**改变了指示器但不废会话**的动作（改角色、专注模式）不要用 kick ——
 * 推一帧 patch 即可；踢了只是让对方重连一次，多一个来回。
 */
export function kickTopbarUser(userId: string): void {
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
    for (const set of state.subs.values()) {
      for (const sub of set) deliverOne(sub, ': ping\n\n');
    }
  }, SSE_HEARTBEAT_MS);
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
export function __resetTopbarBus(): void {
  state.subs.clear();
  stopHeartbeat();
}
