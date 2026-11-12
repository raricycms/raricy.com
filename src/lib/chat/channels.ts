// channels.ts — 频道与成员/访问：大区懒建、私聊成员制、会话列表与偏好
//
// 会话模型：
//   • 全局「讨论大区」：chat_channels 里固定一行 kind='lobby'、id='lobby'
//     （迁移 4_chat 种子化；服务层 ensureLobbyChannel 也兜底 upsert，保证测试库无种子
//     也能跑）。core+ 用户均可看可发，无需成员关系。
//   • 私聊：kind='direct'，恰好两名成员（发起时一起建成员行）。
//   • 读游标：chat_members.last_read_message_id；未读数 = 频道内 id > 游标且未软删。
//     大区成员行懒创建，基线 = 当时最大消息 id（从未进过讨论室不把历史算未读）。
// 唯一写入口：频道/成员行的创建、静音、隐藏/恢复、发起私聊都只在这里写库。
// hideChannel 不是删除：只记 hiddenAfterMessageId，之后有新消息即重新出现（微信语义）。
// 时间戳一律 nowForDb()（本库语义 = UTC+8 墙上时间贴 Z，见 db-time.ts）。
// 依赖方向：本文件可 import unread/counters；反向不可（unread 不 import channels）。

import { prisma } from '../db';
import { nowForDb } from '../db-time';
import { rateLimit, RULES } from '../rate-limit';
import {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_PREVIEW_MAX,
  PAT_TARGET_FALLBACK,
  stripPreviewTokens,
  type ChatChannelDTO,
} from '../chat-shared';
import { frameUrlFor } from '../frame-service';
import { CHAT_KIND_LOBBY, CHAT_KIND_DIRECT, CORE_ROLES } from './constants';
import { countUnreadByChannel, countLobbyMentionsSince } from './counters';
import { pushChatDot } from './unread';
import { isUniqueViolation, isForeignKeyViolation } from './prisma-errors';

