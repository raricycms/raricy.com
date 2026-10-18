// ─────────────────────────────────────────────────────────────────────────────
// saved-message-service.ts — 私聊消息保存箱
//
// 【它是「保存」，不是「收藏」】收藏夹是**可分享的合辑**（公开夹有 6 位句柄 / 二维码 /
// [@ID] / bot 接口，私密夹也能复制成公开、能导出 JSON）。私聊消息恰好相反：只有会话
// 当事人能看。所以两者不共用容器 —— 本功能没有句柄、没有复制、没有导出、没有 bot
// 出口，不是「藏起来」，是**没有那些东西**。把消息塞进收藏夹再逐个出口加锁，用户就得
// 永远记着一条例外规则。
//
// ═══════════════════════════════════════════════════════════════════════════
// 四条不变量 —— 改动前先读完
// ═══════════════════════════════════════════════════════════════════════════
//
// 【1】只存指针，不存正文快照。
//   消息会被作者 / 管理员软删（chat_messages.is_deleted）。快照会让保存箱变成
//   「删了还能读」的后门 —— 读时按当前消息行重新解析，删了给 CHAT_DELETED_TEXT。
//
// 【2】保存范围 = 自己**当前仍是成员**的私聊（kind='direct'）。
//   写入口一次判齐：消息存在 + 未软删 + 频道是 direct + 有成员行。任何一条不满足都
//   返回**同一个** badinput —— 不区分「不存在」与「无权」，否则收藏接口就成了
//   「某条消息是否存在于别人的私聊里」的探针。
//
// 【3】读路径重新判权限，绝不因为「当时存过」就继续可读。
//   成员关系可能没有（历史数据 / 账号处理），频道可能不是私聊，消息可能删了。
//   拿不到就返回 forbidden / deleted 占位，**不返回任何正文、作者或频道信息**。
//
// 【4】唯一约束是物理的、包含墓碑行。
//   (user_id, message_id) 唯一 → 取消保存后再次保存必须**复活旧行**（翻转 deleted），
//   不能新插。顺序按保存行 id（首次保存的先后）—— 复活不会把它挪到最前，与收藏夹
//   条目的口径一致。
//
// 另：软删（deleted / deletedAt），永不物理删；时间戳一律 nowForDb()（本库语义 =
// UTC+8 墙上时间贴 Z，见 db-time.ts）。限频复用 likeHourly / likeDaily 的数值但
// **另起键前缀**（rule 不参与分桶，复用别的前缀会互相吃额度）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { rateLimit, RULES } from './rate-limit';
import {
  CHAT_DELETED_TEXT,
  CHAT_LOBBY_ID,
  CHAT_PREVIEW_MAX,
  stripPreviewTokens,
} from './chat-shared';

/** 每人保存箱上限。只数未取消的（取消能把名额让出来，同收藏夹条目口径）。 */
export const SAVED_MESSAGE_MAX = 1000;

/** 单页上限（页面与将来可能的接口共用）。 */
export const SAVED_MESSAGE_PAGE_MAX = 100;

export type SavedMessageFailReason = 'badinput' | 'rateLimited' | 'limit';

export type SavedMessageResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: SavedMessageFailReason };

/**
 * 解析消息 id。消息 id 是**全局自增正整数**（大区与私聊共用一个序列），但对外一律
 * 当「十进制字符串 + 严格正整数」处理：拒绝 0 / 负数 / 小数 / 前导零 / 科学计数法。
 *
 * 为什么拒绝前导零：唯一约束是字符串之外的另一层 —— DB 里 message_id 是 INTEGER，
 * 前置零会被 SQLite 归一化，风险小；但 route 的 path/body 可能来自任意客户端，
 * 统一成「先归一化再查」比「依赖 SQLite 的亲和性」可靠。
 */
export function parseMessageId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 数自己未取消保存的条数（软删的墓碑行不计）。 */
export async function countSavedMessages(userId: string): Promise<number> {
  return prisma.savedChatMessage.count({ where: { userId, deleted: false } });
}

/** 消息预览：与侧栏 / 通知摘要同一口径（内联 token → 短标记；附件给占位词）。 */
function previewOfMessage(m: {
  content: string;
  imageId: string | null;
  blogId: string | null;
  patTargetId: string | null;
}): string {
  const collapsed = stripPreviewTokens(m.content).replace(/\s+/g, ' ').trim();
  const display = collapsed
    ? collapsed
    : m.imageId
      ? '[图片]'
      : m.blogId
        ? '[博客]'
        : m.patTargetId
          ? '[拍一拍]'
          : '';
  return display.length > CHAT_PREVIEW_MAX
    ? `${display.slice(0, CHAT_PREVIEW_MAX)}…`
    : display;
}

/**
 * 保存一条消息。幂等：已经保存过就返回成功（不重复计数、不占名额）。
 *
 * 限频在**任何校验之前**：随机 id 探测也要消耗额度，而不是免费打库。
 */
