// ─────────────────────────────────────────────────────────────────────────────
// chat-service.ts — 在线聊天区业务逻辑
//
// 会话模型：
//   • 全局「聊天大区」：chat_channels 里固定一行 kind='lobby'、id='lobby'
//     （迁移 4_chat 种子化；服务层也兜底 upsert，保证测试库无种子也能跑）。
//     core+ 用户均可看可发，无需成员关系。
//   • 私聊：kind='direct'，恰好两名成员（发起时一起建成员行）。
//   • 读游标：chat_members.last_read_message_id；未读数 = 频道内 id > 游标且未软删。
//     大区成员行懒创建，基线 = 当时最大消息 id（从未进过聊天室不把历史算未读）。
//
// 消息：id 自增整数（增量拉取 / 读游标基准）。软删除 is_deleted（对齐评论），永不物理删。
// 正文纯文本入库（前端 JSX 自动转义渲染，无 contentHtml）；图片仅存 image_hosting 引用，
// 发送时强校验「图片归本人所有且未软删」。限频仿博客评论：资源存在性校验通过后才扣额度。
//
// 时间戳一律 nowForDb()（本库语义 = UTC+8 墙上时间贴 Z，见 db-time.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { hasAdminRights } from './auth';
import { rateLimit, RULES } from './rate-limit';
import { sendCoalescedChatNotification } from './notification-service';
import { logAdminAction } from './admin-user-service';
import {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  type ChatAuthorDTO,
  type ChatMessageDTO,
  type ChatChannelDTO,
  type ChatUserLite,
} from './chat-shared';
import type { Prisma } from '@prisma/client';

// 复用 chat-shared 的常量/类型（同时向后兼容旧导入路径）
export {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  type ChatAuthorDTO,
  type ChatImageDTO,
  type ChatReplyDTO,
  type ChatMessageDTO,
  type ChatChannelDTO,
  type ChatUserLite,
} from './chat-shared';

// ── 常量 ─────────────────────────────────────────────────────────────────────

export const CHAT_KIND_LOBBY = 'lobby';
export const CHAT_KIND_DIRECT = 'direct';
export const CHAT_TEXT_MAX = 1000; // 纯文本消息上限
export const CHAT_CAPTION_MAX = 500; // 带图消息的图注上限
export const CHAT_INITIAL_LIMIT = 50; // 首次加载 / 每页拉取条数
export const CHAT_PREVIEW_MAX = 60; // 侧栏消息预览截断
const CORE_ROLES = ['core', 'admin', 'owner'];

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  authorId: true,
  content: true,
  imageId: true,
  replyTo: true,
  isDeleted: true,
  createdAt: true,
  author: { select: { id: true, username: true, role: true } },
} satisfies Prisma.ChatMessageSelect;

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

function authorOf(a: { id: string; username: string; role: string }): ChatAuthorDTO {
  return {
    id: a.id,
    username: a.username,
    avatar_url: `/api/avatar/${a.id}`,
    is_admin: hasAdminRights(a),
  };
}

function isForeignKeyViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Prisma.PrismaClientKnownRequestError).code === 'P2003'
  );
}

// ── 内部工具：频道与成员 ─────────────────────────────────────────────────────

/** 幂等建大区频道行（生产由迁移种子化；测试库空表时兜底）。 */
export async function ensureLobbyChannel(): Promise<{ id: string; kind: string }> {
  const existing = await prisma.chatChannel.findUnique({ where: { id: CHAT_LOBBY_ID } });
  if (existing) return existing;
  return prisma.chatChannel.create({
    data: { id: CHAT_LOBBY_ID, kind: CHAT_KIND_LOBBY, createdAt: nowForDb() },
  });
}

