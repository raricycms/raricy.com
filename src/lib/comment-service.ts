// ─────────────────────────────────────────────────────────────────────────────
// comment-service.ts — 评论业务逻辑（对齐 Flask CommentService）
//
// 楼中楼：parentId（直接父级）+ rootId（顶层评论串）。软删除：isDeleted=true。
// 列表时构建树并丢弃「无子评论的已删除叶子」（对齐 _filter_deleted_leaves）。
// 计数在事务内按「未删除数」重算。
//
// 【正文与附件的存储口径】
//   · content      —— 正文**原文**（Markdown 源）。下发到前端由 comment-markdown.ts
//                     渲染；注意它是用户输入，前端必须走那条净化管线，绝不直接 innerHTML。
//   · contentHtml  —— 服务端转义的纯文本 + <br>。**站内已不再用它渲染**，它保留给
//                     spider API（外部只读接口，不能让它因为站内换了渲染方式而被打碎）
//                     以及「没跑 JS」时的降级形态。
//   · imageId / quoteBlogId —— 附件（图床图片 / 引用博客）。只存引用不存快照，
//                     读时按当前行解析，缺失给占位 —— 与 chat_messages 同策略。
//
// ⚠️ 依赖 Prisma 6 的 findMany/orderBy，不依赖 DOM；Markdown 渲染全在前端
//    （服务端没有 window，DOMPurify 会静默降级 —— 见 rich-text.ts 防线 5）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { COMMENT_TEXT_MAX, COMMENT_CAPTION_MAX } from './comment-shared';
import { nowForDb } from './db-time';
import { hasAdminRights } from './auth';
import { rateLimit, RULES } from './rate-limit';
import { sendNotification } from './notification-service';
import { logAdminAction } from './admin-user-service';
import type { Prisma } from '@prisma/client';

// ── 序列化输出（snake_case，对齐 Flask API JSON 形状）──────────────────────────

/** 评论引用的图床图片（读时解析；图被软删 → null，由 image_missing 说明）。 */
export interface CommentImageDTO {
  id: string;
  url: string;
  mime_type: string;
}

/** 评论引用的博客（读时按当前 Blog 行解析，不存快照 —— 对齐 ChatBlogDTO）。 */
export interface CommentBlogDTO {
  id: string;
  title: string;
  description: string;
  author: string | null; // 作者 username
  updated_at: string | null; // ISO
}

/**
 * 评论序列化的**公共部分** —— 站内评论树（本文件）与爬虫扁平列表
 * （spider-service.ts）共用同一份实现。
 *
 * 【为什么单拆一层】爬虫接口是**对外契约**（无认证、使用方是站外的爬虫/聚合器），
 * 它只需要这里列出的这些字段，且**不该**因为站内给评论加了 content / image / blog
 * 就跟着变形状。此前两边各写一份序列化，逻辑逐字重复 —— 改了一处另一边不会变，
 * 而且看代码很难发现。现在：公共部分唯一，各自只加自己的字段。
 */
