// ─────────────────────────────────────────────────────────────────────────────
// admin-vote-service.ts — 投票的管理端检索与恢复
//
// 与 admin-clipboard-service 同构。投票没有正文（只有标题 + 选项），所以搜索面窄：
// 标题 / 9 位短 id / 作者用户名。
//
// Vote 有两个正交的状态位，别混：
//   ignore   —— 软删除（本文件管的）
//   isLocked —— 停止投票，但内容照常可见（本文件不管，也没必要管）
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import { isOwner } from './auth';
import { logAdminAction, type AdminResult } from './admin-user-service';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export interface VoteActor {
  id: string;
  role: string;
}

export interface AdminVoteListParams {
  page?: number;
  perPage?: number;
  /** 关键词：标题 / 9 位短 id / 作者用户名。 */
  search?: string | null;
  status?: 'all' | 'active' | 'deleted';
}

export async function listAdminVotes(params: AdminVoteListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.VoteWhereInput = {};
  if (params.status === 'active') where.ignore = false;
  else if (params.status === 'deleted') where.ignore = true;

  const q = (params.search ?? '').trim();
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { id: q }, // 直接粘一个 9 位短 id
      { author: { is: { username: { contains: q } } } },
    ];
  }

  const [total, votes] = await Promise.all([
    prisma.vote.count({ where }),
    prisma.vote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        title: true,
        authorId: true,
        isLocked: true,
        ignore: true,
        createdAt: true,
        author: { select: { username: true } },
        _count: { select: { records: true, options: true } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { votes, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 单条投票详情（含选项与票数）。不过滤 ignore。 */
export async function getVoteForAdmin(voteId: string) {
  return prisma.vote.findUnique({
    where: { id: voteId },
    select: {
      id: true,
      title: true,
      authorId: true,
      isLocked: true,
      ignore: true,
      createdAt: true,
      author: { select: { username: true } },
      options: {
        // voteCount 是冗余计数（与 VoteRecord 的实际行数应当一致）
        select: { id: true, label: true, voteCount: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      },
      _count: { select: { records: true } },
    },
  });
}

/** 权限与剪贴板一致：作者本人或站长。 */
function canTouch(voteAuthorId: string, actor: VoteActor): boolean {
  return voteAuthorId === actor.id || isOwner(actor);
}

/**
 * 恢复软删的投票。
 * 票数与选项从未被动过（软删只翻 ignore），所以恢复后计票原样可用。
 */
export async function restoreVote(
  voteId: string,
  actor: VoteActor,
  reason?: string
): Promise<AdminResult<{ id: string }>> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    select: { id: true, authorId: true, ignore: true },
  });
  if (!vote) return { ok: false, code: 404, message: '投票不存在' };
  if (!canTouch(vote.authorId, actor)) return { ok: false, code: 403, message: '无权操作该投票' };
  if (!vote.ignore) return { ok: false, code: 400, message: '该投票未被删除' };

  await prisma.vote.update({ where: { id: voteId }, data: { ignore: false } });

  try {
    await logAdminAction({
      action: 'restore_vote',
      adminId: actor.id,
      targetUserId: vote.authorId,
      objectType: 'vote',
      objectId: voteId,
      reason: (reason ?? '').trim() || null,
    });
  } catch {
    /* 审计写入失败不影响恢复结果 */
  }

  return { ok: true, message: '已恢复投票', id: voteId };
}

/** 软删投票。网页端没有删除入口，这是新增能力（审计与恢复配套才有意义）。 */
export async function softDeleteVote(
  voteId: string,
  actor: VoteActor,
  reason: string
): Promise<AdminResult<{ id: string }>> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    select: { id: true, authorId: true, ignore: true },
  });
  if (!vote) return { ok: false, code: 404, message: '投票不存在' };
  if (vote.ignore) return { ok: false, code: 400, message: '该投票已被删除' };
  if (!canTouch(vote.authorId, actor)) return { ok: false, code: 403, message: '无权操作该投票' };

  await prisma.vote.update({ where: { id: voteId }, data: { ignore: true } });

  try {
    await logAdminAction({
      action: 'delete_vote',
      adminId: actor.id,
      targetUserId: vote.authorId,
      objectType: 'vote',
      objectId: voteId,
      reason: reason.trim() || null,
    });
  } catch {
    /* 审计写入失败不影响删除结果 */
  }

  return { ok: true, message: '已删除投票', id: voteId };
}