/** 幂等建大区成员行：新成员基线 = 当前最大消息 id（历史不算未读）。 */
export async function ensureLobbyMembership(userId: string): Promise<{ lastReadMessageId: number }> {
  await ensureLobbyChannel();
  const existing = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId: CHAT_LOBBY_ID, userId } },
    select: { lastReadMessageId: true },
  });
  if (existing) return existing;
  const agg = await prisma.chatMessage.aggregate({
    where: { channelId: CHAT_LOBBY_ID },
    _max: { id: true },
  });
  const baseline = agg._max.id ?? 0;
  await prisma.chatMember.create({
    data: {
      channelId: CHAT_LOBBY_ID,
      userId,
      lastReadMessageId: baseline,
      createdAt: nowForDb(),
    },
  });
  return { lastReadMessageId: baseline };
}

/** 取一个成员的读游标；大区成员缺失时懒建。私聊缺成员 = 未授权，返回 null。 */
async function readCursorFor(channelId: string, userId: string): Promise<number | null> {
  const row = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId, userId } },
    select: { lastReadMessageId: true },
  });
  if (row) return row.lastReadMessageId;
  if (channelId === CHAT_LOBBY_ID) {
    return (await ensureLobbyMembership(userId)).lastReadMessageId;
  }
  return null;
}

/**
 * 访问判定：
 *   • 大区：core+ 一律可访问；
 *   • 私聊：必须是成员。
 * 返回是否允许（调用方已在上层把好 core 关）。
 */
export async function canAccessChannel(
  channelId: string,
  userId: string
): Promise<{ allowed: boolean; kind: string | null }> {
  // 大区行在迁移里种子化；测试库空表时兜底建，保证 sendMessage 等直接走大区的路径不炸
  if (channelId === CHAT_LOBBY_ID) await ensureLobbyChannel();
  const ch = await prisma.chatChannel.findUnique({ where: { id: channelId } });
  if (!ch) return { allowed: false, kind: null };
  if (ch.kind === CHAT_KIND_LOBBY) return { allowed: true, kind: ch.kind };
  const member = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId, userId } },
  });
  return { allowed: !!member, kind: ch.kind };
}

// ── 频道：列表 + 未读 ───────────────────────────────────────────────────────

/**
 * 拉当前用户的全部频道（大区 + 私聊），带 peer、未读数、最后一条消息预览。
 * 大区固定置顶；私聊按「有未读优先，其次最近活跃」排序。
 */
export async function listChannelsForUser(userId: string): Promise<ChatChannelDTO[]> {
  await ensureLobbyChannel();
  const myMemberships = await prisma.chatMember.findMany({
    where: { userId },
    select: { channelId: true },
  });

  const ids = new Set([CHAT_LOBBY_ID, ...myMemberships.map((m) => m.channelId)]);
  const channels = await prisma.chatChannel.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, kind: true, members: { select: { userId: true } } },
  });

  const out = await Promise.all(
    channels.map(async (ch) => {
      const isLobby = ch.kind === CHAT_KIND_LOBBY;
      let cursor = await readCursorFor(ch.id, userId);
      if (cursor === null) {
        // 私聊但缺成员行（理论上不会）→ 跳过
        return null;
      }
      const [unread, last] = await Promise.all([
        prisma.chatMessage.count({
          where: { channelId: ch.id, id: { gt: cursor }, isDeleted: false },
        }),
        prisma.chatMessage.findFirst({
          where: { channelId: ch.id, isDeleted: false },
          orderBy: { id: 'desc' },
          select: { id: true, content: true, createdAt: true, author: { select: { username: true } } },
        }),
      ]);

      let peer: { id: string; username: string } | null = null;
      let title = CHAT_LOBBY_TITLE;
      if (!isLobby) {
        const otherId = ch.members.find((m) => m.userId !== userId)?.userId;
        if (otherId) {
          const u = await prisma.user.findUnique({
            where: { id: otherId },
            select: { id: true, username: true },
          });
          peer = u ?? null;
          title = u?.username ?? '私聊';
        } else {
          title = '私聊';
        }
      }

      const lm = last
        ? {
            id: last.id,
            content: (() => {
              const collapsed = last.content.replace(/\s+/g, ' ').trim();
              return collapsed.length > CHAT_PREVIEW_MAX
                ? `${collapsed.slice(0, CHAT_PREVIEW_MAX)}…`
                : collapsed;
            })(),
            author_name: last.author.username,
            created_at: last.createdAt ? last.createdAt.toISOString() : null,
          }
        : null;

      return {
        id: ch.id,
        kind: ch.kind as 'lobby' | 'direct',
        title,
        peer,
        unread_count: unread,
        last_message: lm,
        _order: isLobby ? -1 : unread > 0 ? 0 : 1,
        _lastId: lm?.id ?? 0,
      };
    })
  );

  const valid = out.filter((x): x is NonNullable<typeof x> => x !== null);
  valid.sort((a, b) => a._order - b._order || b._lastId - a._lastId);
  return valid.map(({ _order, _lastId, ...dto }) => dto);
}

