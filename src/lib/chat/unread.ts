// unread.ts — 讨论未读与顶栏红点：汇总口径、红点判定、SSE 推送
//
// 【未读不进铃铛】讨论消息不进通知列表、也不进铃铛数字。铃铛数 = getUnreadCount，
// **必须等于 `/notifications` 列表里数得出来的条目数**；讨论未读改由顶栏「讨论」
// 链接上的小红点体现。所以 `/api/notifications/count` 另出一个 `chatUnread` 布尔
// （来自 getChatUnreadSummary：私聊有未读 / 大区被 @），base.js 据此点亮
// `#chatUnreadDot`。**别把它并回 count** —— 那会让铃铛写着 5、点进去只有 2 条。
// 唯一进列表的是 @ 提及，且**读了就清**：进这个会话（markChannelRead，见 messages.ts）
// 即标已读 —— 铃铛上还挂着就说明人还没看那个会话；正在看时连条目都不产生
// （见 messages.ts 的 notifyChannelMentions）。
//
// 【红点的三道闸门：core+ / 未禁言 / 专注模式】全部收在 getChatDotFor 里，count 路由
// 与 SSE 推送路径**共用同一份**。历史上它曾内联在 count 路由里，留两份必然 drift ——
// 别搬回去。
//
// 【纯读】getChatUnreadSummary / getChatDotFor 不懒建大区成员行 —— 顶栏轮询与 SSE
// 推送都是读路径，不能写库。没有成员行 = 从未进过讨论室 = 无未读（与
// ensureLobbyMembership 的「历史不算未读」同一口径）。
// pushChatDot 只做推送：同步早退（没人连着不去算）、算值放在 try 内（调用点写的是
// `void pushChatDot(...)`，await 写在调用外面会让异常逃逸）、不 await 不抛（有兜底
// 轮询收敛）。它是**真算**（3~5 次查询），只在红点**可能**变了时调；大区普通消息
// 不可能改变红点（红点只认 @），别推。

import { prisma } from '../db';
import { isCoreUser, isCurrentlyBanned } from '../auth';
import { isFocusLobbyBlocked } from '../focus-mode';
import { hasSubscriber, publishToUser } from '../topbar-bus';
import { CHAT_KIND_LOBBY } from './constants';
import { countUnreadByChannel, countLobbyMentionsSince } from './counters';

export interface ChatUnreadSummary {
  /** 私聊未读条数合计（大区普通消息不算，口径与侧栏一致） */
  count: number;
  /** 大区未读里有 @ 到我（公共频道不显数字，只值得一个红点） */
  dot: boolean;
}

/**
 * 顶栏「讨论」链接上那个小红点用的未读汇总。讨论消息不进通知列表（见 sendMessage），
 * 未读也不算进铃铛数字（那会让数字大于列表条目数）—— 两条都归到「讨论」红点上，
 * 由 /api/notifications/count 把它压成一个 chatUnread 布尔。所以口径必须与侧栏
 * hasUnreadMark **完全一致**：
 *   • 私聊 → 未读条数（count）；
 *   • 大区 → 只在未读里有 @ 我时算（dot，普通消息不打扰）；
 *   • 静音会话 → 不计（静音 = 别在顶栏上打扰我；侧栏徽标照常，静音 ≠ 已读）；
 *   • 已隐藏（「删除会话」）且此后没有新消息 → 不计（与侧栏不显示它同一口径）；
 *   • 「屏蔽讨论大区」 → 大区不计（大区对开启者不可见）。
 *
 * 调用方不区分 count / dot：红点只看「有没有」。拆成两个字段是为了保住「私聊计条数、
 * 大区只认 @」这条口径本身（侧栏与测试都在用），不是为了在顶栏显示数字。
 *
 * **纯读**：不懒建大区成员行 —— 本函数既喂顶栏轮询、也被 SSE 推送路径调用，
 * 两条路都是读路径，不能写库。
 * 没有成员行 = 从未进过讨论室 = 无未读，语义正好（与 ensureLobbyMembership 的
 * 「历史不算未读」同一口径）。
 */
