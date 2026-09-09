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
import { publishToAll, publishToUsers } from './chat-bus';
import {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  CHAT_FOCUS_BLOCKED_TITLE,
  CHAT_PREVIEW_MAX,
  PAT_TARGET_FALLBACK,
  type ChatAuthorDTO,
  type ChatMessageDTO,
  type ChatChannelDTO,
  type ChatUserLite,
} from './chat-shared';
import { Prisma } from '@prisma/client';

// 复用 chat-shared 的常量/类型（同时向后兼容旧导入路径）
export {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  CHAT_FOCUS_BLOCKED_TITLE,
  CHAT_PREVIEW_MAX,
  PAT_TARGET_FALLBACK,
  type ChatAuthorDTO,
  type ChatImageDTO,
  type ChatPatDTO,
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
const CORE_ROLES = ['core', 'admin', 'owner'];

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  authorId: true,
  content: true,
  imageId: true,
  replyTo: true,
  blogId: true,
  patTargetId: true,
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

/**
 * 从正文里提取被 @ 的用户名。口径与前端 isMentioned 完全一致：
 * `@名字` 之后必须是空白或行尾（否则 @bob 会把 @bobby 也算上）。
 * 用户名规则见 user-service.validateUsername（字母/数字/下划线/连字符，3-20 位）。
 */
export function extractMentions(content: string): string[] {
  const names = new Set<string>();
  const re = /@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) names.add(m[1]);
  return [...names];
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

/**
 * 访问判定：
 *   • 大区：core+ 一律可访问；
 *   • 私聊：必须是成员。
 * 返回是否允许（调用方已在上层把好 core 关）。
 */
export async function canAccessChannel(
  channelId: string,
  userId: string,
  /** 专注模式：大区对开启者不可用（拉消息/发消息/已读全走这里拦） */
  focusMode = false
): Promise<{ allowed: boolean; kind: string | null }> {
  // 大区行在迁移里种子化；测试库空表时兜底建，保证 sendMessage 等直接走大区的路径不炸
  if (channelId === CHAT_LOBBY_ID) await ensureLobbyChannel();
  const ch = await prisma.chatChannel.findUnique({ where: { id: channelId } });
  if (!ch) return { allowed: false, kind: null };
  if (ch.kind === CHAT_KIND_LOBBY) {
    if (focusMode) return { allowed: false, kind: ch.kind };
    return { allowed: true, kind: ch.kind };
  }
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
export async function listChannelsForUser(
  userId: string,
  /** 专注模式：大区行保留（侧栏要展示禁用行）但不带预览/未读、不懒建成员基线 */
  focusMode = false,
  /** 显式发起私聊时带上这个频道 id：空会话本不该进侧栏，但发起方要立刻看到它 */
  opts: { includeEmptyChannelId?: string } = {}
): Promise<ChatChannelDTO[]> {
  await ensureLobbyChannel();

  // ── 1) 我的成员关系（含读游标）──
  // 游标跟着成员行一次取回，不再逐频道 findUnique（旧实现每频道一次）。
  const memberships = await prisma.chatMember.findMany({
    where: { userId },
    select: {
      channelId: true,
      lastReadMessageId: true,
      hiddenAfterMessageId: true,
      mutedAt: true,
    },
  });
  const cursorByChannel = new Map(memberships.map((m) => [m.channelId, m.lastReadMessageId]));
  const mutedChannels = new Set(
    memberships.filter((m) => m.mutedAt != null).map((m) => m.channelId)
  );
  const hiddenAfterByChannel = new Map(
    memberships
      .filter((m) => m.hiddenAfterMessageId != null)
      .map((m) => [m.channelId, m.hiddenAfterMessageId as number])
  );

  // 大区成员行懒建：基线 = 当时最大消息 id（历史不算未读）。专注模式下**不建**
  // ——该行只是禁用占位，建了反而会把基线写进库。
  if (!focusMode && !cursorByChannel.has(CHAT_LOBBY_ID)) {
    const { lastReadMessageId } = await ensureLobbyMembership(userId);
    cursorByChannel.set(CHAT_LOBBY_ID, lastReadMessageId);
  }

  const ids = [...new Set([CHAT_LOBBY_ID, ...cursorByChannel.keys()])];
  const channels = await prisma.chatChannel.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      members: { select: { userId: true, lastReadMessageId: true } },
    },
  });
  const channelIds = channels.map((c) => c.id);

  // ── 2) 未读数：一条 SQL 覆盖全部频道 ──
  // 每个频道的读游标不同，Prisma 的 where 表达不了「逐行比较」，只能落到 SQL：
  // chat_members × chat_messages 按各自游标过滤后按频道 group by。
  // （is_deleted 在库里是 INTEGER 0/1，且历史行可能为 NULL，两个都要挡。）
  const unreadRows = channelIds.length
    ? await prisma.$queryRaw<{ channelId: string; unread: number | bigint }[]>`
        SELECT m.channel_id AS channelId, COUNT(msg.id) AS unread
        FROM chat_members m
        LEFT JOIN chat_messages msg
          ON msg.channel_id = m.channel_id
         AND msg.id > m.last_read_message_id
         AND (msg.is_deleted = 0 OR msg.is_deleted IS NULL)
        WHERE m.user_id = ${userId}
          AND m.channel_id IN (${Prisma.join(channelIds)})
        GROUP BY m.channel_id
      `
    : [];
  const unreadByChannel = new Map(unreadRows.map((r) => [r.channelId, Number(r.unread)]));

  // ── 2.5) 大区：未读里有没有 @ 到我 ──
  // 大区是公共频道，普通未读不提示（产品口径：只有「有人叫你」才亮红点）。判定必须
  // 与 @ 通知同一份规则 —— 所以**不建 mention 表**：落表等于多一份真相，还要迁移和
  // 回填。SQL 的 LIKE 只做预筛（超集：大小写不敏感、用户名里的 _ 是通配符），精确
  // 判定交回 extractMentions；预筛把取回行数从「全部未读」压到「字面含 @我」。
  // 只在「大区确实有未读」时才查，多数用户每次对账都跳过这一条。
  const lobbyCursor = cursorByChannel.get(CHAT_LOBBY_ID) ?? 0;
  let lobbyMentions = 0;
  if (!focusMode && (unreadByChannel.get(CHAT_LOBBY_ID) ?? 0) > 0) {
    const rows = await prisma.$queryRaw<{ content: string; username: string }[]>`
      SELECT msg.content AS content, u.username AS username
      FROM chat_messages msg
      JOIN users u ON u.id = ${userId}
      WHERE msg.channel_id = ${CHAT_LOBBY_ID}
        AND msg.id > ${lobbyCursor}
        AND (msg.is_deleted = 0 OR msg.is_deleted IS NULL)
        AND msg.author_id <> ${userId}
        AND msg.content LIKE '%@' || u.username || '%'
    `;
    lobbyMentions = rows.filter((r) => extractMentions(r.content).includes(r.username)).length;
  }

  // ── 3) 每个频道的最后一条 ──
  // groupBy 取各频道最大 id（Prisma 原生），再一条 findMany 取回（含作者）。
  // 不用窗口函数 raw SQL：那条路要把 DATETIME 列原样取回，解析结果依赖驱动。
  const maxRows = channelIds.length
    ? await prisma.chatMessage.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, isDeleted: false },
        _max: { id: true },
      })
    : [];
  const lastIds = maxRows.map((r) => r._max.id).filter((v): v is number => v !== null);
  const lastRows = lastIds.length
    ? await prisma.chatMessage.findMany({
        where: { id: { in: lastIds } },
        select: {
          id: true,
          channelId: true,
          content: true,
          imageId: true,
          blogId: true,
          patTargetId: true,
          createdAt: true,
          author: { select: { username: true } },
        },
      })
    : [];
  const lastByChannel = new Map(lastRows.map((r) => [r.channelId, r]));

  // ── 4) peer 与拍一拍目标的用户名：一次取齐 ──
  const peerIdByChannel = new Map<string, string>();
  for (const ch of channels) {
    if (ch.kind === CHAT_KIND_LOBBY) continue;
    const otherId = ch.members.find((m) => m.userId !== userId)?.userId;
    if (otherId) peerIdByChannel.set(ch.id, otherId);
  }
  const needUserIds = [
    ...new Set([
      ...peerIdByChannel.values(),
      ...lastRows.map((r) => r.patTargetId).filter((v): v is string => !!v),
    ]),
  ];
  const users = needUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: needUserIds } },
        select: { id: true, username: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.username]));

  // ── 5) 组装 DTO ──
  const out = channels.map((ch) => {
    const isLobby = ch.kind === CHAT_KIND_LOBBY;
    if (isLobby && focusMode) {
      // 禁用行：无最近一条（看不到大区最新消息）、无未读、保持置顶
      return {
        id: ch.id,
        kind: ch.kind as 'lobby' | 'direct',
        title: CHAT_LOBBY_TITLE,
        peer: null,
        unread_count: 0,
        last_message: null,
        disabled: true,
        _order: -1,
        _lastId: 0,
      };
    }

    let peer: { id: string; username: string } | null = null;
    let peerLastRead: number | null = null;
    let title = CHAT_LOBBY_TITLE;
    if (!isLobby) {
      const other = ch.members.find((m) => m.userId !== userId);
      const otherName = other ? nameById.get(other.userId) : undefined;
      peer = other && otherName ? { id: other.userId, username: otherName } : null;
      peerLastRead = other?.lastReadMessageId ?? null;
      title = otherName ?? '私聊';
    }

    const last = lastByChannel.get(ch.id);

    // 会话隐藏（D4）：隐藏时记下了当时的最大消息 id；之后来了新消息（id 更大）
    // 就重新出现（微信语义）。大区不参与隐藏。
    const hiddenAfter = hiddenAfterByChannel.get(ch.id);
    if (!isLobby && hiddenAfter != null && (last?.id ?? 0) <= hiddenAfter) return null;

    // 空会话（双方都还没发过消息）不进侧栏：否则任何人点一下「发起私聊」，对方
    // 侧栏就凭空多出一行「开始对话」（骚扰面）。发起方由 startDirectChannel 通过
    // includeEmptyChannelId 放行，好让他能马上开始打字。
    if (!isLobby && !last && ch.id !== opts.includeEmptyChannelId) return null;

    // 拍一拍没有正文：预览要读时解析目标名（侧栏不能显示空串）
    const patName = last?.patTargetId
      ? nameById.get(last.patTargetId) ?? PAT_TARGET_FALLBACK
      : null;

    const lm = last
      ? {
          id: last.id,
          content: (() => {
            if (patName) return `拍了拍 ${patName}`;
            const collapsed = last.content.replace(/\s+/g, ' ').trim();
            // 正文为空的附件消息给个可读预览，避免侧栏显示「用户名：」这种空串
            // （口径与通知预览一致，见本文件 sendMessage 里的 preview）
            const display = collapsed
              ? collapsed
              : last.imageId
                ? '[图片]'
                : last.blogId
                  ? '[博客]'
                  : '';
            return display.length > CHAT_PREVIEW_MAX
              ? `${display.slice(0, CHAT_PREVIEW_MAX)}…`
              : display;
          })(),
          author_name: last.author.username,
          created_at: last.createdAt ? last.createdAt.toISOString() : null,
        }
      : null;

    const unread = unreadByChannel.get(ch.id) ?? 0;
    return {
      id: ch.id,
      kind: ch.kind as 'lobby' | 'direct',
      title,
      peer,
      unread_count: unread,
      // 大区只给「@ 我」计数（未读总数照旧返回，客户端对大区不拿它当提示）
      mention_count: isLobby ? lobbyMentions : undefined,
      peer_last_read_message_id: peerLastRead,
      muted: mutedChannels.has(ch.id),
      last_message: lm,
      _order: isLobby ? -1 : unread > 0 ? 0 : 1,
      _lastId: lm?.id ?? 0,
    };
  });

  const valid = out.filter((x): x is NonNullable<typeof x> => x !== null);
  valid.sort((a, b) => a._order - b._order || b._lastId - a._lastId);
  return valid.map(({ _order, _lastId, ...dto }) => dto);
}

