/**
 * 归档/恢复仅限后台 CLI。状态、清余额、撤赞、撤凭据与审计必须一次提交。
 * 原内容的删除标志不改：展示按作者归档态收敛，恢复不会复活原本已删除的内容。
 * 已撤销的点赞、余额、凭据和仓位不随恢复返还。
 */
import { prisma } from './db';
import { isBackendOps } from './audit-context';
import { nowForDb } from './db-time';
import { postEntry } from './fish-service';
import { kickUser } from './chat-bus';
import { kickTopbarUser } from './topbar-bus';
import type { SafeUser } from './auth';
import type { AdminResult } from './admin-user-service';
import type { Prisma } from '@prisma/client';

type Input = { actor: SafeUser; username: string; reason: string };
const CLI_ONLY = { ok: false as const, code: 403, message: '用户归档仅允许通过后台 CLI 操作' };

async function refreshCommentCounts(tx: Prisma.TransactionClient, blogIds: string[]) {
  for (const blogId of new Set(blogIds)) {
    const where = { blogId, isDeleted: false, author: { archivedAt: null } };
    const commentsCount = await tx.blogComment.count({ where });
    const latest = await tx.blogComment.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    await tx.blog.update({ where: { id: blogId }, data: { commentsCount, lastCommentAt: latest?.createdAt ?? null } });
  }
}

async function changeArchive(input: Input, archive: boolean): Promise<AdminResult> {
  if (!isBackendOps()) return CLI_ONLY;
  const reason = input.reason.trim();
  if (!reason || reason.length > 200) return { ok: false, code: 400, message: '原因须为 1..200 字' };
  const result = await prisma.$transaction(async (tx): Promise<AdminResult> => {
    // 重新查 actor，不能让先前取到的已归档/降权快照继续行使权限。
    const actor = await tx.user.findUnique({ where: { id: input.actor.id }, select: { role: true, archivedAt: true } });
    if (!actor || actor.archivedAt || actor.role !== 'owner') return { ok: false, code: 403, message: '需要有效的站长审计主体' };
    const target = await tx.user.findUnique({ where: { username: input.username }, select: {
      id: true, username: true, archivedAt: true, driedFish: true,
    } });
    if (!target) return { ok: false, code: 404, message: '用户不存在' };
    if (target.id === input.actor.id) return { ok: false, code: 403, message: '不能归档或恢复自己' };
    if (!!target.archivedAt === archive) return { ok: true, message: archive ? '用户已经归档，未重复扣减' : '用户未归档，无需恢复' };
    const now = nowForDb();
    const comments = await tx.blogComment.findMany({ where: { authorId: target.id }, select: { blogId: true, id: true } });
    const metadata: Record<string, unknown> = {};
    if (archive) {
      const blogLikes = await tx.blogLike.findMany({ where: { userId: target.id, deleted: false }, select: { blogId: true } });
      const commentLikes = await tx.commentLike.findMany({ where: { userId: target.id, deleted: false }, select: { commentId: true } });
      await tx.blogLike.updateMany({ where: { userId: target.id, deleted: false }, data: { deleted: true, deletedAt: now } });
      await tx.commentLike.updateMany({ where: { userId: target.id, deleted: false }, data: { deleted: true, deletedAt: now } });
      if (target.driedFish !== 0) {
        await postEntry(tx, { userId: target.id, units: -target.driedFish, type: 'archive_clear', description: '账号归档：清空钱包', referenceType: 'user', referenceId: target.id });
      }
      const positions = await tx.marketPosition.updateMany({
        where: { userId: target.id, status: 'open' },
        // 无交易所成交：不伪造平仓价，独立终态不进正常交易盈亏统计。
        data: { status: 'archived', payoutUnits: 0, closedAt: now },
      });
      await tx.oAuthAccessToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.oAuthAuthorizationCode.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: now } });
      await tx.fishApiToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.oAuthApplication.updateMany({ where: { createdById: target.id, disabledAt: null }, data: { disabledAt: now } });
      await tx.fishWebhookEndpoint.updateMany({ where: { userId: target.id }, data: { disabledAt: now } });
      const blogs = await tx.blog.findMany({ where: { authorId: target.id }, select: { id: true } });
      await tx.notification.updateMany({
        where: { hiddenAt: null, OR: [
          { recipientId: target.id }, { actorId: target.id },
          { objectType: 'blog', objectId: { in: blogs.map(b => b.id) } },
          { objectType: 'comment', objectId: { in: comments.map(c => c.id) } },
        ] }, data: { hiddenAt: now },
      });
      await tx.user.update({ where: { id: target.id }, data: {
        archivedAt: now, archiveReason: reason, archivedBy: input.actor.id, sessionVersion: { increment: 1 },
      } });
      for (const blogId of new Set(blogLikes.map(l => l.blogId))) {
        const likesCount = await tx.blogLike.count({ where: { blogId, deleted: false } });
        await tx.blog.update({ where: { id: blogId }, data: { likesCount } });
      }
      for (const commentId of new Set(commentLikes.map(l => l.commentId))) {
        const likesCount = await tx.commentLike.count({ where: { commentId, deleted: false } });
        await tx.blogComment.update({ where: { id: commentId }, data: { likesCount } });
      }
      Object.assign(metadata, { clearedUnits: target.driedFish, blogLikes: blogLikes.length, commentLikes: commentLikes.length, positions: positions.count });
    } else {
      await tx.user.update({ where: { id: target.id }, data: {
        archivedAt: null, archiveReason: null, archivedBy: null, sessionVersion: { increment: 1 },
      } });
    }
    await refreshCommentCounts(tx, comments.map(c => c.blogId));
    const action = archive ? { action: 'archive_user' } : { action: 'unarchive_user' };
    const log = await tx.adminActionLog.create({ data: {
      ...action, adminId: input.actor.id, targetUserId: target.id,
      objectType: 'user', objectId: target.id, reason, visibility: 'internal', createdAt: now,
    }, select: { id: true } });
    await tx.$executeRawUnsafe('UPDATE admin_action_logs SET extra = ? WHERE id = ?', JSON.stringify(metadata), log.id);
    return { ok: true, message: archive ? `已归档 ${target.username}` : `已恢复 ${target.username}（余额、点赞、凭据和仓位不恢复）` };
  }, { timeout: 30000 });
  if (result.ok) {
    const user = await prisma.user.findUnique({ where: { username: input.username }, select: { id: true } });
    if (user) { kickUser(user.id); kickTopbarUser(user.id); }
    // CLI 与网站是不同进程；网站 SSE 的周期版本复核及实时游戏票据复核也会断开旧连接。
  }
  return result;
}

export const archiveUser = (input: Input) => changeArchive(input, true);
export const unarchiveUser = (input: Input) => changeArchive(input, false);