export async function saveMessage(
  userId: string,
  rawMessageId: unknown
): Promise<SavedMessageResult<{ count: number; savedId: number }>> {
  const gateH = rateLimit(`chat:saved:h:${userId}`, RULES.likeHourly);
  const gateD = rateLimit(`chat:saved:d:${userId}`, RULES.likeDaily);
  if (!gateH.allowed || !gateD.allowed) return { ok: false, reason: 'rateLimited' };

  const messageId = parseMessageId(rawMessageId);
  if (messageId == null) return { ok: false, reason: 'badinput' };

  // 不变量 2：一次判齐「存在 + 未删 + 私聊 + 我是成员」。
  // ⚠️ 失败一律 badinput（同一条文案），不区分不存在 / 别人的私聊 —— 否则本接口
  //    就是消息存在性探针。
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      channelId: true,
      isDeleted: true,
      channel: { select: { kind: true } },
      // 作者已注销 = 消息在讨论区里已经按「已删除」渲染（attachImagesAndReplies
      // 同一口径）。这种消息不该再被新存进保存箱 —— 存进去立刻就是占位。
      author: { select: { archivedAt: true } },
    },
  });
  if (!msg || msg.isDeleted || msg.author.archivedAt || msg.channel.kind !== 'direct') {
    return { ok: false, reason: 'badinput' };
  }
  const member = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId: msg.channelId, userId } },
    select: { id: true },
  });
  if (!member) return { ok: false, reason: 'badinput' };

  // 已保存（活着）→ 幂等成功。先于配额检查：满额时重复保存不该报错。
  const existing = await prisma.savedChatMessage.findUnique({
    where: { userId_messageId: { userId, messageId } },
    select: { id: true, deleted: true },
  });
  if (existing && !existing.deleted) {
    return { ok: true, count: await countSavedMessages(userId), savedId: existing.id };
  }

  if ((await countSavedMessages(userId)) >= SAVED_MESSAGE_MAX) {
    return { ok: false, reason: 'limit' };
  }

  // 不变量 4：墓碑行存在时复活它，不新插（唯一约束是物理的）。
  const saved = await prisma.savedChatMessage.upsert({
    where: { userId_messageId: { userId, messageId } },
    create: { userId, messageId, createdAt: nowForDb() },
    update: { deleted: false, deletedAt: null },
    select: { id: true },
  });
  return { ok: true, count: await countSavedMessages(userId), savedId: saved.id };
}

/**
 * 取消保存（软删）。幂等：没保存过 / 已取消也返回成功。
 *
 * 刻意**不限频**：它只改自己名下的一行，而且必须永远能做 —— 额度满了以后
 * 连取消都要被卡，用户就只能等窗口过去才腾得出名额。
 */
export async function unsaveMessage(
  userId: string,
  rawMessageId: unknown
): Promise<SavedMessageResult<{ count: number }>> {
  const messageId = parseMessageId(rawMessageId);
  if (messageId == null) return { ok: false, reason: 'badinput' };

  await prisma.savedChatMessage.updateMany({
    where: { userId, messageId, deleted: false },
    data: { deleted: true, deletedAt: nowForDb() },
  });
  return { ok: true, count: await countSavedMessages(userId) };
}

export type SavedMessageState = 'ok' | 'deleted' | 'forbidden';

export interface SavedMessageItem {
  /** 保存行 id —— 列表游标用它（不是消息 id）。 */
  savedId: number;
  messageId: number;
  /** 可跳转的频道 / 消息；forbidden 时为 null（不给任何定位信息）。 */
  channelId: string | null;
  /** 私聊对端用户名；拿不到（无权 / 频道没了）为 null。 */
  channelTitle: string | null;
  authorName: string | null;
  preview: string;
  messageCreatedAt: Date | null;
  savedAt: Date | null;
  state: SavedMessageState;
}

export interface SavedMessagePage {
  items: SavedMessageItem[];
  hasMore: boolean;
  /** 下一页游标（传回 before）；没有更早的为 null。 */
  nextBefore: number | null;
  /** 未取消保存的总条数（页面头部显示，不受分页影响）。 */
  total: number;
}

/**
 * 列出保存箱（**只限本人**；本函数没有 viewerId 以外的入口）。
 *
 * 读路径重新判定每一条的当前状态 —— 保存过不是永久通行证：
 *   · 消息被删 / 作者注销 → deleted，preview 固定为 CHAT_DELETED_TEXT；
 *   · 频道没了 / 不再是私聊 / 我已不是成员 → forbidden，**不返回正文、作者、频道**；
 *   · 其余 → ok。
 * 这让「取消保存」之外还多了一条用户无法控制的退出（被移出频道），而且是安全的失败方向。
 */