// ── 私聊频道 ────────────────────────────────────────────────────────────────

export type StartDirectResult =
  | { ok: true; channel: ChatChannelDTO }
  | { ok: false; error: 'forbidden' | 'self' | 'notFound'; message: string };

/**
 * 发起/复用与某用户的私聊：存在互为成员且 kind='direct' 的频道则直接返回，否则新建。
 * 目标用户必须是 core+（只有 core+ 能进聊天），且不能是自己。
 */
export async function startDirectChannel(meId: string, otherId: string): Promise<StartDirectResult> {
  if (otherId === meId) return { ok: false, error: 'self', message: '不能和自己私聊' };

  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true, role: true } });
  if (!other || !CORE_ROLES.includes(other.role)) {
    return { ok: false, error: 'notFound', message: '对方不存在或无权使用聊天' };
  }

  // 复用：找我参与的 direct 频道里，另一方包含 otherId 的那个
  const myDirectIds = (
    await prisma.chatMember.findMany({
      where: { userId: meId, channel: { kind: CHAT_KIND_DIRECT } },
      select: { channelId: true },
    })
  ).map((m) => m.channelId);

  if (myDirectIds.length) {
    const existing = await prisma.chatMember.findFirst({
      where: { userId: otherId, channelId: { in: myDirectIds } },
      select: { channelId: true },
    });
    if (existing) {
      const list = await listChannelsForUser(meId);
      const ch = list.find((c) => c.id === existing.channelId);
      return { ok: true, channel: ch ?? (await toChannelDto(meId, existing.channelId))! };
    }
  }

  const id = crypto.randomUUID();
  const now = nowForDb();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.chatChannel.create({ data: { id, kind: CHAT_KIND_DIRECT, createdAt: now } });
      await tx.chatMember.create({
        data: { channelId: id, userId: meId, lastReadMessageId: 0, createdAt: now },
      });
      await tx.chatMember.create({
        data: { channelId: id, userId: otherId, lastReadMessageId: 0, createdAt: now },
      });
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { ok: false, error: 'notFound', message: '对方不存在' };
    }
    throw e;
  }

  const dto = await toChannelDto(meId, id);
  return { ok: true, channel: dto! };
}

/** 单频道 DTO（供发消息/建会话后刷新）。非成员或不存在返回 null。 */
export async function toChannelDto(userId: string, channelId: string): Promise<ChatChannelDTO | null> {
  const list = await listChannelsForUser(userId);
  return list.find((c) => c.id === channelId) ?? null;
}

// ── 消息 ────────────────────────────────────────────────────────────────────