// ── 会话偏好：静音 / 隐藏 ───────────────────────────────────────────────────

export type ChannelPrefResult = { ok: true } | { ok: false; error: 'forbidden' | 'notFound' };

/**
 * 设置会话静音。静音只影响通知（不产生 chat 通知），未读徽标照常。
 * 大区也允许静音（它本来不发通知，但保持接口一致）。
 */
export async function setChannelMuted(
  channelId: string,
  userId: string,
  muted: boolean
): Promise<ChannelPrefResult> {
  const access = await canAccessChannel(channelId, userId);
  if (!access.kind) return { ok: false, error: 'notFound' };
  if (!access.allowed) return { ok: false, error: 'forbidden' };

  // 大区成员行可能还不存在：先走懒建，避免 upsert 的 create 分支把读游标写成 0
  // （那会让新成员把全部历史消息算成未读）。
  if (channelId === CHAT_LOBBY_ID) await ensureLobbyMembership(userId);

  await prisma.chatMember.upsert({
    where: { uq_chat_member_channel_user: { channelId, userId } },
    create: {
      channelId,
      userId,
      lastReadMessageId: 0,
      mutedAt: muted ? nowForDb() : null,
      createdAt: nowForDb(),
    },
    update: { mutedAt: muted ? nowForDb() : null },
  });
  return { ok: true };
}

