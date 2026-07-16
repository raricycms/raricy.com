// ─────────────────────────────────────────────────────────────────────────────
// vote-service.ts — 投票业务逻辑（对齐 Flask app/web/vote/service.py:VoteService）
//
// 与 blog-service 风格一致：纯函数 + 显式参数。软删除：Vote.ignore = true 排除。
// 限频复用共享内存限频器（RULES.voteCreateHourly / RULES.voteHourly）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { rateLimit, RULES } from './rate-limit';

// ── 9 位 base62 ID（对齐 Vote.id 长度；用 crypto 随机 + 拒绝采样避免取模偏置）──────
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateVoteId(length = 9): string {
  const chars: string[] = [];
  const max = Math.floor(256 / BASE62.length) * BASE62.length; // 拒绝采样上界
  while (chars.length < length) {
    const buf = new Uint8Array(length - chars.length);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < max) chars.push(BASE62[byte % BASE62.length]);
      if (chars.length === length) break;
    }
  }
  return chars.join('');
}

// ── 列表：ignore=false，最新在前，带 option_count / total_votes ────────────────
export interface VoteListItem {
  id: string;
  title: string;
  authorId: string;
  authorName: string | null;
  isLocked: boolean;
  createdAt: Date | null;
  optionCount: number;
  totalVotes: number;
}

export async function listVotes(): Promise<VoteListItem[]> {
  const votes = await prisma.vote.findMany({
    where: { ignore: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      authorId: true,
      isLocked: true,
      createdAt: true,
      author: { select: { username: true } },
      options: { select: { voteCount: true } },
    },
  });

  return votes.map((v) => ({
    id: v.id,
    title: v.title,
    authorId: v.authorId,
    authorName: v.author?.username ?? null,
    isLocked: v.isLocked ?? false,
    createdAt: v.createdAt,
    optionCount: v.options.length,
    totalVotes: v.options.reduce((sum, o) => sum + (o.voteCount ?? 0), 0),
  }));
}

// ── 详情：选项 + 计数 + 百分比；当前用户已投的 optionId ────────────────────────
export interface VoteOptionDetail {
  id: number;
  label: string;
  count: number;
  percentage: number;
}
export interface VoteDetail {
  id: string;
  title: string;
  authorId: string;
  authorName: string | null;
  isCreator: boolean;
  isLocked: boolean;
  createdAt: Date | null;
  totalVotes: number;
  userVoted: number | null; // 当前用户已投的 optionId，未投为 null
  options: VoteOptionDetail[];
}

export async function getVoteDetail(
  voteId: string,
  currentUserId: string | null
): Promise<VoteDetail | null> {
  const vote = await prisma.vote.findFirst({
    where: { id: voteId, ignore: false },
    select: {
      id: true,
      title: true,
      authorId: true,
      isLocked: true,
      createdAt: true,
      author: { select: { username: true } },
      options: {
        orderBy: { sortOrder: 'asc' },
        select: { id: true, label: true, voteCount: true },
      },
    },
  });
  if (!vote) return null;

  const userRecord = currentUserId
    ? await prisma.voteRecord.findUnique({
        where: { uq_vote_user: { voteId, userId: currentUserId } },
        select: { optionId: true },
      })
    : null;

  const totalVotes = vote.options.reduce((sum, o) => sum + (o.voteCount ?? 0), 0);

  return {
    id: vote.id,
    title: vote.title,
    authorId: vote.authorId,
    authorName: vote.author?.username ?? null,
    isCreator: !!currentUserId && vote.authorId === currentUserId,
    isLocked: vote.isLocked ?? false,
    createdAt: vote.createdAt,
    totalVotes,
    userVoted: userRecord?.optionId ?? null,
    options: vote.options.map((o) => {
      const count = o.voteCount ?? 0;
      return {
        id: o.id,
        label: o.label,
        count,
        percentage: totalVotes > 0 ? Math.round((count / totalVotes) * 1000) / 10 : 0,
      };
    }),
  };
}

// ── 创建投票 ─────────────────────────────────────────────────────────────────
export type CreateVoteResult =
  | { id: string }
  | { rateLimited: true }
  | { error: string };

export async function createVote(
  userId: string,
  title: string,
  options: string[]
): Promise<CreateVoteResult> {
  const t = title.trim();
  if (t.length < 1 || t.length > 200) return { error: '标题长度必须在1-200字符之间' };

  const opts = options.map((o) => o.trim());
  if (opts.length < 2 || opts.length > 10) return { error: '选项数量必须在2-10个之间' };
  for (const o of opts) {
    if (o.length < 1 || o.length > 200) return { error: '每个选项长度必须在1-200字符之间' };
  }

  if (!rateLimit(`vote:create:${userId}`, RULES.voteCreateHourly).allowed) {
    return { rateLimited: true };
  }

  // 生成唯一 ID（重试 10 次，对齐 Flask）
  let voteId = '';
  for (let i = 0; i < 10; i++) {
    const candidate = generateVoteId(9);
    const clash = await prisma.vote.findUnique({ where: { id: candidate }, select: { id: true } });
    if (!clash) {
      voteId = candidate;
      break;
    }
  }
  if (!voteId) return { error: '无法生成唯一ID，请重试' };

  await prisma.vote.create({
    data: {
      id: voteId,
      title: t,
      authorId: userId,
      isLocked: false,
      ignore: false,
      createdAt: nowForDb(),
      options: {
        create: opts.map((label, idx) => ({ label, sortOrder: idx, voteCount: 0 })),
      },
    },
  });

  return { id: voteId };
}

// ── 投票 ─────────────────────────────────────────────────────────────────────
export type CastVoteResult =
  | { ok: true }
  | { rateLimited: true }
  | { error: string; status: number };

export async function castVote(
  voteId: string,
  optionId: number,
  userId: string
): Promise<CastVoteResult> {
  if (!rateLimit(`vote:cast:${userId}`, RULES.voteHourly).allowed) {
    return { rateLimited: true };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const vote = await tx.vote.findFirst({
        where: { id: voteId, ignore: false },
        select: { id: true, isLocked: true },
      });
      if (!vote) return { error: '投票不存在', status: 404 };
      if (vote.isLocked) return { error: '投票已锁定，无法投票', status: 400 };

      const option = await tx.voteOption.findFirst({
        where: { id: optionId, voteId },
        select: { id: true },
      });
      if (!option) return { error: '选项不存在', status: 400 };

      const existing = await tx.voteRecord.findUnique({
        where: { uq_vote_user: { voteId, userId } },
        select: { id: true },
      });
      if (existing) return { error: '您已经投过票了', status: 400 };

      await tx.voteRecord.create({
        data: { voteId, optionId, userId, createdAt: nowForDb() },
      });
      // 原子自增计数（对齐 Flask option.vote_count += 1）
      await tx.voteOption.update({
        where: { id: optionId },
        data: { voteCount: { increment: 1 } },
      });

      return { ok: true as const };
    });
  } catch (e) {
    // 并发下唯一约束冲突（P2002）→ 视为“已投过”
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      return { error: '您已经投过票了', status: 400 };
    }
    throw e;
  }
}
