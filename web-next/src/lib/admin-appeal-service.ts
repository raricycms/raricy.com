// ─────────────────────────────────────────────────────────────────────────────
// admin-appeal-service.ts — 申诉列表 + 裁决（对齐 Flask app/service/audit_log.py:decide_appeal）
//
// 裁决时：置 status/decision/decidedBy/decidedAt + 写 AdminActionLog + 通知申诉人。
// 通过（accept）时尽力而为地撤回原动作：ban_user 自动解禁；delete_blog 恢复文章
// （ignore=False）；delete_comment 恢复评论（isDeleted=False）并回补文章冗余计数
// （commentsCount 重算 + lastCommentAt 刷新）。均对齐 Flask decide_appeal。
//
// 注意：不 select AdminActionLog.extra（JSON 列，驱动层拒读，见 audit-service）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { isOwner, type SafeUser } from './auth';
import { sendNotification } from './notification-service';
import { logAdminAction, unbanUser, type AdminResult } from './admin-user-service';

const PER_PAGE = 20;

export interface ListAppealsParams {
  page?: number;
  status?: string | null; // 'pending' | 'accepted' | 'rejected'
}

export type AppealRow = {
  id: number;
  content: string;
  status: string;
  decision: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  appellant: { id: string; username: string | null };
  decider: { id: string; username: string | null } | null;
  log: {
    id: number;
    action: string;
    reason: string | null;
    createdAt: string | null;
    objectType: string | null;
    objectId: string | null;
    admin: { id: string; username: string | null };
    targetUser: { id: string; username: string | null } | null;
  } | null;
};

/** 申诉分页列表（带日志 + 申诉人 + 裁决人）。默认最新在前。 */
export async function listAppeals(params: ListAppealsParams) {
  const page = Math.max(1, params.page ?? 1);
  const where = params.status ? { status: params.status } : {};

  const [total, rows] = await Promise.all([
    prisma.adminActionAppeal.count({ where }),
    prisma.adminActionAppeal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
      select: {
        id: true,
        content: true,
        status: true,
        decision: true,
        createdAt: true,
        decidedAt: true,
        appellant: { select: { id: true, username: true } },
        decider: { select: { id: true, username: true } },
        log: {
          // 不含 extra（JSON 列）
          select: {
            id: true,
            action: true,
            reason: true,
            createdAt: true,
            objectType: true,
            objectId: true,
            admin: { select: { id: true, username: true } },
            targetUser: { select: { id: true, username: true } },
          },
        },
      },
    }),
  ]);

  const items: AppealRow[] = rows.map((a) => ({
    id: a.id,
    content: a.content,
    status: a.status,
    decision: a.decision,
    createdAt: a.createdAt ? a.createdAt.toISOString() : null,
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    appellant: { id: a.appellant.id, username: a.appellant.username },
    decider: a.decider ? { id: a.decider.id, username: a.decider.username } : null,
    log: a.log
      ? {
          id: a.log.id,
          action: a.log.action,
          reason: a.log.reason,
          createdAt: a.log.createdAt ? a.log.createdAt.toISOString() : null,
          objectType: a.log.objectType,
          objectId: a.log.objectId,
          admin: { id: a.log.admin.id, username: a.log.admin.username },
          targetUser: a.log.targetUser
            ? { id: a.log.targetUser.id, username: a.log.targetUser.username }
            : null,
        }
      : null,
  }));

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  return { items, total, page, perPage: PER_PAGE, pages, hasPrev: page > 1, hasNext: page < pages };
}

// ── 裁决 ─────────────────────────────────────────────────────────────────────
export interface AdjudicateParams {
  actor: SafeUser;
  appealId: number;
  decision: 'accept' | 'reject';
  note?: string;
}

/**
 * 裁决申诉（对齐 decide_appeal）。accept→status 'accepted'，reject→'rejected'。
 * accept 时尝试撤回原动作（当前：ban_user 自动解禁）。
 *
 * 权限：**仅站长**（Flask 的 decide_appeal 是 @admin_required + @owner_required）。
 * 校验放在 service 层而不只在路由，是与群发同一套纵深防御：申诉是对管理员权力的
 * 制衡，管理员能自己裁决申诉的话这道闸就形同虚设。
 */