async function attachImagesAndReplies(rows: MessageRow[]): Promise<ChatMessageDTO[]> {
  if (!rows.length) return [];

  // 图片：只关心是否仍可展示（存在且未软删）。图床图片一律以原始 URL 渲染。
  const imageIds = [...new Set(rows.map((r) => r.imageId).filter(Boolean))] as string[];
  const imageMap = new Map<string, { id: string; mimeType: string }>();
  if (imageIds.length) {
    const imgs = await prisma.imageHosting.findMany({
      where: { id: { in: imageIds }, ignore: false },
      select: { id: true, mimeType: true },
    });
    for (const i of imgs) imageMap.set(i.id, i);
  }

  // 引用回复：批量按 replyTo 取（同频道、分页子集内），软删的回复照常给出占位。
  const replyIds = [...new Set(rows.map((r) => r.replyTo).filter((v): v is number => v != null))];
  const replyMap = new Map<number, { id: number; content: string; isDeleted: boolean | null; author: { username: string } }>();
  if (replyIds.length) {
    const reps = await prisma.chatMessage.findMany({
      where: { id: { in: replyIds } },
      select: {
        id: true,
        content: true,
        isDeleted: true,
        author: { select: { username: true } },
      },
    });
    for (const r of reps) replyMap.set(r.id, r);
  }

  return rows.map((m) => {
    const deleted = m.isDeleted ?? false;
    const img = m.imageId ? imageMap.get(m.imageId) : undefined;
    const reply = m.replyTo != null ? replyMap.get(m.replyTo) : undefined;
    return {
      id: m.id,
      channel_id: m.channelId,
      author: authorOf(m.author),
      content: deleted ? CHAT_DELETED_TEXT : m.content,
      image: img ? { id: img.id, url: `/api/images/${img.id}/raw`, mime_type: img.mimeType } : null,
      image_missing: !!m.imageId && !img,
      reply: reply
        ? {
            id: reply.id,
            content: (reply.isDeleted ?? false) ? CHAT_DELETED_TEXT : reply.content,
            author_name: reply.author.username,
            is_deleted: reply.isDeleted ?? false,
          }
        : null,
      is_deleted: deleted,
      created_at: m.createdAt ? m.createdAt.toISOString() : null,
    };
  });
}

export interface ListMessagesParams {
  after?: number | null;
  before?: number | null;
  limit?: number | null;
}

export type ListMessagesResult =
  | { ok: true; messages: ChatMessageDTO[] }
  | { ok: false; error: 'forbidden' | 'notFound'; message: string };

/**
 * 拉频道消息（只允许频道成员访问大区外的频道）。
 *   • 无游标：最新 limit 条（升序返回，最新在底部）
 *   • after：增量拉取（id > after，升序）
 *   • before：向更早翻页（id < before，倒序取 limit 后翻回升序）
 */
export async function listMessages(
  channelId: string,
  userId: string,
  params: ListMessagesParams = {}
): Promise<ListMessagesResult> {
  const access = await canAccessChannel(channelId, userId);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) return { ok: false, error: 'forbidden', message: '无权查看该会话' };

  const limit = Math.min(100, Math.max(1, params.limit ?? CHAT_INITIAL_LIMIT));
  let rows: MessageRow[];

  if (params.after != null) {
    rows = await prisma.chatMessage.findMany({
      where: { channelId, id: { gt: params.after } },
      orderBy: { id: 'asc' },
      take: limit,
      select: MESSAGE_SELECT,
    });
  } else if (params.before != null) {
    const descRows = await prisma.chatMessage.findMany({
      where: { channelId, id: { lt: params.before } },
      orderBy: { id: 'desc' },
      take: limit,
      select: MESSAGE_SELECT,
    });
    rows = descRows.reverse();
  } else {
    const descRows = await prisma.chatMessage.findMany({
      where: { channelId },
      orderBy: { id: 'desc' },
      take: limit,
      select: MESSAGE_SELECT,
    });
    rows = descRows.reverse();
  }

  const messages = await attachImagesAndReplies(rows);
  return { ok: true, messages };
}

export interface SendMessageInput {
  channelId: string;
  authorId: string;
  content?: string;
  imageId?: string | null;
  replyTo?: number | null;
}

export type SendMessageResult =
  | { ok: true; message: ChatMessageDTO }
  | {
      ok: false;
      error:
        | 'rateLimited'
        | 'forbidden'
        | 'notFound'
        | 'empty'
        | 'tooLong'
        | 'captionTooLong'
        | 'replyInvalid'
        | 'imageInvalid';
      message: string;
    };