export async function listSavedMessages(
  userId: string,
  opts: { before?: number; limit?: number } = {}
): Promise<SavedMessagePage> {
  const limit = Math.min(
    SAVED_MESSAGE_PAGE_MAX,
    Math.max(1, opts.limit ?? 50)
  );
  const before = parseMessageId(opts.before);

  const rows = await prisma.savedChatMessage.findMany({
    where: {
      userId,
      deleted: false,
      ...(before != null ? { id: { lt: before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: { id: true, messageId: true, createdAt: true },
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const total = await countSavedMessages(userId);
  if (pageRows.length === 0) {
    return { items: [], hasMore: false, nextBefore: null, total };
  }

  const messageIds = pageRows.map((r) => r.messageId);
  const messages = await prisma.chatMessage.findMany({
    where: { id: { in: messageIds } },
    select: {
      id: true,
      channelId: true,
      authorId: true,
      content: true,
      imageId: true,
      blogId: true,
      patTargetId: true,
      isDeleted: true,
      createdAt: true,
      author: { select: { username: true, archivedAt: true } },
    },
  });
  const msgById = new Map(messages.map((m) => [m.id, m]));

  const channelIds = [...new Set(messages.map((m) => m.channelId))];
  const channels = channelIds.length
    ? await prisma.chatChannel.findMany({
        where: { id: { in: channelIds } },
        select: { id: true, kind: true },
      })
    : [];
  const channelById = new Map(channels.map((c) => [c.id, c]));

  // 我当前仍是成员的频道（读路径重新判权限）。
  const myMemberships = channelIds.length
    ? await prisma.chatMember.findMany({
        where: { userId, channelId: { in: channelIds } },
        select: { channelId: true },
      })
    : [];
  const myChannels = new Set(myMemberships.map((m) => m.channelId));

  // 私聊对端：一次批量取（不要逐条 N+1）。注意 ChatMember 没有归档过滤，
  // 嵌套 user 可能拿到已注销作者 —— 只用来显示标题，注销时退回「私聊」。
  const peers = channelIds.length
    ? await prisma.chatMember.findMany({
        where: { channelId: { in: channelIds }, userId: { not: userId } },
        select: { channelId: true, user: { select: { username: true, archivedAt: true } } },
      })
    : [];
  const peerTitleByChannel = new Map(
    peers.map((p) => [
      p.channelId,
      p.user.archivedAt ? '私聊' : p.user.username,
    ])
  );

  const items: SavedMessageItem[] = pageRows.map((row) => {
    const msg = msgById.get(row.messageId);
    const base = {
      savedId: row.id,
      messageId: row.messageId,
      savedAt: row.createdAt,
    };

    // 消息行不见了（理论上只可能来自物理删；本库没有物理删）→ 与「已删除」同形。
    if (!msg) {
      return {
        ...base,
        channelId: null,
        channelTitle: null,
        authorName: null,
        preview: CHAT_DELETED_TEXT,
        messageCreatedAt: null,
        state: 'deleted' as const,
      };
    }

    const channel = channelById.get(msg.channelId);
    const stillMember = myChannels.has(msg.channelId);
    if (!channel || channel.kind !== 'direct' || !stillMember) {
      return {
        ...base,
        channelId: null,
        channelTitle: null,
        authorName: null,
        preview: '',
        messageCreatedAt: null,
        state: 'forbidden' as const,
      };
    }

    const channelTitle = peerTitleByChannel.get(msg.channelId) ?? '私聊';

    // 消息删除 / 作者注销 → 只给占位（不变量 1：绝不回退到原始正文）。
    if (msg.isDeleted || msg.author.archivedAt) {
      return {
        ...base,
        channelId: msg.channelId,
        channelTitle,
        authorName: null,
        preview: CHAT_DELETED_TEXT,
        messageCreatedAt: null,
        state: 'deleted' as const,
      };
    }

    return {
      ...base,
      channelId: msg.channelId,
      channelTitle,
      authorName: msg.author.username,
      preview: previewOfMessage(msg),
      messageCreatedAt: msg.createdAt,
      state: 'ok' as const,
    };
  });

  return {
    items,
    hasMore,
    nextBefore: hasMore ? pageRows[pageRows.length - 1].id : null,
    total,
  };
}

export type SavedMessageIdsResult =
  | { ok: true; ids: number[] }
  | { ok: false; reason: 'forbidden' | 'notfound' };

/**
 * 某频道里「我保存过的消息 id」—— 消息列表首屏渲染保存按钮状态用。
 *
 * 只对**私聊**有意义（保存箱只收私聊消息）：大区直接返回空数组而不是 403，
 * 免得聊天页每进一次大区都打一条错误日志。成员判定仍要做 —— 不是成员就不该
 * 知道「这个频道里我有没有保存过什么」。
 */
export async function listSavedMessageIds(
  userId: string,
  channelId: string
): Promise<SavedMessageIdsResult> {
  // 大区成员行 / 频道行可能尚未懒建（服务端 `ensureLobbyChannel` 才建），而我们只
  // 需要知道「保存箱在大区里没有东西」—— 直接答空，不要为一条空查询去建行。
  if (channelId === CHAT_LOBBY_ID) return { ok: true, ids: [] };

  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { kind: true },
  });
  if (!channel) return { ok: false, reason: 'notfound' };
  if (channel.kind !== 'direct') return { ok: true, ids: [] };

  const member = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId, userId } },
    select: { id: true },
  });
  if (!member) return { ok: false, reason: 'forbidden' };

  const rows = await prisma.savedChatMessage.findMany({
    where: { userId, deleted: false, message: { channelId } },
    select: { messageId: true },
  });
  return { ok: true, ids: rows.map((r) => r.messageId) };
}
