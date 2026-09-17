// ─────────────────────────────────────────────────────────────────────────────
// chat-presence.ts — 「谁正在看哪个会话」（服务端专用，进程内）
//
// 【它服务的一件事】被 @ 的时候，人要是**正开着眼睛看**这个会话，就别再发通知了
// —— 他当场就看见了。唯一的消费方是 chat-service.notifyChannelMentions 的逐人闸门。
//
// 【「在看」的判据是三条同时成立】
//   1. 客户端报到过这个频道（POST /api/chat/channels/:id/viewing）；
//   2. 报到没过期（VIEWING_TTL_MS）；
//   3. 该用户此刻有活着的讨论流连接（chat-bus.hasSubscriber）。
// 第 3 条是最要紧的：讨论流只在 /chat 页存在，且标签页一藏起来客户端就主动关掉它，
// 所以「关页面 / 切后台 / 切到别的网站」这些**离开**动作都不用客户端额外报 ——
// 连接没了，判据立刻不成立。TTL 只是在「页面还开着、但人已经切到别的会话」这类
// 角落里兜底（那种情况下客户端的切频道报到通常已经把它覆盖掉了）。
//
// 【为什么不从 /read 推断】/read 是「读到哪了」，不是「人在不在」：
//   • 机器人也在调它（docs/bot/chat-bot.md §7.6），「读了一下」≠「人在看」；
//   • 它只在有新消息时才发得出来 —— 人盯着一个安静的大区看时反而没有 /read。
// 所以「在看」由客户端显式报，与读游标彻底分家。
//
// 【单进程前提】与 chat-bus / topbar-bus / rate-limit 相同（systemd 单进程部署）。
// 多实例下报到的实例与发消息的实例可能不是同一个 → 判不出「在看」→ **照常发通知**。
// 也就是说它坏掉的方向是「多打扰一次」，不是「静默丢一条」（见下）。
//
// 【失败方向永远是「照常发通知」】报到没到、超时、HMR 清了这张表、多实例 ——
// 一律退化成没有本模块时的行为：发通知，然后对方进会话时被 markChannelRead 清掉
// （见 chat-service）。宁可多打扰一次，也不静默吞掉一条「有人叫你」。
//
// 【为什么挂 globalThis】Next dev 的热更新会重新求值模块，模块级 Map 会被清空
// —— 清空本身无害（退化成照常发通知），但保持一致的单例写法更好排查。
// ─────────────────────────────────────────────────────────────────────────────

import { hasSubscriber } from './chat-bus';

/**
 * 报到有效期。
 *
 * 客户端每 60s 续一次（ChatApp.VIEWING_PING_MS），这里给到 2.5 倍 —— 容忍一次
 * 漏报（浏览器对后台标签页的定时器有节流，虽然那种情况连接已经断了）。
 * 别为了「更准」把它调小：调小只会让「在看」更容易判不出来，也就是多打扰几次。
 */
export const VIEWING_TTL_MS = 150_000;

interface BusState {
  /** userId → 最近一次「我在看这个频道」的报到 */
  viewing: Map<string, { channelId: string; at: number }>;
}

const globalForState = globalThis as unknown as { __chatPresence?: BusState };
const state: BusState = (globalForState.__chatPresence ??= { viewing: new Map() });

/** 记下「这个人正在看这个频道」。频道是否存在 / 有无权限由调用方先判（见 viewing 路由）。 */
export function reportViewing(userId: string, channelId: string): void {
  state.viewing.set(userId, { channelId, at: Date.now() });
}

/**
 * 这个人此刻是不是正看着这个频道（判据见文件头）。
 *
 * 顺带清掉自己的过期条目 —— 不另开定时器，也别指望有人会来「注销」：
 * 过期条目只是内存里一个不会再命中的键，最坏情况是每个来过的用户留一条。
 */
export function isViewingChannel(userId: string, channelId: string): boolean {
  const rec = state.viewing.get(userId);
  if (!rec) return false;
  if (Date.now() - rec.at > VIEWING_TTL_MS) {
    state.viewing.delete(userId);
    return false;
  }
  if (rec.channelId !== channelId) return false;
  // 连接没了 = 页面关了 / 切后台了 / 断线了 → 「在看」立刻不成立
  return hasSubscriber(userId);
}

/** 仅供测试：清空全部报到。 */
export function __resetChatPresence(): void {
  state.viewing.clear();
}