export interface CommentBaseDTO {
  id: string;
  blog_id: string;
  author: {
    id: string | null;
    username: string | null;
    is_admin: boolean;
    avatar_url: string | null;
  };
  parent_id: string | null;
  root_id: string | null;
  /** 服务端转义的纯文本 + <br>：spider API 与无 JS 降级用；站内不用它渲染。 */
  content_html: string;
  status: string | null;
  is_deleted: boolean;
  likes_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** `serializeCommentBase` 只读这些列 —— 两边各自的行类型都满足它。 */
export interface CommentBaseRow {
  id: string;
  blogId: string;
  parentId: string | null;
  rootId: string | null;
  contentHtml: string | null;
  status: string | null;
  isDeleted: boolean | null;
  likesCount: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  author: { id: string; username: string; role: string } | null;
}

export interface CommentNode extends CommentBaseDTO {
  /**
   * 正文原文（Markdown 源）。前端必须经 renderCommentMarkdown 净化后渲染 ——
   * 它是用户输入，直接 innerHTML 等于开存储型 XSS。
   */
  content: string;
  /** 引用的图床图片；软删的评论一律为 null（连同 blog 一起抹掉）。 */
  image: CommentImageDTO | null;
  /** imageId 有值但图缺失/已软删 → 前端给 [图片已删除] 占位。 */
  image_missing: boolean;
  blog: CommentBlogDTO | null;
  /** quoteBlogId 有值但博客缺失/已软删 → 前端给 [博客已删除] 占位。 */
  blog_missing: boolean;
  /**
   * 当前**查看者**有没有赞过这条。⚠️ 不在 CommentBaseDTO 里 —— 它是随人而变的，
   * 而 spider 接口无认证（恒为未登录），把 liked 加进公共部分等于凭空改变对外契约
   * （tests/service/spider-comment.test.ts 会挡住）。
   * 未登录访问 / 已删除的评论一律 false（前者没有「我」，后者不可点赞）。
   */
  liked: boolean;
  children: CommentNode[];
}

const DELETED_PLACEHOLDER = '[该评论已删除]';

// 字数上限是前后端共用的纯数据，定义在 comment-shared.ts（客户端组件 import 本文件
// 会把 prisma / next/headers 打进浏览器包 —— 那个文件头解释了为什么）。这里 re-export
// 只是为了让服务端调用方少一个 import。
export { COMMENT_TEXT_MAX, COMMENT_CAPTION_MAX } from './comment-shared';

// markupsafe.escape 语义：& < > " ' → 实体
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

/** 评论内容 → contentHtml：仅转义 + 换行转 <br>（不支持 Markdown）。 */
export function toContentHtml(content: string): string {
  return escapeHtml(content).replace(/\n/g, '<br>');
}

// Prisma 行的最小选择集（含作者用于序列化；附件只取 id，读时批量解析）
const commentSelect = {
  id: true,
  blogId: true,
  authorId: true,
  parentId: true,
  rootId: true,
  content: true,
  contentHtml: true,
  imageId: true,
  quoteBlogId: true,
  status: true,
  isDeleted: true,
  likesCount: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, role: true } },
} satisfies Prisma.BlogCommentSelect;

type CommentRow = Prisma.BlogCommentGetPayload<{ select: typeof commentSelect }>;

/**
 * 序列化的公共部分（站内树与爬虫扁平列表共用，见 CommentBaseDTO 的说明）。
 *
 * ⚠️ 软删的评论在这里就把 content_html 换成占位文案 —— 这是**唯一**一处，
 * 两个调用方自动都拿到「不泄露原文」的行为。
 */
export function serializeCommentBase(c: CommentBaseRow): CommentBaseDTO {
  const deleted = c.isDeleted ?? false;
  return {
    id: c.id,
    blog_id: c.blogId,
    author: {
      id: c.author?.id ?? null,
      username: c.author?.username ?? null,
      is_admin: c.author ? hasAdminRights(c.author) : false,
      avatar_url: c.author ? `/api/avatar/${c.author.id}` : null,
    },
    parent_id: c.parentId,
    root_id: c.rootId,
    content_html: deleted ? DELETED_PLACEHOLDER : c.contentHtml ?? '',
    status: c.status,
    is_deleted: deleted,
    likes_count: c.likesCount ?? 0,
    created_at: c.createdAt ? c.createdAt.toISOString() : null,
    updated_at: c.updatedAt ? c.updatedAt.toISOString() : null,
  };
}