/**
 * 隐藏会话（「删除会话」）：记下当前最大消息 id。之后有新消息 → 重新出现。
 * 只允许隐藏私聊（大区是全员频道，隐藏它没有意义且会破坏置顶行）。
 */
export async function hideChannel(channelId: string, userId: string): Promise<ChannelPrefResult> {
  const access = await canAccessChannel(channelId, userId);
  if (!access.kind) return { ok: false, error: 'notFound' };
  if (!access.allowed) return { ok: false, error: 'forbidden' };
  if (access.kind === CHAT_KIND_LOBBY) return { ok: false, error: 'forbidden' };

  const agg = await prisma.chatMessage.aggregate({
    where: { channelId },
    _max: { id: true },
  });
  await prisma.chatMember.update({
    where: { uq_chat_member_channel_user: { channelId, userId } },
    data: { hiddenAfterMessageId: agg._max.id ?? 0 },
  });
  return { ok: true };
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

  // 限频：发起私聊也是写操作（可能建新频道行），防脚本刷频道
  const limited = rateLimit(`chat:newchannel:${meId}`, RULES.chatNewChannel);
  if (!limited.allowed) {
    return { ok: false, error: 'forbidden', message: '发起会话过于频繁，请稍后再试' };
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
      // 复用前先解除「被我隐藏」：显式发起私聊 = 我要跟这个人说话，会话理应回来。
      // （不解除的话 listChannelsForUser 会把它过滤掉，下面拿到的 DTO 就是 null。）
      await prisma.chatMember.updateMany({
        where: { channelId: existing.channelId, userId: meId, hiddenAfterMessageId: { not: null } },
        data: { hiddenAfterMessageId: null },
      });
      const list = await listChannelsForUser(meId, false, {
        includeEmptyChannelId: existing.channelId,
      });
      const ch = list.find((c) => c.id === existing.channelId);
      return { ok: true, channel: ch! };
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

  const dto = await toChannelDto(meId, id, { includeEmptyChannelId: id });
  return { ok: true, channel: dto! };
}

/** 单频道 DTO（供发消息/建会话后刷新）。非成员或不存在返回 null。 */
export async function toChannelDto(
  userId: string,
  channelId: string,
  opts: { includeEmptyChannelId?: string } = {}
): Promise<ChatChannelDTO | null> {
  const list = await listChannelsForUser(userId, false, opts);
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

  // 引用博客：批量按 blog_id 取当前行（blogs.ignore=1 / 行不存在 → blog_missing 占位，
  // 对齐图片「缺失给占位」语义）。只存 id 不存快照，标题/简介/作者/更新时间渲染期解析。
  const blogIds = [...new Set(rows.map((r) => r.blogId).filter((v): v is string => !!v))];
  const blogMap = new Map<string, {
    id: string;
    title: string;
    description: string;
    author: { username: string } | null;
    content: { updatedAt: Date | null } | null;
  }>();
  if (blogIds.length) {
    const bls = await prisma.blog.findMany({
      where: { id: { in: blogIds }, ignore: false },
      select: {
        id: true,
        title: true,
        description: true,
        author: { select: { username: true } },
        content: { select: { updatedAt: true } },
      },
    });
    for (const b of bls) blogMap.set(b.id, b);
  }

  // 拍一拍目标：批量按 pat_target_id 取当前 username（读时解析，不存快照；
  // 目标行缺失 → 占位名，对齐 blog_missing 的「缺了也给个占位」语义）
  const patIds = [...new Set(rows.map((r) => r.patTargetId).filter((v): v is string => !!v))];
  const patNameMap = new Map<string, string>();
  if (patIds.length) {
    const us = await prisma.user.findMany({
      where: { id: { in: patIds } },
      select: { id: true, username: true },
    });
    for (const u of us) patNameMap.set(u.id, u.username);
  }

  return rows.map((m) => {
    const deleted = m.isDeleted ?? false;
    const img = m.imageId ? imageMap.get(m.imageId) : undefined;
    const reply = m.replyTo != null ? replyMap.get(m.replyTo) : undefined;
    const blog = m.blogId ? blogMap.get(m.blogId) : undefined;
    return {
      id: m.id,
      channel_id: m.channelId,
      author: authorOf(m.author),
      content: deleted ? CHAT_DELETED_TEXT : m.content,
      // 软删即抹掉附件：图片 / 博客卡 / 回复引用一律不再下发 —— 否则「删掉的图」仍能
      // 点开看原图（作者/管理员删了等于没删）。pat 例外：前端靠它渲染居中系统行，
      // 再按 is_deleted 换成删除占位。
      image:
        !deleted && img
          ? { id: img.id, url: `/api/images/${img.id}/raw`, mime_type: img.mimeType }
          : null,
      image_missing: !deleted && !!m.imageId && !img,
      blog:
        !deleted && blog
          ? {
              id: blog.id,
              title: blog.title,
              description: blog.description,
              author: blog.author?.username ?? null,
              updated_at: blog.content?.updatedAt ? blog.content.updatedAt.toISOString() : null,
            }
          : null,
      blog_missing: !deleted && !!m.blogId && !blog,
      pat: m.patTargetId
        ? {
            target_id: m.patTargetId,
            target_name: patNameMap.get(m.patTargetId) ?? PAT_TARGET_FALLBACK,
          }
        : null,
      reply:
        !deleted && reply
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

export type SearchMessagesResult =
  | { ok: true; messages: ChatMessageDTO[]; total: number }
  | { ok: false; error: 'forbidden' | 'notFound' | 'empty'; message: string };

/**
 * 在**单个频道内**按正文搜索消息（软删的不参与）。结果按 id 倒序（新的在前），
 * 前端点一条 → 跳转到该条并高亮。
 *
 * 只搜当前频道：跨会话搜索要么泄露别的会话上下文，要么需要额外做频道维度分页，
 * 收益不抵复杂度（见 docs/chat-review.md 第 3 节）。
 */
export async function searchChannelMessages(
  channelId: string,
  userId: string,
  query: string,
  limit = 20,
  offset = 0,
  focusMode = false
): Promise<SearchMessagesResult> {
  const q = query.trim();
  if (!q) return { ok: false, error: 'empty', message: '请输入搜索关键词' };

  const access = await canAccessChannel(channelId, userId, focusMode);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        focusMode && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权查看该会话',
    };
  }

  const where: Prisma.ChatMessageWhereInput = {
    channelId,
    isDeleted: false,
    content: { contains: q },
  };
  const [rows, total] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: Math.max(0, offset),
      take: Math.min(50, Math.max(1, limit)),
      select: MESSAGE_SELECT,
    }),
    prisma.chatMessage.count({ where }),
  ]);

  return { ok: true, messages: await attachImagesAndReplies(rows), total };
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
  params: ListMessagesParams = {},
  focusMode = false
): Promise<ListMessagesResult> {
  const access = await canAccessChannel(channelId, userId, focusMode);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        focusMode && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权查看该会话',
    };
  }

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

