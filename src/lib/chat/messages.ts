// messages.ts — 消息读写：列表/增量补齐/搜索、发送与校验、已读推进、软删除
//
// 消息 id 自增整数（增量拉取 / 读游标基准）。软删除 is_deleted（对齐评论），永不物理删。
// 正文以 Markdown **源文**入库（无 contentHtml）；渲染在客户端走 chat-markdown.ts 的
// marked → DOMPurify 白名单（见 ChatMarkdown），故入库侧不做任何转义。图片仅存
// image_hosting 引用，发送时强校验「图片归本人所有且未软删」。
// 限频仿博客评论：资源存在性校验通过后才扣额度。
// 时间戳一律 nowForDb()（本库语义 = UTC+8 墙上时间贴 Z，见 db-time.ts）。
//
// 唯一的消息写入口都在本文件：sendMessage / markChannelRead / softDeleteMessage。
//   • 发送后 SSE 推送尽力而为（失败只记日志，下次对账补上）；私聊推全体成员（含作者
//     自己的多标签页），大区广播跳过屏蔽大区的连接；
//   • 发送时**不产生站内通知**，只有 @ 提及进通知列表（见 notifyChannelMentions）；
//   • 已读游标只增不减（带条件 UPDATE），推进后清该会话 @ 通知并推红点；
//   • 查询类接口（list / search / 补齐）只读不写库；成员行懒建在 channels.ts。

import { prisma } from '../db';
import { extractMentions } from '../mention-shared';
import { nowForDb } from '../db-time';
import { hasAdminRights, isCurrentlyBanned } from '../auth';
import { rateLimit, RULES } from '../rate-limit';
import { logAdminAction } from '../admin-user-service';
import { markChannelNotificationsRead, sendNotification } from '../notification-service';
import { publishToAll, publishToUsers } from '../chat-bus';
import { isViewingChannel } from '../chat-presence';
import { avatarUrl } from '../avatar-refs';
import { frameUrlFor } from '../frame-service';
import { bubbleKeyFor } from '../bubble-service';
import { isFocusLobbyBlocked } from '../focus-mode';
import {
  CHAT_LOBBY_ID,
  CHAT_DELETED_TEXT,
  CHAT_FOCUS_BLOCKED_TITLE,
  CHAT_PREVIEW_MAX,
  CHAT_TEXT_MAX,
  CHAT_CAPTION_MAX,
  CHAT_NOTIFY_OBJECT_TYPE,
  PAT_TARGET_FALLBACK,
  stripPreviewTokens,
  type ChatAuthorDTO,
  type ChatMessageDTO,
  type ChatUserLite,
} from '../chat-shared';
import { Prisma } from '@prisma/client';
import { CHAT_KIND_LOBBY, CHAT_KIND_DIRECT, CHAT_INITIAL_LIMIT, CORE_ROLES } from './constants';
import { canAccessChannel, ensureLobbyChannel } from './channels';
import { pushChatDot } from './unread';
import { isForeignKeyViolation } from './prisma-errors';

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
  author: {
    select: {
      id: true,
      username: true,
      role: true,
      archivedAt: true,
      equippedFrameKey: true,
      equippedFrameExpiresAt: true,
      equippedBubbleKey: true,
      equippedBubbleExpiresAt: true,
    },
  },
} satisfies Prisma.ChatMessageSelect;

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