/**
 * 发消息。先做资源/内容校验（避免非法请求烧限频额度），再扣限频（仿博客评论）。
 * 私聊发送成功后给其他成员发**会话合并**通知（通知失败不回滚消息本身）。
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const { channelId, authorId, imageId, replyTo } = input;
  const content = (input.content ?? '').trim();
  const now = nowForDb();

  // 1) 资源校验
  const access = await canAccessChannel(channelId, authorId);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) return { ok: false, error: 'forbidden', message: '无权在该会话发言' };

  const isImageMsg = !!imageId;

  if (!isImageMsg) {
    if (!content) return { ok: false, error: 'empty', message: '消息内容不能为空' };
    if (content.length > CHAT_TEXT_MAX) {
      return { ok: false, error: 'tooLong', message: `消息不能超过${CHAT_TEXT_MAX}字` };
    }
  } else {
    if (content.length > CHAT_CAPTION_MAX) {
      return { ok: false, error: 'captionTooLong', message: `图注不能超过${CHAT_CAPTION_MAX}字` };
    }
    const img = await prisma.imageHosting.findUnique({
      where: { id: imageId! },
      select: { id: true, authorId: true, ignore: true },
    });
    if (!img || img.ignore || img.authorId !== authorId) {
      return { ok: false, error: 'imageInvalid', message: '图片不存在或不属于你，请重新上传' };
    }
  }

  if (replyTo != null) {
    const reply = await prisma.chatMessage.findUnique({
      where: { id: replyTo },
      select: { channelId: true, isDeleted: true },
    });
    if (!reply || reply.channelId !== channelId || (reply.isDeleted ?? false)) {
      return { ok: false, error: 'replyInvalid', message: '被回复的消息不存在或已删除' };
    }
  }

  // 2) 限频（放资源校验之后）
  const minute = rateLimit(`chat:m:${authorId}`, RULES.chatMinute);
  if (!minute.allowed) {
    return { ok: false, error: 'rateLimited', message: '发言过于频繁，请稍后再试' };
  }
  const daily = rateLimit(`chat:d:${authorId}`, RULES.chatDaily);
  if (!daily.allowed) {
    return { ok: false, error: 'rateLimited', message: '今日发言已达上限，请明日再试' };
  }

  // 3) 写库
  let created: MessageRow;
  try {
    created = await prisma.chatMessage.create({
      data: {
        channelId,
        authorId,
        content,
        imageId: imageId || null,
        replyTo: replyTo ?? null,
        isDeleted: false,
        createdAt: now,
      },
      select: MESSAGE_SELECT,
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      return { ok: false, error: 'notFound', message: '频道不存在' };
    }
    throw e;
  }

  // 4) 私聊：给其他成员发合并通知（私聊只有两成员；大区不打扰）
  if (access.kind === CHAT_KIND_DIRECT) {
    try {
      const members = await prisma.chatMember.findMany({
        where: { channelId },
        select: { userId: true },
      });
      const recipients = members.map((m) => m.userId).filter((uid) => uid !== authorId);
      if (recipients.length) {
        const me = await prisma.user.findUnique({
          where: { id: authorId },
          select: { username: true },
        });
        const collapsed = content.replace(/\s+/g, ' ').trim();
        const previewBody =
          collapsed.length > CHAT_PREVIEW_MAX ? `${collapsed.slice(0, CHAT_PREVIEW_MAX)}…` : collapsed;
        const preview = isImageMsg
          ? `[图片]${previewBody ? ` ${previewBody}` : ''}`
          : previewBody;
        await Promise.all(
          recipients.map((rid) =>
            sendCoalescedChatNotification({
              recipientId: rid,
              actorId: authorId,
              channelId,
              preview: preview || '[图片]',
            })
          )
        );
      }
    } catch (e) {
      // 通知失败不影响消息本身（对齐评论）
      console.error(`[chat-service] 私聊通知失败（channelId=${channelId}, authorId=${authorId}）:`, e);
    }
  }

  const [dto] = await attachImagesAndReplies([created]);
  return { ok: true, message: dto };
}

// ── 已读 ────────────────────────────────────────────────────────────────────

/**
 * 推进某频道读游标到给定消息 id（缺省 = 频道当前最大 id），并把该会话的未读
 * chat 通知一并标已读（铃铛随会话打开而清零）。私聊非成员静默忽略。
 */