export async function getChatUnreadSummary(
  userId: string,
  lobbyBlocked = false
): Promise<ChatUnreadSummary> {
  const memberships = await prisma.chatMember.findMany({
    where: { userId, mutedAt: null },
    select: {
      channelId: true,
      lastReadMessageId: true,
      hiddenAfterMessageId: true,
      channel: { select: { kind: true } },
    },
  });
  if (!memberships.length) return { count: 0, dot: false };

  const unreadByChannel = await countUnreadByChannel(
    userId,
    memberships.map((m) => m.channelId)
  );

  // 已隐藏且此后没有新消息 → 不计。判据与 listChannelsForUser 一致：比「隐藏时的
  // 频道最大消息 id」大才算「隐藏之后又来了新消息」（新消息 id 更大 → 会话重新出现）。
  const hiddenIds = memberships
    .filter((m) => m.hiddenAfterMessageId != null)
    .map((m) => m.channelId);
  const maxIdByChannel = new Map<string, number>();
  if (hiddenIds.length) {
    const maxRows = await prisma.chatMessage.groupBy({
      by: ['channelId'],
      where: { channelId: { in: hiddenIds }, isDeleted: false },
      _max: { id: true },
    });
    for (const r of maxRows) maxIdByChannel.set(r.channelId, r._max.id ?? 0);
  }

  let count = 0;
  let dot = false;
  for (const m of memberships) {
    if ((unreadByChannel.get(m.channelId) ?? 0) <= 0) continue;
    const hiddenAfter = m.hiddenAfterMessageId;
    if (hiddenAfter != null && (maxIdByChannel.get(m.channelId) ?? 0) <= hiddenAfter) continue;

    if (m.channel.kind === CHAT_KIND_LOBBY) {
      if (!lobbyBlocked && (await countLobbyMentionsSince(userId, m.lastReadMessageId)) > 0) {
        dot = true;
      }
    } else {
      count += unreadByChannel.get(m.channelId) ?? 0;
    }
  }
  return { count, dot };
}

/**
 * 顶栏红点该不该亮 —— `getChatUnreadSummary` 的**布尔化**，把「core+ / 未禁言」这两道
 * 闸门收进这里。原先它们内联在 /api/notifications/count 里，现在推送路径也要同一套判断，
 * 留两份必然 drift（一处改了另一处不改，红点与轮询各说各话）。
 *
 * 需要自己取一次 user 行：推送路径发生在某个写操作的末尾，那里手上只有 userId。
 * 按主键读一次，代价可忽略。
 *
 * 与 getChatUnreadSummary 同样是**纯读**（不懒建大区成员行）——见那边的说明。
 */
export async function getChatDotFor(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, focusMode: true, focusBlockLobby: true, isBanned: true, banUntil: true },
  });
  // 非 core+ / 禁言中：进不了讨论页，红点自然不该亮（对齐 count 路由的口径）
  if (!isCoreUser(u) || isCurrentlyBanned(u)) return false;

  const summary = await getChatUnreadSummary(userId, isFocusLobbyBlocked(u));
  return summary.count > 0 || summary.dot;
}

/**
 * 把该用户**最新的红点状态**推给顶栏（SSE）。
 *
 * 三条纪律同 notification-service.pushUnreadCount：同步早退（没人连着不去算）、
 * 算值放在 try 内（调用点写的是 `void pushChatDot(...)`，把 await 写在调用外面会让异常
 * 逃逸到调用方）、不 await 不抛（有兜底轮询收敛）。
 *
 * ⚠️ 这里是**真算**（3~5 次查询），所以调用点要克制 —— 只在红点**可能**变了时调。
 * 典型反例：大区普通消息。红点只认 @（见 getChatUnreadSummary），普通消息不可能改变
 * 它的值，别推。
 *
 * 仅供 chat/ 内部跨模块使用（channels/messages 的写路径触发重算），不从 barrel 导出。
 */
export async function pushChatDot(userId: string): Promise<void> {
  if (!hasSubscriber(userId)) return;
  try {
    publishToUser(userId, { chatUnread: await getChatDotFor(userId) });
  } catch {
    /* 推送失败无声：兜底轮询会纠正 */
  }
}
