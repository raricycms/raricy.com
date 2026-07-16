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
import { nowForDb, todayStr, dayStart } from './db-time';
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

/**
 * 批量查询余额（对齐 get_balance_batch）。返回 {userId: balance}。
 * 不存在的 userId 对应 0；最多支持 500 个 ID，超出截断。
 */
export async function getBalanceBatch(userIds: string[]): Promise<Record<string, number>> {
  if (!userIds || userIds.length === 0) return {};
  const ids = userIds.slice(0, 500);
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, driedFish: true },
  });
  const result: Record<string, number> = {};
  for (const uid of ids) result[uid] = 0;
  for (const u of users) result[u.id] = u.driedFish;
  return result;
}

/** UTC+8 当天日期 YYYY-MM-DD（对齐 Flask app/service/checkin._today_utc8）。 */
function todayUtc8(): string {
  return todayStr(); // 统一走 db-time 的时区约定
}

/**
 * 今日签到获得的小鱼干数量（对齐 get_today_checkin_fish）。未签到返回 0。
 *
 * 取 UTC+8 今天首条 checkin 流水的 amount。
 *
 * 【为什么不用 SQLite 的 date(created_at)】
 * Flask/SQLAlchemy 把 DATETIME 存为 TEXT，date() 能解析；但 **Prisma 往 SQLite 写
 * DateTime 时存的是 INTEGER（Unix 毫秒）**，date(整数) 返回 NULL —— 即所有由 Next
 * 写入的签到流水都匹配不上，今日签到会静默显示为 0。切换后同一列会 TEXT/INTEGER
 * 混存（老数据 TEXT、新数据 INTEGER），任何裸 SQL 日期函数都不可靠。
 * 改用 Prisma 原生范围查询：其查询引擎对两种存储都能正确比较（已实测）。
 */
export async function getTodayCheckinFish(userId: string): Promise<number> {
  const today = todayUtc8();
  // 【时区约定】库里存的是「UTC+8 墙上时间，贴 Z 标签」——
  // Flask 用 datetime.now() 写 naive 本地时间（生产服务器 TZ=UTC+8，已由数据反推证实：
  // daily_checkins 里 date(created_at) 与显式按 UTC+8 算的 checkin_date 2170/2170 全等），
  // normalize-datetimes 只补 'T'/'Z' 不做平移，故墙上时间被原样保留。
  // 因此这里**不做时区平移**，直接按墙上日期取区间；checkin-service 的 dateAtDay 同此约定。
  const start = dayStart(today);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const row = await prisma.fishTransaction.findFirst({
    where: { userId, type: 'checkin', createdAt: { gte: start, lt: end } },
    select: { amount: true },
    orderBy: { createdAt: 'asc' },
  });
  return row?.amount ?? 0;
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
      // 必须显式写：schema 里 createdAt 是 DateTime? 且**没有** @default(now())
      //（对齐既有库结构），漏写会让整条流水时间为 NULL —— 流水倒序会乱、今日签到判定失效。
      // 用 nowForDb() 而非 new Date()：本库时间戳语义是「UTC+8 墙上时间贴 Z」，
      // 详见 src/lib/db-time.ts 的说明。
      createdAt: nowForDb(),
    },
  });
}