function serializeRow(c: CommentRow): CommentNode {
  const deleted = c.isDeleted ?? false;
  return {
    ...serializeCommentBase(c),
    // ★ 软删即抹掉原文 ★ 与 content_html 同一口径：保留的已删节点（有子评论）只显示
    // 占位文案。若这里下发 content，前端渲染出来等于「删了等于没删」，且与原设计
    // 「不泄露原文」直接冲突（tests/service/comment-service.test.ts 有专门用例）。
    content: deleted ? DELETED_PLACEHOLDER : c.content ?? '',
    // 附件默认空，由 attachAttachments 批量填（软删的一律保持 null，同 content）
    image: null,
    image_missing: false,
    blog: null,
    blog_missing: false,
    // 随人而变，由 attachLikes 按查看者批量填；未登录 / 软删恒为 false
    liked: false,
    children: [],
  };
}

/** 深度优先展平成数组（建树之后用它收集整棵树的附件 id）。 */
function flatten(nodes: CommentNode[], out: CommentNode[] = []): CommentNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

/**
 * 批量解析附件（图床图片 / 引用博客）并**就地**写回节点。
 *
 * 【为什么批量】评论区一次要下发整棵树（可能上百条），逐条查图 / 查博客就是 N+1。
 * 这里把整棵树的 imageId / quoteBlogId 去重后各查一次，与 chat-service 的
 * attachImagesAndReplies 同一套做法。
 *
 * 缺失语义：id 有值但行不存在或已软删 → *_missing=true 让前端出占位，而不是静默
 * 当成「没有附件」（否则用户会以为引用丢了）。软删的评论一律不解析附件 —— 与
 * chat-service「软删即抹掉附件」一致，否则删掉的图仍能点开看原图。
 */
async function attachAttachments(nodes: CommentNode[], rows: CommentRow[]): Promise<void> {
  if (!nodes.length) return;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const imageIds = [
    ...new Set(
      rows
        .filter((r) => !(r.isDeleted ?? false))
        .map((r) => r.imageId)
        .filter((v): v is string => !!v)
    ),
  ];
  const quoteIds = [
    ...new Set(
      rows
        .filter((r) => !(r.isDeleted ?? false))
        .map((r) => r.quoteBlogId)
        .filter((v): v is string => !!v)
    ),
  ];

  const imageMap = new Map<string, { id: string; mimeType: string }>();
  if (imageIds.length) {
    const imgs = await prisma.imageHosting.findMany({
      where: { id: { in: imageIds }, ignore: false },
      select: { id: true, mimeType: true },
    });
    for (const i of imgs) imageMap.set(i.id, i);
  }

  const blogMap = new Map<
    string,
    {
      id: string;
      title: string;
      description: string;
      author: { username: string } | null;
      content: { updatedAt: Date | null } | null;
    }
  >();
  if (quoteIds.length) {
    const blogs = await prisma.blog.findMany({
      where: { id: { in: quoteIds }, ignore: false },
      select: {
        id: true,
        title: true,
        description: true,
        author: { select: { username: true } },
        content: { select: { updatedAt: true } },
      },
    });
    for (const b of blogs) blogMap.set(b.id, b);
  }

  for (const node of flatten(nodes)) {
    const row = byId.get(node.id);
    if (!row) continue;
    const deleted = row.isDeleted ?? false;
    const img = row.imageId ? imageMap.get(row.imageId) : undefined;
    const blog = row.quoteBlogId ? blogMap.get(row.quoteBlogId) : undefined;
    node.image =
      !deleted && img
        ? { id: img.id, url: `/api/images/${img.id}/raw`, mime_type: img.mimeType }
        : null;
    node.image_missing = !deleted && !!row.imageId && !img;
    node.blog =
      !deleted && blog
        ? {
            id: blog.id,
            title: blog.title,
            description: blog.description,
            author: blog.author?.username ?? null,
            updated_at: blog.content?.updatedAt ? blog.content.updatedAt.toISOString() : null,
          }
        : null;
    node.blog_missing = !deleted && !!row.quoteBlogId && !blog;
  }
}

/** 递归移除「无子评论的已删除评论」（对齐 _filter_deleted_leaves）。 */
function filterDeletedLeaves(nodes: CommentNode[]): CommentNode[] {
  const result: CommentNode[] = [];
  for (const node of nodes) {
    node.children = filterDeletedLeaves(node.children);
    if (node.is_deleted && node.children.length === 0) continue;
    result.push(node);
  }
  return result;
}

