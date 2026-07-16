// ─────────────────────────────────────────────────────────────────────────────
// fish-service.ts — 小鱼干服务（对齐 Flask app/service/fish.py）
//
// 本切片实现读路径（余额 / 流水 / 排行榜）+ 一个供签到复用的本地写入 addFish()。
//
// ⚠️ 写路径 fail-closed 提醒：Flask 侧所有写路径（签到/投喂/CLI）都要求先向账户
//   微服务同步成功再 commit 本地。addFish() 这里只写本地 DB —— 调用方（如
//   checkin-service.doCheckin）负责在正式环境接入远端同步。本迁移切片仅写本地。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';

/** 事务客户端类型（$transaction 回调里传入的 tx）。 */
type TxClient = Prisma.TransactionClient;

/** 查询单个用户余额；用户不存在返回 0。 */
export async function getBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { driedFish: true },
  });
  return user?.driedFish ?? 0;
}

export interface FishTxDTO {
  id: number;
  amount: number;
  type: string;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  relatedUserId: string | null;
  createdAt: string | null;
}

export interface TransactionsPage {
  transactions: FishTxDTO[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** 分页查询用户交易流水（对齐 get_transactions）。 */
export async function getTransactions(
  userId: string,
  page = 1,
  perPage = 20,
  type?: string | null
): Promise<TransactionsPage> {
  const p = Math.max(1, page);
  const pp = Math.min(100, Math.max(1, perPage));

  const where: Prisma.FishTransactionWhereInput = { userId };
  if (type) {
    // feed_all：投喂与被投喂（对齐 Flask 特例）
    if (type === 'feed_all') where.type = { in: ['feed', 'feed_receive'] };
    else where.type = type;
  }

  const [total, rows] = await Promise.all([
    prisma.fishTransaction.count({ where }),
    prisma.fishTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (p - 1) * pp,
      take: pp,
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / pp));
  return {
    transactions: rows.map((t) => ({
      id: t.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      relatedUserId: t.relatedUserId,
      createdAt: t.createdAt ? t.createdAt.toISOString() : null,
    })),
    total,
    page: p,
    perPage: pp,
    pages,
    hasPrev: p > 1,
    hasNext: p < pages,
  };
}

export interface FishLeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarPath: string | null;
  balance: number;
}

/** 小鱼干余额排行榜（对齐 get_balance_leaderboard）。 */
export async function getBalanceLeaderboard(limit = 50): Promise<FishLeaderboardEntry[]> {
  const users = await prisma.user.findMany({
    where: { driedFish: { gt: 0 } },
    orderBy: { driedFish: 'desc' },
    take: limit,
    select: { id: true, username: true, avatarPath: true, driedFish: true },
  });
  return users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    username: u.username,
    avatarPath: u.avatarPath,
    balance: u.driedFish,
  }));
}

// ── 写入（供签到等复用，仅本地）─────────────────────────────────────────────

export interface AddFishInput {
  userId: string;
  amount: number;
  type: string;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  relatedUserId?: string | null;
}

/**
 * 增加小鱼干 + 写流水（对齐 add_fish，仅本地写）。必须在一个事务里调用，
 * tx 由调用方从 prisma.$transaction 传入，以便与其它写入原子提交。
 *
 * ⚠️ 生产上线：调用链要在远端账户服务 transfer 成功后才提交该事务（fail-closed）。
 */
export async function addFish(tx: TxClient, input: AddFishInput): Promise<void> {
  if (input.amount <= 0) throw new Error('amount 必须为正数');

  await tx.user.update({
    where: { id: input.userId },
    data: { driedFish: { increment: input.amount } },
  });

  await tx.fishTransaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      description: input.description ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      relatedUserId: input.relatedUserId ?? null,
    },
  });
}
