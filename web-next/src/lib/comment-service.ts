// ─────────────────────────────────────────────────────────────────────────────
// comment-service.ts — 评论业务逻辑（对齐 Flask CommentService）
//
// 楼中楼：parentId（直接父级）+ rootId（顶层评论串）。评论不渲染 Markdown：
// 保存时仅 HTML 转义并把换行转 <br> 写入 contentHtml（对齐 markupsafe.escape）。
// 软删除：isDeleted=true。列表时构建树并丢弃「无子评论的已删除叶子」
// （对齐 _filter_deleted_leaves）。计数在事务内按「未删除数」重算。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { hasAdminRights } from './auth';
import { rateLimit, RULES } from './rate-limit';
import { sendNotification } from './notification-service';
import { logAdminAction } from './admin-user-service';
import type { Prisma } from '@prisma/client';

// ── 序列化输出（snake_case，对齐 Flask API JSON 形状）──────────────────────────

export interface CommentNode {
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
  content_html: string;
  status: string | null;
  is_deleted: boolean;
  likes_count: number;
  created_at: string | null;
  updated_at: string | null;
  children: CommentNode[];
}

const DELETED_PLACEHOLDER = '[该评论已删除]';

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

// Prisma 行的最小选择集（含作者用于序列化）
const commentSelect = {
  id: true,
  blogId: true,
  authorId: true,
  parentId: true,
  rootId: true,
  contentHtml: true,
  status: true,
  isDeleted: true,
  likesCount: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, role: true } },
} satisfies Prisma.BlogCommentSelect;

type CommentRow = Prisma.BlogCommentGetPayload<{ select: typeof commentSelect }>;

function serializeRow(c: CommentRow): CommentNode {
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
    children: [],
  };
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
 * 获取某文章的评论树（status='approved'，含已删除节点参与建树，
 * 最后丢弃无子的已删除叶子）。输入已按 createdAt 升序，天然保序。
 */
export async function listCommentsForBlog(blogId: string): Promise<CommentNode[]> {
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

  return filterDeletedLeaves(roots);
}

// ── 创建 ─────────────────────────────────────────────────────────────────────

export interface CreateCommentInput {
  blogId: string;
  authorId: string;
  content: string;
  parentId?: string | null;
}

export type CreateCommentResult =
  | { ok: true; comment: CommentNode }
  | {
      ok: false;
      error: 'rateLimited' | 'notFound' | 'empty' | 'tooLong' | 'parentInvalid';
      message: string;
    };

/**
 * 创建评论（对齐 CommentService.create_comment）。
 * 调用方负责登录 / 禁言校验；此处负责频率限制、内容校验、建 root_id、维护冗余计数。
 */
export async function createComment(input: CreateCommentInput): Promise<CreateCommentResult> {
  const { blogId, authorId, parentId } = input;

  // 每日频率限制（对齐 RULES.commentDaily，按用户键）
  const daily = rateLimit(`comment:d:${authorId}`, RULES.commentDaily);
  if (!daily.allowed) {
    return { ok: false, error: 'rateLimited', message: '今日评论已达上限（1200条），请明日再试' };
  }

  const content = (input.content ?? '').trim();
  if (!content) return { ok: false, error: 'empty', message: '评论内容不能为空' };
  if (content.length > 2000) return { ok: false, error: 'tooLong', message: '评论内容不能超过2000字' };

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

    return { ok: true, comment: serializeRow(node.row) };
  } catch {
    return { ok: false, error: 'notFound', message: '文章不存在' };
  }
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
  | { notFound: true };

/**
 * 切换评论点赞（唯一约束 commentId+userId），维护 BlogComment.likesCount。
 */
export async function toggleCommentLike(commentId: string, userId: string): Promise<ToggleLikeResult> {
  return prisma.$transaction(async (tx) => {
    const comment = await tx.blogComment.findUnique({
      where: { id: commentId },
      select: { id: true, isDeleted: true },
    });
    if (!comment || comment.isDeleted) return { notFound: true as const };

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