/**
 * 按查看者批量填 `liked`（未登录传 null → 全部保持 false）。
 *
 * 与 attachAttachments 同样是「一次查完整棵树」的批量做法 —— 评论树可能上百条，
 * 逐条查 CommentLike 就是 N+1。已删除的评论**不查也不标**：它们不可点赞
 * （toggleCommentLike 对软删一律 notFound），前端也不给按钮。
 */
async function attachLikes(nodes: CommentNode[], viewerId: string | null): Promise<void> {
  if (!viewerId) return;
  const targets = flatten(nodes).filter((n) => !n.is_deleted);
  if (!targets.length) return;

  const likes = await prisma.commentLike.findMany({
    where: { userId: viewerId, commentId: { in: targets.map((n) => n.id) } },
    select: { commentId: true },
  });
  const likedIds = new Set(likes.map((l) => l.commentId));
  for (const n of targets) n.liked = likedIds.has(n.id);
}

/**
 * 获取某文章的评论树（status='approved'，含已删除节点参与建树，
 * 最后丢弃无子的已删除叶子）。输入已按 createdAt 升序，天然保序。
 *
 * @param viewerId 当前登录用户（未登录传 null）。只影响每条评论的 `liked` ——
 *                 评论树本身是公开的（GET 接口无认证）。
 */