function authorOf(a: {
  id: string;
  username: string;
  role: string;
  archivedAt: Date | null;
  /**
   * 装备两列 —— 只为算 `frame_url`。**刻意必填**：唯一的调用方（消息行）走
   * `MESSAGE_SELECT`，漏加那两列的后果是「讨论区所有人永远没有框」——
   * 页面照常渲染、没有日志，只有人眼能发现。让它 tsc 报错。
   */
  equippedFrameKey: string | null;
  equippedFrameExpiresAt: Date | null;
  equippedBubbleKey: string | null;
  equippedBubbleExpiresAt: Date | null;
}): ChatAuthorDTO {
  if (a.archivedAt) return {
    id: '', username: '已删除用户', avatar_url: avatarUrl('deleted'),
    frame_url: null, bubble_key: null, is_admin: false,
  };
  return {
    id: a.id,
    username: a.username,
    avatar_url: avatarUrl(a.id),
    frame_url: frameUrlFor(a),
    bubble_key: bubbleKeyFor(a),
    is_admin: hasAdminRights(a),
  };
}

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
  const replyMap = new Map<number, {
    id: number;
    content: string;
    isDeleted: boolean | null;
    imageId: string | null;
    /** 纯博客卡 / 拍一拍消息正文为空，引用块要靠它们给占位文案（否则只剩「作者：」） */
    blogId: string | null;
    patTargetId: string | null;
    author: { username: string; archivedAt: Date | null };
  }>();
  if (replyIds.length) {
    const reps = await prisma.chatMessage.findMany({
      where: { id: { in: replyIds } },
      select: {
        id: true,
        content: true,
        isDeleted: true,
        imageId: true,
        blogId: true,
        patTargetId: true,
        author: { select: { username: true, archivedAt: true } },
      },
    });
    for (const r of reps) replyMap.set(r.id, r);

    // 被引用消息若是图片消息，引用块要出缩略图 → 与正文图片同一套「存在且未软删」
    // 口径；已经取到的 id 不重复查，直接复用上面那张 imageMap。
    const replyImageIds = [
      ...new Set(
        [...replyMap.values()]
          .map((r) => r.imageId)
          .filter((v): v is string => !!v && !imageMap.has(v))
      ),
    ];
    if (replyImageIds.length) {
      const imgs = await prisma.imageHosting.findMany({
        where: { id: { in: replyImageIds }, ignore: false },
        select: { id: true, mimeType: true },
      });
      for (const i of imgs) imageMap.set(i.id, i);
    }
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
    const deleted = !!m.isDeleted || !!m.author.archivedAt;
    const img = m.imageId ? imageMap.get(m.imageId) : undefined;
    const reply = m.replyTo != null ? replyMap.get(m.replyTo) : undefined;
    const blog = m.blogId ? blogMap.get(m.blogId) : undefined;
    const replyImage = reply?.imageId ? imageMap.get(reply.imageId) : undefined;
    // 引用块正文：被引用消息是纯图片 / 纯博客卡 / 拍一拍时正文为空 —— 图片还在就交给
    // image_url 渲染缩略图；其余按侧栏预览同口径给占位文案，否则引用块只剩「作者：」。
    const replyText = !reply
      ? ''
      : (reply.isDeleted || reply.author.archivedAt)
        ? CHAT_DELETED_TEXT
        : // 引用块是一行摘要，内联 token 一律换成短标记（与侧栏预览、通知预览同口径）
          stripPreviewTokens(reply.content) ||
          (reply.imageId && !replyImage ? '[图片已删除]' : '') ||
          (reply.blogId ? '[博客]' : '') ||
          (reply.patTargetId ? '[拍一拍]' : '');
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
      pat: m.patTargetId && !m.author.archivedAt
        ? {
            target_id: m.patTargetId,
            target_name: patNameMap.get(m.patTargetId) ?? PAT_TARGET_FALLBACK,
          }
        : null,
      reply:
        !deleted && reply
          ? {
              id: reply.id,
              content: replyText,
              author_name: reply.author.archivedAt ? '已删除用户' : reply.author.username,
              is_deleted: !!reply.isDeleted || !!reply.author.archivedAt,
              image_url:
                !reply.isDeleted && !reply.author.archivedAt && replyImage
                  ? `/api/images/${replyImage.id}/raw`
                  : null,
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
 * 收益不抵复杂度。
 */
export async function searchChannelMessages(
  channelId: string,
  userId: string,
  query: string,
  limit = 20,
  offset = 0,
  lobbyBlocked = false
): Promise<SearchMessagesResult> {
  const q = query.trim();
  if (!q) return { ok: false, error: 'empty', message: '请输入搜索关键词' };

  const access = await canAccessChannel(channelId, userId, lobbyBlocked);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        lobbyBlocked && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权查看该会话',
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
  lobbyBlocked = false
): Promise<ListMessagesResult> {
  const access = await canAccessChannel(channelId, userId, lobbyBlocked);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        lobbyBlocked && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权查看该会话',
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
 *
 * `lobbyBlocked` 是连接建立时的大区可见性快照（与 listMessages / canAccessChannel 同口径）：
 * 专注模式屏蔽了大区的连接**看不到大区**，补齐也必须把它排除在外 —— 否则它重连后会
 * 收到断线期间的大区消息，客户端给大区累加未读 / 这些内容本身也超出了它的可见范围。
 */
export async function listMessagesSince(
  userId: string,
  afterId: number,
  limit = 100,
  lobbyBlocked = false
): Promise<{ messages: ChatMessageDTO[]; more: boolean }> {
  await ensureLobbyChannel();
  const memberships = await prisma.chatMember.findMany({
    where: { userId },
    select: { channelId: true },
  });
  // 成员表里也可能有 'lobby' 行（进过大区就会懒建）：屏蔽时一并剔除，而不是只不追加。
  const channelIds = memberships
    .map((m) => m.channelId)
    .filter((id) => !lobbyBlocked || id !== CHAT_LOBBY_ID);
  if (!lobbyBlocked) channelIds.push(CHAT_LOBBY_ID);

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
  /** 专注模式是否屏蔽了大区：屏蔽后对讨论大区不可发言（服务端由路由按 isFocusLobbyBlocked(user) 填入） */
  lobbyBlocked?: boolean;
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

/** 通知 action：消息里 @ 到某人时发送（见 notifyChannelMentions）。 */
export const CHAT_MENTION_ACTION = '讨论提及';

/**
 * @ 提及通知：给正文里 @ 到的人逐个发一条站内通知。
 *
 * 【为什么只有 @ 才发】讨论消息本身不进通知列表 —— 未读归顶栏「讨论」链接上的红点
 * （见 getChatUnreadSummary）；只有「有人叫你」才值得进通知列表，口径与侧栏大区红点
 * 完全一致（hasUnreadMark 对大区也只认 @）。
 *
 * 【发给谁】逐条闸门过滤，全过才发：
 *   • 不是自己（自己 @ 自己不发）；
 *   • 不是禁言中的用户（进不了讨论，未读也不该在铃铛里吊着）；
 *   • core+（只有 core+ 能进讨论）；
 *   • 频道对他可见：
 *       - 私聊：必须是本会话成员 —— 在**别人的私聊**里 @ 一个第三方，对方既看不到
 *         那条消息，通知正文还会把别人私聊的内容漏出去，一律不发；
 *       - 大区：专注模式勾了「屏蔽讨论大区」就不发（大区对他不可见，同 canAccessChannel）。
 *   • 没静音这个会话：静音 =「别在铃铛上打扰我」，与顶栏红点同一口径；
 *   • **没正在看这个会话**：人在这个会话里看着，再给铃铛塞一条纯属白打扰
 *     （判据与失败方向见 chat-presence.ts 文件头）。
 *
 * 【一人一条】按人去重（同一条消息里 @ 两次只发一条）；不同消息各发各的 ——
 * 通知列表本来就是流水账，不做聚合。
 *
 * 【读了就清】这条通知不是发出去就不管了：对方进这个会话（或在里面看新消息）时，
 * markChannelRead 会把它标已读（见那边）。所以「通知还在铃铛上挂着」等价于
 * 「他还没看这个会话」—— 页面上看到的数字因此永远说得通。
 *
 * 【用户名精确匹配】与 countLobbyMentionsSince 同一规则：红点与通知必须对
 * 「这条算不算 @ 我」给出**同一个答案**，否则会出现「有红点没通知」的自相矛盾。
 *
 * 失败只记日志：通知是消息的附赠品，不能因为它把已经落库的消息变成 500。
 */
async function notifyChannelMentions(params: {
  channelId: string;
  /** canAccessChannel 判出的频道类型（'lobby' | 'direct'） */
  kind: string;
  authorId: string;
  /** 作者用户名：自己 @ 自己不算提及 */
  authorName: string;
  content: string;
}): Promise<void> {
  const { channelId, kind, authorId, authorName, content } = params;
  const isLobby = kind === CHAT_KIND_LOBBY;

  const names = extractMentions(content).filter((n) => n !== authorName);
  if (!names.length) return;

  const candidates = (
    await prisma.user.findMany({
      where: { username: { in: names } },
      select: { id: true, role: true, focusMode: true, focusBlockLobby: true, isBanned: true, banUntil: true },
    })
  ).filter(
    (u) => u.id !== authorId && CORE_ROLES.includes(u.role) && !isCurrentlyBanned(u)
  );
  if (!candidates.length) return;

  // 成员关系与静音状态一条查询取齐（大区没进过讨论室的用户没有成员行，但大区不需要成员）
  const members = await prisma.chatMember.findMany({
    where: { channelId, userId: { in: candidates.map((u) => u.id) } },
    select: { userId: true, mutedAt: true },
  });
  const memberByUser = new Map(members.map((m) => [m.userId, m]));

  // 正文折叠成一行再截断：通知列表是一行摘要，不展示换行与缩进
  const collapsed = stripPreviewTokens(content).replace(/\s+/g, ' ').trim();
  const preview =
    collapsed.length > CHAT_PREVIEW_MAX ? `${collapsed.slice(0, CHAT_PREVIEW_MAX)}…` : collapsed;
  const detail = isLobby ? `在讨论大区提到了你：${preview}` : `在私聊中提到了你：${preview}`;

  for (const u of candidates) {
    const member = memberByUser.get(u.id);
    // 私聊只有成员能看：非成员 → 在别人的会话里被 @，不发（也挡掉了内容泄露）
    if (!isLobby && !member) continue;
    if (member?.mutedAt) continue; // 静音会话
    if (isLobby && isFocusLobbyBlocked(u)) continue; // 专注模式屏蔽了大区：大区对他不可见
    // 正在看这个会话 → 不进通知列表（他当场就看见了，铃铛闪一下纯属白打扰）。
    // 注意**不能** continue：下面的红点照推 —— 未读就是未读，红点 / 侧栏徽标该亮
    // 还是亮，只是铃铛不响。判不出「在看」时（报到没到 / 流断了 / 多实例）照常发。
    if (!isViewingChannel(u.id, channelId)) {
      await sendNotification({
        recipientId: u.id,
        action: CHAT_MENTION_ACTION,
        actorId: authorId,
        // 指会话不指消息：通知列表的「查看讨论」跳 /chat?channel=<id>。
        // （消息 id 不进 object —— 两个 id 塞不进 (type, id) 两个字段，而会话链接
        //   已经够用：点进去就落在最新消息上。）
        objectType: CHAT_NOTIFY_OBJECT_TYPE,
        objectId: channelId,
        detail,
        prefKey: null, // 不受 notify_* 四个开关管辖（同评论回复：没有对应开关就不拦）
      });
    }
    // 大区被 @ → 顶栏红点亮。sendNotification 只推铃铛那一格，红点是另一格，得单独推。
    // 私聊不用推：同一条消息在上面的 direct 分支已经推过全体成员（被 @ 者必是成员）。
    if (isLobby) void pushChatDot(u.id);
  }
}

/**
 * 发消息。先做资源/内容校验（避免非法请求烧限频额度），再扣限频（仿博客评论）。
 * 不产生站内通知（@ 提及除外，见 notifyChannelMentions）—— 讨论未读归顶栏
 * 「讨论」链接上的红点（见 getChatUnreadSummary），不占铃铛数字。
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const { channelId, authorId, imageId, blogId, patTargetId, replyTo, lobbyBlocked } = input;
  const content = (input.content ?? '').trim();
  const now = nowForDb();

  // 1) 资源校验
  const access = await canAccessChannel(channelId, authorId, lobbyBlocked);
  if (!access.kind) return { ok: false, error: 'notFound', message: '频道不存在' };
  if (!access.allowed) {
    return {
      ok: false,
      error: 'forbidden',
      message:
        lobbyBlocked && channelId === CHAT_LOBBY_ID ? CHAT_FOCUS_BLOCKED_TITLE : '无权在该会话发言',
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
  if (isPatMsg) {
    const target = await prisma.user.findUnique({
      where: { id: patTargetId! },
      select: { id: true },
    });
    if (!target) return { ok: false, error: 'patInvalid', message: '被拍的用户不存在' };
    if (access.kind === CHAT_KIND_DIRECT) {
      const inChannel = await prisma.chatMember.findUnique({
        where: { uq_chat_member_channel_user: { channelId, userId: patTargetId! } },
        select: { id: true },
      });
      if (!inChannel) return { ok: false, error: 'patInvalid', message: '对方不在该会话中' };
    }
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

  // 4) 私聊成员列表：SSE 推送要用（大区广播给全部在线连接，不需要）。
  //    这里**不发「新消息」通知** —— 讨论未读由顶栏「讨论」链接的红点体现；
  //    唯一会进通知列表的是 @ 提及（见第 6 步）。
  let directMemberIds: string[] | null = null;
  if (access.kind === CHAT_KIND_DIRECT) {
    try {
      const members = await prisma.chatMember.findMany({
        where: { channelId },
        select: { userId: true },
      });
      directMemberIds = members.map((m) => m.userId);
    } catch (e) {
      // 取成员失败不影响消息本身：少一次实时推送，下一次对账会补上
      console.error(`[chat-service] 私聊成员查询失败（channelId=${channelId}）:`, e);
    }
  }

  const [dto] = await attachImagesAndReplies([created]);

  // 5) SSE 实时推送（尽力而为：推送失败不影响消息本身，下一次对账会补上）
  try {
    const event = { type: 'message' as const, channel_id: channelId, message: dto };
    if (access.kind === CHAT_KIND_LOBBY) {
      // 大区广播给全部在线连接；专注模式屏蔽了大区的连接跳过（他们本就看不到大区）
      publishToAll(event, dto.id, { skipLobbyBlocked: true });
    } else if (directMemberIds) {
      // 私聊推给全体成员（含发送者自己 → 多标签页同步；客户端按消息 id 去重）
      publishToUsers(directMemberIds, event, dto.id);
      // 收件人的顶栏红点：私聊来了新消息 → 亮。**排除作者自己** ——
      // 他刚发的消息在他自己的读游标推进之前也算「未读」，推给他会先亮后灭
      // （ChatApp 紧跟其后的 markChannelRead 会再推一次正确值），白闪一下。
      for (const uid of directMemberIds) {
        if (uid !== authorId) void pushChatDot(uid);
      }
    }
  } catch (e) {
    console.error(`[chat-service] SSE 推送失败（channelId=${channelId}）:`, e);
  }

  // 6) @ 提及通知（讨论里唯一会进通知列表的东西；拍一拍没有正文，跳过）
  if (!isPatMsg) {
    try {
      await notifyChannelMentions({
        channelId,
        kind: access.kind,
        authorId,
        authorName: dto.author.username,
        content,
      });
    } catch (e) {
      console.error(`[chat-service] @ 提及通知失败（channelId=${channelId}）:`, e);
    }
  }

  return { ok: true, message: dto };
}

/**
 * 推进某频道读游标到给定消息 id（缺省 = 频道当前最大 id）。私聊非成员静默忽略。
 *
 * **游标只增不减**：双端并发、脚本重放较旧的 message_id 时，游标不会被写回去
 * （未读数 = 频道内 id > 游标，一旦回退就会「复活」出一批旧未读和红点）。返回的是
 * **这次写完后实际生效的游标**（只增不减；权限不足 / 空频道为 0），不是请求里的
 * message_id —— 调用方拿到的数字本身也是单调的。
 *
 * 两件事一起发生，缺一不可：
 *   • 讨论**未读**不进通知列表，读游标推进后顶栏「讨论」红点自然熄灭（见 getChatUnreadSummary）；
 *   • 该会话里 **@ 我**的通知（唯一进列表的那种）随之标已读 —— 人已经把消息看了，
 *     铃铛就不该继续吊着。这也让机器人的 /read 与网页端行为一致（见 docs/bot/chat-bot.md §7.6）。
 */
export async function markChannelRead(
  channelId: string,
  userId: string,
  messageId?: number,
  lobbyBlocked = false
): Promise<number> {
  const access = await canAccessChannel(channelId, userId, lobbyBlocked);
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
  const memberKey = { channelId, userId };
  const memberWhere = { uq_chat_member_channel_user: memberKey };

  // ── 游标只增不减 ──────────────────────────────────────────────────────────
  // 不能直接用 `{ lastReadMessageId: { set: upTo } }` 覆盖：读游标是「读到哪」的
  // 唯一真相（未读数、顶栏红点都由它派生），双端同时看一个会话、或脚本重放旧的
  // message_id 时，后到达的较小 id 会把游标写回去，旧未读随之复活。
  // 改成**带条件的单条 UPDATE**：只有库里当前游标更小时才写。SQLite 对单条 UPDATE
  // 是原子的，既不需要事务，也没有「先读后写」被并发覆盖的窗口 —— 并发的多个请求
  // 只会把它推向各自请求里更大的那个值。
  const bumped = await prisma.chatMember.updateMany({
    where: { ...memberKey, lastReadMessageId: { lt: upTo } },
    data: { lastReadMessageId: upTo },
  });
  let advanced = bumped.count > 0;
  /** 已确认的当前游标；null = 还没读到，下面按分支补一次回读。 */
  let cursor: number | null = null;

  if (!advanced) {
    // 两种可能：游标已经 >= upTo，或者成员行还不存在（大区首次进入；私聊成员行由
    // canAccessChannel 的成员校验兜住，必然已存在）。只有「行不存在」才需要写。
    const row = await prisma.chatMember.findUnique({
      where: memberWhere,
      select: { lastReadMessageId: true },
    });
    if (row) {
      cursor = row.lastReadMessageId;
    } else {
      try {
        await prisma.chatMember.create({
          data: { ...memberKey, lastReadMessageId: upTo, createdAt: now },
        });
        advanced = true;
      } catch (e) {
        // 并发首建：唯一约束只会让一方落败。落败者别丢掉这次推进 —— 对方建行时的
        // 基线可能更小（大区基线 = 建行那一刻的最大 id），补一次条件 UPDATE。
        if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
        const retried = await prisma.chatMember.updateMany({
          where: { ...memberKey, lastReadMessageId: { lt: upTo } },
          data: { lastReadMessageId: upTo },
        });
        advanced = retried.count > 0;
      }
    }
  }

  // 实际生效的游标 = 写后回读。并发下可能有更大的值同时落地，回读能把它反映出来；
  // 上面「没写」的分支已经读到过库里那个 >= upTo 的值，无需再读。
  if (cursor == null) {
    cursor =
      (
        await prisma.chatMember.findUnique({
          where: memberWhere,
          select: { lastReadMessageId: true },
        })
      )?.lastReadMessageId ?? upTo;
  }

  // 私聊已读回执：只在**游标真的被推进**时推，且推推进后的值。重放 / 乱序到达的
  // 较小 id 不推 —— 否则对端拿到的 message_id 会先退回去再回来（ChatApp 的 read
  // 帧处理直接把它写进 peer_last_read_message_id，「已读」标记会跟着闪）。大区人多，不推。
  if (advanced && access.kind === CHAT_KIND_DIRECT) {
    try {
      const members = await prisma.chatMember.findMany({
        where: { channelId, NOT: { userId } },
        select: { userId: true },
      });
      publishToUsers(
        members.map((m) => m.userId),
        { type: 'read', channel_id: channelId, user_id: userId, message_id: cursor },
        cursor
      );
    } catch (e) {
      console.error(`[chat-service] 已读回执推送失败（channelId=${channelId}）:`, e);
    }
  }

  // 读到这个会话 = 该会话里 @ 我的都看见了 → 把对应的通知一并标已读（铃铛数字随之下降）。
  // 这是「进大区，那条 @ 自己消掉」的实现；在此之前读游标只推未读、通知要手动去
  // /notifications 点。失败只记日志：已读不该因为通知记账失败而 500。
  try {
    await markChannelNotificationsRead(userId, channelId);
  } catch (e) {
    console.error(`[chat-service] 清会话通知失败（channelId=${channelId}）:`, e);
  }

  // 读游标推进 → 顶栏红点该熄了（读掉全部未读时）。推给本人 ——
  // 不动 pushChatDot 里「算值」那一步：静音 / 隐藏 / 是否还有别的未读会话，
  // 都在 getChatUnreadSummary 里判，这里只负责触发重算。
  void pushChatDot(userId);
  return cursor;
}

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
        reason: outcome.audit.reason || '违反讨论区规则',
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

/**
 * 搜索可私聊对象：仅 core+（只有 core+ 能用讨论），默认排除自己。
 * query 为空时返回最近注册的一批 core+ 用户。按 username 匹配。
 * 返回分页结果 + 总数（弹窗要算总页数）。
 *
 * 【为什么有 includeSelf】用户名片的选择器（src/app/components/UserPicker.tsx）要能
 * 发自己的名片 —— 那是名片最常见的用法之一。私聊弹窗那边照旧排除自己（跟自己私聊没有
 * 意义），所以做成**调用方显式指定**的开关而不是默认值。
 */
export async function searchCoreUsers(
  query: string,
  selfId: string,
  limit = 30,
  offset = 0,
  opts: { includeSelf?: boolean } = {}
): Promise<{ users: ChatUserLite[]; total: number }> {
  const q = query.trim();
  const where: Prisma.UserWhereInput = {
    role: { in: CORE_ROLES },
    ...(opts.includeSelf ? {} : { NOT: { id: selfId } }),
    ...(q ? { username: { contains: q } } : {}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, offset),
      take: Math.min(100, Math.max(1, limit)),
      // 不返回 role：弹窗只需要 id + 用户名，角色属多余暴露。
      // 头像框不是「角色」那类信息 —— 它是站点素材，本来就对所有人显示。
      select: { id: true, username: true, equippedFrameKey: true, equippedFrameExpiresAt: true },
    }),
    prisma.user.count({ where }),
  ]);
  return {
    users: users.map((u) => ({ id: u.id, username: u.username, frame_url: frameUrlFor(u) })),
    total,
  };
}