export async function adjudicate(p: AdjudicateParams): Promise<AdminResult> {
  if (!isOwner(p.actor)) return { ok: false, code: 403, message: '没有站长权限' };

  if (p.decision !== 'accept' && p.decision !== 'reject')
    return { ok: false, code: 400, message: '无效处理结果' };

  const note = (p.note ?? '').trim();
  const status = p.decision === 'accept' ? 'accepted' : 'rejected';

  const appeal = await prisma.adminActionAppeal.findUnique({
    where: { id: p.appealId },
    select: {
      id: true,
      status: true,
      appellantId: true,
      log: {
        select: {
          id: true,
          action: true,
          targetUserId: true,
          objectType: true,
          objectId: true,
        },
      },
    },
  });
  if (!appeal) return { ok: false, code: 404, message: '申诉不存在' };
  if (appeal.status !== 'pending') return { ok: false, code: 400, message: '申诉已处理' };

  const now = nowForDb();
  await prisma.adminActionAppeal.update({
    where: { id: appeal.id },
    data: {
      status,
      decision: note,
      decidedBy: p.actor.id,
      decidedAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });

  // 尽力而为撤回原动作
  let reversedNote = '';
  if (status === 'accepted' && appeal.log) {
    if (appeal.log.action === 'ban_user' && appeal.log.targetUserId) {
      // unbanUser 自带日志与通知；若目标当前未被禁言会返回 ok:false，忽略即可
      const r = await unbanUser({
        actor: p.actor,
        targetId: appeal.log.targetUserId,
        reason: '申诉通过，自动解除禁言',
      });
      if (r.ok) reversedNote = '，已自动解除禁言';
    } else if (
      appeal.log.action === 'delete_blog' &&
      appeal.log.objectType === 'blog' &&
      appeal.log.objectId
    ) {
      // 恢复被删文章：ignore=False（仅当当前处于软删除态，对齐 Flask decide_appeal）。
      const blogId = appeal.log.objectId;
      const blog = await prisma.blog.findUnique({
        where: { id: blogId },
        select: { id: true, ignore: true },
      });
      if (blog && blog.ignore) {
        await prisma.blog.update({ where: { id: blog.id }, data: { ignore: false } });
        reversedNote = '，已恢复被删文章';
      }
    } else if (
      appeal.log.action === 'delete_comment' &&
      appeal.log.objectType === 'comment' &&
      appeal.log.objectId
    ) {
      // 恢复被删评论：isDeleted=False + 回补文章冗余计数。
      // Flask 仅做 comments_count += 1；此处按任务要求参照 comment-service 的删除/新建路径，
      // 在同一事务内按「未删除评论数」重算 commentsCount，并同步刷新 lastCommentAt
      // （比 += 1 更健壮，且与 createComment/softDeleteComment 的计数口径一致）。
      const commentId = appeal.log.objectId;
      const restored = await prisma.$transaction(async (tx) => {
        const comment = await tx.blogComment.findUnique({
          where: { id: commentId },
          select: { id: true, blogId: true, isDeleted: true },
        });
        if (!comment || !comment.isDeleted) return false;

        await tx.blogComment.update({
          where: { id: comment.id },
          data: { isDeleted: false },
        });

        const commentsCount = await tx.blogComment.count({
          where: { blogId: comment.blogId, isDeleted: false },
        });
        const latest = await tx.blogComment.findFirst({
          where: { blogId: comment.blogId, isDeleted: false },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        await tx.blog.update({
          where: { id: comment.blogId },
          data: { commentsCount, lastCommentAt: latest?.createdAt ?? null },
        });
        return true;
      });
      if (restored) reversedNote = '，已恢复被删评论';
    }
  }

  await logAdminAction({
    action: 'decide_appeal',
    adminId: p.actor.id,
    objectType: 'admin_action_appeal',
    objectId: String(appeal.id),
    reason: note || (status === 'accepted' ? '申诉通过' : '申诉驳回'),
    metadata: { appeal_id: appeal.id, result: status, log_id: appeal.log?.id ?? null },
  });

  // 通知申诉人
  await sendNotification({
    recipientId: appeal.appellantId,
    action: '申诉结果',
    actorId: p.actor.id,
    objectType: 'admin_action_appeal',
    objectId: String(appeal.id),
    detail:
      (status === 'accepted' ? '申诉通过' : '申诉驳回') +
      (note ? `：${note}` : '') +
      reversedNote,
    force: true,
  });

  return { ok: true, message: '处理完成' };
}