export async function listCommentsForBlog(
  blogId: string,
  viewerId: string | null = null
): Promise<CommentNode[]> {
  const rows = await prisma.blogComment.findMany({
    where: { blogId, status: 'approved' },
    orderBy: { createdAt: 'asc' },
    select: commentSelect,
  });
  if (rows.length === 0) return [];

  const idToNode = new Map<string, CommentNode>();
  for (const r of rows) idToNode.set(r.id, serializeRow(r));

  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = idToNode.get(r.id)!;
    const parent = r.parentId ? idToNode.get(r.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  await attachAttachments(roots, rows);
  await attachLikes(roots, viewerId);
  return filterDeletedLeaves(roots);
}

// ── 创建 ─────────────────────────────────────────────────────────────────────

export interface CreateCommentInput {
  blogId: string;
  authorId: string;
  content: string;
  parentId?: string | null;
  /** 引用的图床图片 id（须属于作者本人且未软删）。 */
  imageId?: string | null;
  /** 引用的博客 id（须存在且未软删）。 */
  quoteBlogId?: string | null;
}

export type CreateCommentResult =
  | { ok: true; comment: CommentNode }
  | {
      ok: false;
      error:
        | 'rateLimited'
        | 'notFound'
        | 'empty'
        | 'tooLong'
        | 'captionTooLong'
        | 'imageInvalid'
        | 'blogInvalid'
        | 'parentInvalid';
      message: string;
    };

/**
 * 创建评论（对齐 CommentService.create_comment）。
 * 调用方负责登录 / 禁言校验；此处负责频率限制、内容与附件校验、建 root_id、维护冗余计数。
 */
export async function createComment(input: CreateCommentInput): Promise<CreateCommentResult> {
  const { blogId, authorId, parentId } = input;

  // 每日频率限制（对齐 RULES.commentDaily，按用户键）
  const daily = rateLimit(`comment:d:${authorId}`, RULES.commentDaily);
  if (!daily.allowed) {
    return { ok: false, error: 'rateLimited', message: '今日评论已达上限（1200条），请明日再试' };
  }

  const content = (input.content ?? '').trim();
  const imageId = input.imageId || null;
  const quoteBlogId = input.quoteBlogId || null;
  // 附件消息允许空正文（对齐聊天：引用一张图 / 一篇文章本身就是一条完整表达）
  const isAttach = !!imageId || !!quoteBlogId;

  // 校验一律放在事务外：事务里只做写入，别让额外的读把 SQLite 写锁多占几毫秒
  // （写锁争用是这套单进程 SQLite 的老毛病，见 docs/architecture.md）。
  if (!isAttach) {
    if (!content) return { ok: false, error: 'empty', message: '评论内容不能为空' };
    if (content.length > COMMENT_TEXT_MAX) {
      return { ok: false, error: 'tooLong', message: `评论内容不能超过${COMMENT_TEXT_MAX}字` };
    }
  } else {
    // 带附件时按图注档限长：图片 + 2000 字在一条评论里排版会很难看（与聊天同口径）
    if (content.length > COMMENT_CAPTION_MAX) {
      return {
        ok: false,
        error: 'captionTooLong',
        message: `图片或引用评论不能超过${COMMENT_CAPTION_MAX}字`,
      };
    }
    if (imageId) {
      // 必须是自己传的图：否则可以引用别人的图（乃至猜 id 探测未公开的图）。
      // 与 chat-service.sendMessage 的 imageInvalid 判定逐字对齐。
      const img = await prisma.imageHosting.findUnique({
        where: { id: imageId },
        select: { id: true, authorId: true, ignore: true },
      });
      if (!img || img.ignore || img.authorId !== authorId) {
        return { ok: false, error: 'imageInvalid', message: '图片不存在或不属于你，请重新上传' };
      }
    }
    if (quoteBlogId) {
      const blog = await prisma.blog.findFirst({
        where: { id: quoteBlogId, ignore: false },
        select: { id: true },
      });
      if (!blog) return { ok: false, error: 'blogInvalid', message: '引用的博客不存在或已删除' };
    }
  }

  const contentHtml = toContentHtml(content);
  const now = nowForDb();
  const id = crypto.randomUUID();

  try {
    const node = await prisma.$transaction(async (tx) => {
      // 带出 title/authorId 供事务提交后发通知（对齐 Flask 的评论通知）
      const blog = await tx.blog.findFirst({
        where: { id: blogId, ignore: false },
        select: { id: true, title: true, authorId: true },
      });
      if (!blog) return { notFound: true as const };

      let resolvedParentId: string | null = null;
      let rootId: string | null = null;
      let parentAuthorId: string | null = null;
      if (parentId) {
        const parent = await tx.blogComment.findUnique({
          where: { id: parentId },
          select: { id: true, blogId: true, rootId: true, isDeleted: true, authorId: true },
        });
        if (!parent || parent.blogId !== blogId || parent.isDeleted) {
          return { parentInvalid: true as const };
        }
        resolvedParentId = parent.id;
        rootId = parent.rootId ?? parent.id;
        parentAuthorId = parent.authorId;
      }

      const created = await tx.blogComment.create({
        data: {
          id,
          blogId,
          authorId,
          parentId: resolvedParentId,
          rootId,
          content,
          contentHtml,
          imageId,
          quoteBlogId,
          status: 'approved',
          isDeleted: false,
          likesCount: 0,
          createdAt: now,
          updatedAt: now,
        },
        select: commentSelect,
      });

      const commentsCount = await tx.blogComment.count({ where: { blogId, isDeleted: false } });
      await tx.blog.update({ where: { id: blogId }, data: { commentsCount, lastCommentAt: now } });

      return {
        row: created,
        notify: {
          blogTitle: blog.title,
          blogAuthorId: blog.authorId,
          parentAuthorId,
        },
      };
    });

    if ('notFound' in node) return { ok: false, error: 'notFound', message: '文章不存在' };
    if ('parentInvalid' in node) return { ok: false, error: 'parentInvalid', message: '父评论不存在或已删除' };

    // 发送通知（对齐 Flask CommentService.create_comment）：
    //   回复 → 通知被回复者；顶层 → 通知文章作者；两者都排除「自己评自己」。
    // 与 Flask 一致：通知失败不影响主流程（评论已提交成功），故整体 try/catch 吞掉。
    try {
      const { blogTitle, blogAuthorId, parentAuthorId: pAuthor } = node.notify;
      if (pAuthor && pAuthor !== authorId) {
        await sendNotification({
          recipientId: pAuthor,
          action: '评论回复',
          actorId: authorId,
          objectType: 'blog',
          objectId: blogId,
          detail: `你的评论在《${blogTitle}》下收到了回复`,
        });
      } else if (!pAuthor && blogAuthorId && blogAuthorId !== authorId) {
        await sendNotification({
          recipientId: blogAuthorId,
          action: '文章评论',
          actorId: authorId,
          objectType: 'blog',
          objectId: blogId,
          detail: `你的文章《${blogTitle}》收到了新评论`,
        });
      }
    } catch {
      // 通知失败不影响评论本身（对齐 Flask 的 try/except pass）
    }

    // 刚创建的这一条自带附件（若用户是「引用图 / 引用博客」提交的）—— 解析一次再返回，
    // 否则前端要等到下次整树刷新才看得见自己刚发的图。
    const comment = serializeRow(node.row);
    await attachAttachments([comment], [node.row]);
    return { ok: true, comment };
  } catch (e) {
    // 【不要把所有异常都洗成「文章不存在」】
    // 曾经这里是裸 `catch { return notFound }`：任何 DB 故障（外键冲突、磁盘错误、
    // 锁超时…）都会变成一个误导性的 404，且零日志 —— 真出事时排查会极其痛苦。
    // 实测过：传一个不存在的 authorId 会触发外键违例，却报「文章不存在」。
    //
    // 现在：已知的业务性外键违例（P2003，如 authorId 不存在）仍按 404 处理，
    // 其余一律记日志后上抛，让路由返回 500 并留下真实堆栈。
    if (isForeignKeyViolation(e)) {
      return { ok: false, error: 'notFound', message: '文章不存在' };
    }
    console.error(`[comment-service] createComment 失败（blogId=${blogId}, authorId=${authorId}）:`, e);
    throw e;
  }
}

/** Prisma 外键约束违例（P2003）。 */
function isForeignKeyViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Prisma.PrismaClientKnownRequestError).code === 'P2003'
  );
}