/**
 * 断线补齐：拉「该用户可见频道」中 id > afterId 的消息（升序）。
 *
 * SSE 重连时浏览器回传 Last-Event-ID，服务端用它补齐断线期间漏掉的消息。
 * 消息 id 是**全局自增**（大区与私聊共用一个序列），所以一个游标就能同时覆盖
 * 大区 + 全部私聊，不需要按频道分别维护游标。
 * more=true 表示积压超过 limit（断得太久），调用方应让客户端整页重拉（resync 事件）。
 */
export async function listMessagesSince(
  userId: string,
  afterId: number,
  limit = 100
): Promise<{ messages: ChatMessageDTO[]; more: boolean }> {
  await ensureLobbyChannel();
  const memberships = await prisma.chatMember.findMany({
    where: { userId },
    select: { channelId: true },
  });
  const channelIds = [CHAT_LOBBY_ID, ...memberships.map((m) => m.channelId)];

  const rows = await prisma.chatMessage.findMany({
    where: { channelId: { in: channelIds }, id: { gt: afterId } },
    orderBy: { id: 'asc' },
    take: limit + 1, // 多取一条判断是否还有积压
    select: MESSAGE_SELECT,
  });
  const more = rows.length > limit;
  const messages = await attachImagesAndReplies(more ? rows.slice(0, limit) : rows);
  return { messages, more };
}