/** 幂等建大区频道行（生产由迁移种子化；测试库空表时兜底）。 */
export async function ensureLobbyChannel(): Promise<{ id: string; kind: string }> {
  const existing = await prisma.chatChannel.findUnique({ where: { id: CHAT_LOBBY_ID } });
  if (existing) return existing;
  // 首次进讨论时 poll / viewing / @ 搜索会并发兜底建行，交给 SQLite 的原子 upsert。
  // 保留上面的只读早退，避免每次搜索都对已有的大区行做一次写入。
  return prisma.chatChannel.upsert({
    where: { id: CHAT_LOBBY_ID },
    create: { id: CHAT_LOBBY_ID, kind: CHAT_KIND_LOBBY, createdAt: nowForDb() },
    update: { kind: CHAT_KIND_LOBBY },
    select: { id: true, kind: true },
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
  try {
    await prisma.chatMember.create({
      data: {
        channelId: CHAT_LOBBY_ID,
        userId,
        lastReadMessageId: baseline,
        createdAt: nowForDb(),
      },
    });
  } catch (e) {
    // 并发首进大区：两个请求都读到「还没有行」，后建的那个撞唯一约束。
    // 这不是错误 —— 竞争输了就回读对方建好的行（基线以先建成的那次为准），
    // 不能把 P2002 漏到 poll 路由变成 500。其它约束冲突照旧抛出。
    if (!isUniqueViolation(e)) throw e;
    const raced = await prisma.chatMember.findUnique({
      where: { uq_chat_member_channel_user: { channelId: CHAT_LOBBY_ID, userId } },
      select: { lastReadMessageId: true },
    });
    // P2002 说明行确实存在；读不到只可能是同一连接上极端的可见性问题，按原样抛出。
    if (!raced) throw e;
    return raced;
  }
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
  /** 大区是否被专注模式屏蔽（拉消息/发消息/已读全走这里拦）。由调用方的 isFocusLobbyBlocked 传入 */
  lobbyBlocked = false
): Promise<{ allowed: boolean; kind: string | null }> {
  // 大区行在迁移里种子化；测试库空表时兜底建，保证 sendMessage 等直接走大区的路径不炸
  if (channelId === CHAT_LOBBY_ID) await ensureLobbyChannel();
  const ch = await prisma.chatChannel.findUnique({ where: { id: channelId } });
  if (!ch) return { allowed: false, kind: null };
  if (ch.kind === CHAT_KIND_LOBBY) {
    if (lobbyBlocked) return { allowed: false, kind: ch.kind };
    return { allowed: true, kind: ch.kind };
  }
  const member = await prisma.chatMember.findUnique({
    where: { uq_chat_member_channel_user: { channelId, userId } },
  });
  return { allowed: !!member, kind: ch.kind };
}

/**
 * 拉当前用户的全部频道（大区 + 私聊），带 peer、未读数、最后一条消息预览。
 * 大区固定置顶；私聊按「有未读优先，其次最近活跃」排序。
 */
export async function listChannelsForUser(
  userId: string,
  /**
   * 专注模式是否屏蔽了大区：大区行**保留在返回值里**（`disabled: true`），只是不带
   * 预览/未读、不懒建成员基线。⚠️ 别改成「干脆不发这一行」—— `disabled` 是「这行不可用」
   * 的单一真相源，ChatApp 的选频道 / 防御 / 删会话三处导航逻辑都靠它（行没了那三处会
   * 静默走偏）。网页侧栏不渲染它，见 src/app/chat/ChatSidebar.tsx 文件头。
   */
  lobbyBlocked = false,
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

  // 大区成员行懒建：基线 = 当时最大消息 id（历史不算未读）。大区被专注屏蔽时**不建**
  // ——那一行对他不可用（发过去也是 disabled），建了反而会把基线写进库。
  if (!lobbyBlocked && !cursorByChannel.has(CHAT_LOBBY_ID)) {
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
  const unreadByChannel = await countUnreadByChannel(userId, channelIds);

  // ── 2.5) 大区：未读里有没有 @ 到我 ──
  // 大区是公共频道，普通未读不提示（产品口径：只有「有人叫你」才亮红点）。只在
  // 「大区确实有未读」时才查，多数用户每次对账都跳过这一条。
  const lobbyCursor = cursorByChannel.get(CHAT_LOBBY_ID) ?? 0;
  let lobbyMentions = 0;
  if (!lobbyBlocked && (unreadByChannel.get(CHAT_LOBBY_ID) ?? 0) > 0) {
    lobbyMentions = await countLobbyMentionsSince(userId, lobbyCursor);
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
        select: { id: true, username: true, equippedFrameKey: true, equippedFrameExpiresAt: true },
      })
    : [];
  // key → 整行。此前只存 username，加头像框时改成存行 —— 再开第二个并行 map
  // 就等于把「同一个用户的资料」拆到两处，漏更新一处是静默的。
  const userById = new Map(users.map((u) => [u.id, u]));

  // ── 5) 组装 DTO ──
  const out = channels.map((ch) => {
    const isLobby = ch.kind === CHAT_KIND_LOBBY;
    if (isLobby && lobbyBlocked) {
      // 不可用的行：无最近一条（看不到大区最新消息）、无未读、保持置顶。
      // 仍然返回它是一个**契约**（导航逻辑要它），不是「侧栏要画出来」——网页侧栏
      // 把它过滤掉了，见 src/app/chat/ChatSidebar.tsx 文件头。
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

    // 类型从 DTO 里取，不重抄一份 —— 加了字段（比如 frame_url）忘同步这里，
    // 就会变成「赋值处报错但看不明白为什么」的那种错
    let peer: ChatChannelDTO['peer'] = null;
    let peerLastRead: number | null = null;
    let title = CHAT_LOBBY_TITLE;
    if (!isLobby) {
      const other = ch.members.find((m) => m.userId !== userId);
      const otherUser = other ? userById.get(other.userId) : undefined;
      const otherName = otherUser?.username;
      peer = other && otherUser
        ? { id: other.userId, username: otherUser.username, frame_url: frameUrlFor(otherUser) }
        : null;
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
      ? userById.get(last.patTargetId)?.username ?? PAT_TARGET_FALLBACK
      : null;

    const lm = last
      ? {
          id: last.id,
          content: (() => {
            if (patName) return `拍了拍 ${patName}`;
            // 内联 token → 短标记（与客户端 previewOfMessage 逐字一致：两处都走
            // chat-shared 的 stripPreviewTokens，不再是「两份约定」）
            const collapsed = stripPreviewTokens(last.content).replace(/\s+/g, ' ').trim();
            // 正文为空的附件消息给个可读预览，避免侧栏显示「用户名：」这种空串
            // （口径与通知预览一致，见 messages.ts 的 sendMessage 里的 preview）
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

export type ChannelPrefResult = { ok: true } | { ok: false; error: 'forbidden' | 'notFound' };

/**
 * 设置会话静音。静音只影响顶栏（该会话不计入未读汇总，见 getChatUnreadSummary），
 * 侧栏未读徽标照常 —— 静音 ≠ 已读。大区也允许静音（静音后连 @ 红点也不再上报顶栏）。
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
  // 静音会改变红点（静音会话不计入汇总）——推给本人
  void pushChatDot(userId);
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
  // 隐藏会让该会话的未读不再计红点 ——推给本人
  void pushChatDot(userId);
  return { ok: true };
}

/**
 * 解除会话隐藏。与 hideChannel 对称 —— 「删除会话」只是隐藏，不是删除。
 *
 * 【谁用】从「保存的消息」点进一条历史消息时：显式进入 = 我要看这个会话，
 * 若它已被「删除会话」隐藏，poll 列表里不会有它，聊天页会静默落到第一个会话 ——
 * 所以深链进入前先恢复。隐藏仍可由用户随时重新执行。
 */
export async function revealChannel(channelId: string, userId: string): Promise<ChannelPrefResult> {
  const access = await canAccessChannel(channelId, userId);
  if (!access.kind) return { ok: false, error: 'notFound' };
  if (!access.allowed) return { ok: false, error: 'forbidden' };
  if (access.kind === CHAT_KIND_LOBBY) return { ok: false, error: 'forbidden' };

  await prisma.chatMember.updateMany({
    where: { channelId, userId, hiddenAfterMessageId: { not: null } },
    data: { hiddenAfterMessageId: null },
  });
  // 隐藏/恢复会改变「会话是否计入红点」—— 推给本人（与 hideChannel 同口径）
  void pushChatDot(userId);
  return { ok: true };
}

export type StartDirectResult =
  | { ok: true; channel: ChatChannelDTO }
  | { ok: false; error: 'forbidden' | 'self' | 'notFound'; message: string };

/**
 * 发起/复用与某用户的私聊：存在互为成员且 kind='direct' 的频道则直接返回，否则新建。
 * 目标用户必须是 core+（只有 core+ 能进讨论），且不能是自己。
 */
export async function startDirectChannel(meId: string, otherId: string): Promise<StartDirectResult> {
  if (otherId === meId) return { ok: false, error: 'self', message: '不能和自己私聊' };

  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true, role: true } });
  if (!other || !CORE_ROLES.includes(other.role)) {
    return { ok: false, error: 'notFound', message: '对方不存在或无权使用讨论' };
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