export async function markChannelRead(
  channelId: string,
  userId: string,
  messageId?: number
): Promise<number> {
  const access = await canAccessChannel(channelId, userId);
  if (!access.allowed || !access.kind) return 0;

  let upTo = messageId;
  if (upTo == null) {
    const agg = await prisma.chatMessage.aggregate({
      where: { channelId },
      _max: { id: true },
    });
    upTo = agg._max.id ?? 0;
  }
  if (upTo <= 0) return 0;

  const now = nowForDb();
  // 大区成员行可能还没建 → upsert；私聊成员行必然已存在
  await prisma.chatMember.upsert({
    where: { uq_chat_member_channel_user: { channelId, userId } },
    create: { channelId, userId, lastReadMessageId: upTo, createdAt: now },
    update: { lastReadMessageId: { set: upTo } },
  });

  // 该会话的合并通知一并标已读（私聊专用；大区无通知）
  await prisma.notification.updateMany({
    where: {
      recipientId: userId,
      objectType: 'chat',
      objectId: channelId,
      read: false,
    },
    data: { read: true },
  });
  return upTo;
}

// ── 软删除 ──────────────────────────────────────────────────────────────────

export type DeleteActor = { id: string; role: string };

export type DeleteMessageResult =
  | { ok: true }
  | {
      ok: false;
      error: 'notFound' | 'forbidden' | 'reasonRequired' | 'reasonTooLong';
      message: string;
    };

/**
 * 软删消息（对齐评论 softDeleteComment）：作者本人随时可删；管理员删他人需原因
 * （1..500），原因写 AdminActionLog（/audit 公示 + 申诉数据源）。
 */
export async function softDeleteMessage(
  messageId: number,
  actor: DeleteActor,
  reason?: string
): Promise<DeleteMessageResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const msg = await tx.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, authorId: true, isDeleted: true },
    });
    if (!msg || msg.isDeleted) {
      return { ok: false as const, error: 'notFound' as const, message: '消息不存在或已删除' };
    }

    const isAuthor = msg.authorId === actor.id;
    if (!isAuthor && !hasAdminRights(actor)) {
      return { ok: false as const, error: 'forbidden' as const, message: '无权删除该消息' };
    }

    const adminDeletingOthers = !isAuthor && hasAdminRights(actor);
    const trimmedReason = (reason ?? '').trim();
    if (adminDeletingOthers) {
      if (!trimmedReason) {
        return { ok: false as const, error: 'reasonRequired' as const, message: '请提供删除原因' };
      }
      if (trimmedReason.length > 500) {
        return { ok: false as const, error: 'reasonTooLong' as const, message: '删除原因过长（最多500字）' };
      }
    }

    await tx.chatMessage.update({ where: { id: messageId }, data: { isDeleted: true } });
    return {
      ok: true as const,
      audit: adminDeletingOthers
        ? { targetUserId: msg.authorId, channelId: msg.channelId, reason: trimmedReason }
        : null,
    };
  });

  if (outcome.ok && outcome.audit) {
    try {
      await logAdminAction({
        action: 'delete_chat_message',
        adminId: actor.id,
        targetUserId: outcome.audit.targetUserId,
        objectType: 'chat_message',
        objectId: String(messageId),
        reason: outcome.audit.reason || '违反聊天区规则',
        metadata: { channel_id: outcome.audit.channelId },
      });
    } catch {
      /* 审计失败不影响删除 */
    }
  }

  if (outcome.ok) return { ok: true };
  const { ok, error, message } = outcome;
  return { ok, error, message };
}

// ── 用户搜索（发起私聊弹窗）──────────────────────────────────────────────────

/**
 * 搜索可私聊对象：仅 core+（只有 core+ 能用聊天），排除自己。
 * query 为空时返回最近注册的一批 core+ 用户。按 username 匹配。
 */
export async function searchCoreUsers(query: string, selfId: string, limit = 30): Promise<ChatUserLite[]> {
  const q = query.trim();
  const where: Prisma.UserWhereInput = {
    role: { in: CORE_ROLES },
    NOT: { id: selfId },
    ...(q ? { username: { contains: q } } : {}),
  };
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
    select: { id: true, username: true, role: true },
  });
  return users;
}