export interface SendMessageInput {
  channelId: string;
  authorId: string;
  content?: string;
  imageId?: string | null;
  /** 引用博客的 UUID（blogs.id）；发送时校验存在且未软删 */
  blogId?: string | null;
  /** 拍一拍目标用户 id；非空即拍一拍消息（正文/附件一律忽略，只校验目标存在） */
  patTargetId?: string | null;
  replyTo?: number | null;
  /** 专注模式：开启者对聊天大区不可发言（服务端由路由按 user.focusMode 填入） */
  focusMode?: boolean;
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
        | 'imageInvalid'
        | 'blogInvalid'
        | 'patInvalid';
      message: string;
    };

/**
 * 发消息。先做资源/内容校验（避免非法请求烧限频额度），再扣限频（仿博客评论）。
 * 私聊发送成功后给其他成员发**会话合并**通知（通知失败不回滚消息本身）。
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const { channelId, authorId, imageId, blogId, patTargetId, replyTo, focusMode } = input;
  const content = (input.content ?? '').trim();
  const now = nowForDb();

  // 1) 资源校验
  const access = await canAccessChannel(channelId, authorId, focusMode);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        focusMode && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权在该会话发言',
    };
  }

  const isPatMsg = !!patTargetId;
  const isImageMsg = !!imageId;
  const isBlogMsg = !!blogId;
  // 博客引用视同附件：允许空正文，文字上限按图注档（对齐带图消息）
  const isAttachMsg = isImageMsg || isBlogMsg;

  // 拍一拍：不携带正文/图片/博客，只校验目标用户存在（允许拍自己，同微信/QQ）。
  // 私聊里还要求目标必须是本会话成员 —— 否则能拍一个与会话无关的人，对方侧栏
  // 会冒出「A 拍了拍 X」。
  let patTargetName: string | null = null;
  if (isPatMsg) {
    const target = await prisma.user.findUnique({
      where: { id: patTargetId! },
      select: { username: true },
    });
    if (!target) return { ok: false, error: 'patInvalid', message: '被拍的用户不存在' };
    if (access.kind === CHAT_KIND_DIRECT) {
      const inChannel = await prisma.chatMember.findUnique({
        where: { uq_chat_member_channel_user: { channelId, userId: patTargetId! } },
        select: { id: true },
      });
      if (!inChannel) return { ok: false, error: 'patInvalid', message: '对方不在该会话中' };
    }
    patTargetName = target.username;
  } else if (!isAttachMsg) {
    if (!content) return { ok: false, error: 'empty', message: '消息内容不能为空' };
    if (content.length > CHAT_TEXT_MAX) {
      return { ok: false, error: 'tooLong', message: `消息不能超过${CHAT_TEXT_MAX}字` };
    }
  } else {
    if (content.length > CHAT_CAPTION_MAX) {
      return {
        ok: false,
        error: 'captionTooLong',
        message: `图片或引用消息不能超过${CHAT_CAPTION_MAX}字`,
      };
    }
    if (isImageMsg) {
      const img = await prisma.imageHosting.findUnique({
        where: { id: imageId! },
        select: { id: true, authorId: true, ignore: true },
      });
      if (!img || img.ignore || img.authorId !== authorId) {
        return { ok: false, error: 'imageInvalid', message: '图片不存在或不属于你，请重新上传' };
      }
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

  // 引用博客校验：存在且未软删（blogs.ignore=0）
  if (blogId) {
    const blog = await prisma.blog.findFirst({
      where: { id: blogId, ignore: false },
      select: { id: true },
    });
    if (!blog) {
      return { ok: false, error: 'blogInvalid', message: '引用的博客不存在或已删除' };
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
        // 拍一拍不带正文/附件/回复：库里只留目标 id，文案由前端按用户名渲染
        content: isPatMsg ? '' : content,
        imageId: isPatMsg ? null : imageId || null,
        blogId: isPatMsg ? null : blogId || null,
        patTargetId: isPatMsg ? patTargetId! : null,
        replyTo: isPatMsg ? null : replyTo ?? null,
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
  //    成员列表顺带给下面的 SSE 推送复用，省一次查询。
  let directMemberIds: string[] | null = null;
  if (access.kind === CHAT_KIND_DIRECT) {
    try {
      const members = await prisma.chatMember.findMany({
        where: { channelId },
        select: { userId: true },
      });
      directMemberIds = members.map((m) => m.userId);
      const recipients = directMemberIds.filter((uid) => uid !== authorId);
      if (recipients.length) {
        const me = await prisma.user.findUnique({
          where: { id: authorId },
          select: { username: true },
        });
        const collapsed = content.replace(/\s+/g, ' ').trim();
        const previewBody =
          collapsed.length > CHAT_PREVIEW_MAX ? `${collapsed.slice(0, CHAT_PREVIEW_MAX)}…` : collapsed;
        const preview = isPatMsg
          ? `拍了拍 ${patTargetName}`
          : isImageMsg
            ? `[图片]${previewBody ? ` ${previewBody}` : ''}`
            : isBlogMsg
              ? `[博客]${previewBody ? ` ${previewBody}` : ''}`
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

  // 4.5) 大区 @ 提醒：正文里 @ 到的 core+ 用户各发一条通知（会话合并，同一频道
  //      只留一条未读）。私聊只有两人，@ 无意义，跳过。
  if (access.kind === CHAT_KIND_LOBBY && !isPatMsg && content) {
    try {
      const names = extractMentions(content);
      if (names.length) {
        const mentioned = await prisma.user.findMany({
          where: {
            username: { in: names },
            NOT: { id: authorId },
            role: { in: CORE_ROLES },
          },
          select: { id: true },
        });
        const collapsed = content.replace(/\s+/g, ' ').trim();
        const previewBody =
          collapsed.length > CHAT_PREVIEW_MAX
            ? `${collapsed.slice(0, CHAT_PREVIEW_MAX)}…`
            : collapsed;
        await Promise.all(
          mentioned.map((u) =>
            sendCoalescedChatNotification({
              recipientId: u.id,
              actorId: authorId,
              channelId,
              preview: `@了你：${previewBody}`,
              action: '聊天提到你',
            })
          )
        );
      }
    } catch (e) {
      // @ 提醒失败不影响消息本身（对齐通知的容错口径）
      console.error(`[chat-service] @ 提醒失败（channelId=${channelId}）:`, e);
    }
  }

  const [dto] = await attachImagesAndReplies([created]);

  // 5) SSE 实时推送（尽力而为：推送失败不影响消息本身，对齐通知的容错口径）
  try {
    const event = { type: 'message' as const, channel_id: channelId, message: dto };
    if (access.kind === CHAT_KIND_LOBBY) {
      // 大区广播给全部在线连接；专注模式开启者跳过（他们本就看不到大区）
      publishToAll(event, dto.id, { skipFocusMode: true });
    } else if (directMemberIds) {
      // 私聊推给全体成员（含发送者自己 → 多标签页同步；客户端按消息 id 去重）
      publishToUsers(directMemberIds, event, dto.id);
    }
  } catch (e) {
    console.error(`[chat-service] SSE 推送失败（channelId=${channelId}）:`, e);
  }

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
  messageId?: number,
  focusMode = false
): Promise<number> {
  const access = await canAccessChannel(channelId, userId, focusMode);
  if (!access.allowed || !access.kind) return 0;

  let upTo: number | undefined = messageId;
  if (upTo != null) {
    // 游标必须指向本频道的消息：消息 id 是全局自增（跨频道共用一个序列），
    // 传一个别的频道（更大）的 id 会把游标推高、静默吞掉未读。不属于本频道
    // 就忽略该参数，回落为「频道当前最大 id」。
    const belongs = await prisma.chatMessage.findFirst({
      where: { id: upTo, channelId },
      select: { id: true },
    });
    if (!belongs) upTo = undefined;
  }
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

  // 私聊已读回执：告诉对方「我读到哪了」（大区人多，不推）
  if (access.kind === CHAT_KIND_DIRECT) {
    try {
      const members = await prisma.chatMember.findMany({
        where: { channelId, NOT: { userId } },
        select: { userId: true },
      });
      publishToUsers(
        members.map((m) => m.userId),
        { type: 'read', channel_id: channelId, user_id: userId, message_id: upTo },
        upTo
      );
    } catch (e) {
      console.error(`[chat-service] 已读回执推送失败（channelId=${channelId}）:`, e);
    }
  }
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
 * 返回分页结果 + 总数（弹窗要算总页数）。
 */
export async function searchCoreUsers(
  query: string,
  selfId: string,
  limit = 30,
  offset = 0
): Promise<{ users: ChatUserLite[]; total: number }> {
  const q = query.trim();
  const where: Prisma.UserWhereInput = {
    role: { in: CORE_ROLES },
    NOT: { id: selfId },
    ...(q ? { username: { contains: q } } : {}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, offset),
      take: Math.min(100, Math.max(1, limit)),
      // 不返回 role：弹窗只需要 id + 用户名，角色属多余暴露
      select: { id: true, username: true },
    }),
    prisma.user.count({ where }),
  ]);
  return { users, total };
}