// ── 软删除 ───────────────────────────────────────────────────────────────────

export type DeleteActor = { id: string; role: string };

export type DeleteCommentResult =
  | { ok: true }
  | {
      ok: false;
      // reasonRequired / reasonTooLong：管理员删他人评论时的原因校验（对齐 Flask）
      error: 'notFound' | 'forbidden' | 'reasonRequired' | 'reasonTooLong';
      message: string;
    };

/**
 * 软删除评论（对齐 delete_comment）：作者本人或管理员可删。
 * 删除后重算文章未删除评论数与 lastCommentAt。
 *
 * @param reason 管理员删「他人」评论时必填（1..500）；作者删自己的可省略。
 *               该原因会写入 AdminActionLog —— /audit 公示与用户申诉依赖它。
 */
export async function softDeleteComment(
  commentId: string,
  actor: DeleteActor,
  reason?: string
): Promise<DeleteCommentResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const comment = await tx.blogComment.findUnique({
      where: { id: commentId },
      select: { id: true, blogId: true, authorId: true, isDeleted: true },
    });
    if (!comment || comment.isDeleted) {
      return { ok: false as const, error: 'notFound' as const, message: '评论不存在或已删除' };
    }

    const isAuthor = comment.authorId === actor.id;
    if (!isAuthor && !hasAdminRights(actor)) {
      return { ok: false as const, error: 'forbidden' as const, message: '无权删除该评论' };
    }

    // 对齐 Flask：管理员删「他人」评论时必须给出原因（1..500），作者删自己的不需要。
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

    await tx.blogComment.update({ where: { id: commentId }, data: { isDeleted: true } });

    const commentsCount = await tx.blogComment.count({ where: { blogId: comment.blogId, isDeleted: false } });
    const latest = await tx.blogComment.findFirst({
      where: { blogId: comment.blogId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    await tx.blog.update({
      where: { id: comment.blogId },
      data: { commentsCount, lastCommentAt: latest?.createdAt ?? null },
    });

    return {
      ok: true as const,
      audit: adminDeletingOthers
        ? { targetUserId: comment.authorId, blogId: comment.blogId, reason: trimmedReason }
        : null,
    };
  });

  // 记录管理员操作日志（对齐 Flask：管理员删他人评论才记）。
  // 这条日志是 /audit 公示与申诉流程的数据来源 —— 缺了用户就无法申诉。
  // 与 Flask 一致：日志失败不回滚删除本身。
  if (outcome.ok && outcome.audit) {
    try {
      await logAdminAction({
        action: 'delete_comment',
        adminId: actor.id,
        targetUserId: outcome.audit.targetUserId,
        objectType: 'comment',
        objectId: commentId,
        reason: outcome.audit.reason || '违反规则',
        metadata: { blog_id: outcome.audit.blogId },
      });
    } catch {
      /* 审计写入失败不影响删除结果（对齐 Flask 的 try/except pass） */
    }
  }

  if (outcome.ok) return { ok: true };
  // 剥掉内部用的 audit 字段，只暴露对外契约
  const { ok, error, message } = outcome;
  return { ok, error, message };
}

// ── 点赞切换 ─────────────────────────────────────────────────────────────────

export type ToggleLikeResult =
  | { liked: boolean; likesCount: number }
  | { notFound: true }
  | { rateLimited: true };

/**
 * 切换评论点赞（唯一约束 commentId+userId），维护 BlogComment.likesCount。
 *
 * 限频口径对齐 blog-service.toggleLike：先查存在性、再扣配额（刷不存在的 id 不该
 * 烧掉自己的点赞额度），规则值同 RULES.likeHourly / likeDaily。
 *
 * ⚠️ 但**计桶的键与博客点赞分开**（`comment-like:` 前缀）：共用 `like:h:${userId}`
 * 的话，给评论点赞会顶掉文章的额度、反之亦然 —— 那是「新增一个功能」顺带改变了
 * 既有行为，不该发生。
 *
 * 【为什么不发通知】博客点赞会通知作者，评论点赞刻意不发：一篇文章的评论可能被同一
 * 个人连赞多条，每条都推一次会把通知列表刷满。当前产品口径就是「评论点赞是轻互动，
 * 不进通知」。（若将来要改，需先定「同一人对同一篇文章的多条评论只发一条」之类的闸门。）
 */
export async function toggleCommentLike(commentId: string, userId: string): Promise<ToggleLikeResult> {
  const exists = await prisma.blogComment.findFirst({
    where: { id: commentId, isDeleted: false },
    select: { id: true },
  });
  if (!exists) return { notFound: true as const };

  const hourly = rateLimit(`comment-like:h:${userId}`, RULES.likeHourly);
  const daily = rateLimit(`comment-like:d:${userId}`, RULES.likeDaily);
  if (!hourly.allowed || !daily.allowed) return { rateLimited: true as const };

  return prisma.$transaction(async (tx) => {
    // 事务内再确认一次：并发下这条评论可能刚被软删
    const comment = await tx.blogComment.findFirst({
      where: { id: commentId, isDeleted: false },
      select: { id: true },
    });
    if (!comment) return { notFound: true as const };

    const existing = await tx.commentLike.findUnique({
      where: { uq_comment_like_comment_user: { commentId, userId } },
    });

    let liked: boolean;
    if (existing) {
      await tx.commentLike.delete({ where: { id: existing.id } });
      liked = false;
    } else {
      await tx.commentLike.create({ data: { commentId, userId, createdAt: nowForDb() } });
      liked = true;
    }

    const likesCount = await tx.commentLike.count({ where: { commentId } });
    await tx.blogComment.update({ where: { id: commentId }, data: { likesCount } });
    return { liked, likesCount };
  });
}
