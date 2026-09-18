// ─────────────────────────────────────────────────────────────────────────────
// fish-service.ts — 小鱼干服务
//
// 本切片实现读路径（余额 / 流水 / 排行榜）+ 一个供签到复用的本地写入 addFish()。
//
// ⚠️ 写路径 fail-closed：本函数**只在本地事务内加钱**，刻意不碰远端 ——
//   它收的是调用方的 tx，而远端 HTTP 绝不能放进事务（写锁会被占满整个超时，
//   并发写直接 database is locked，见 docs/architecture.md §6.3）。
//
//   远端同步与失败补偿是**调用方**的责任，统一走 src/lib/fish-sync.ts 的账本机制：
//   本地事务提交时顺带记一行 pending，事务外调远端，失败则用补偿事务精确撤销
//   （对用户等价于「回滚 + 503」）。四个调用方：
//   checkin-service（翻牌发鱼）、feed-service（作者分成）、
//   fish-admin（CLI grant / deduct）、fish-market-service（转账收款方）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, todayStr, dayStart } from './db-time';
import { fishToUnits, unitsToFish } from './fish-units';
import type { Prisma } from '@prisma/client';

/** 事务客户端类型（$transaction 回调里传入的 tx）。 */
type TxClient = Prisma.TransactionClient;

/** 查询单个用户余额；用户不存在返回 0。 */
export async function getBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { driedFish: true },
  });
  return unitsToFish(user?.driedFish ?? 0);
}

/**
 * 批量查询余额。返回 {userId: balance}。
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
  for (const u of users) result[u.id] = unitsToFish(u.driedFish);
  return result;
}

/** UTC+8 当天日期 YYYY-MM-DD。 */
function todayUtc8(): string {
  return todayStr(); // 统一走 db-time 的时区约定
}

/**
 * 今日签到获得的小鱼干数量。未签到返回 0。
 *
 * 取 UTC+8 今天首条 checkin 流水的 amount。
 *
 * 【为什么不用 SQLite 的 date(created_at)】
 * 老数据把 DATETIME 存为 TEXT，date() 能解析；但 **Prisma 往 SQLite 写
 * DateTime 时存的是 INTEGER（Unix 毫秒）**，date(整数) 返回 NULL —— 即所有由 Next
 * 写入的签到流水都匹配不上，今日签到会静默显示为 0。切换后同一列会 TEXT/INTEGER
 * 混存（老数据 TEXT、新数据 INTEGER），任何裸 SQL 日期函数都不可靠。
 * 改用 Prisma 原生范围查询：其查询引擎对两种存储都能正确比较（已实测）。
 */
export async function getTodayCheckinFish(userId: string): Promise<number> {
  const today = todayUtc8();
  // 【时区约定】库里存的是「UTC+8 墙上时间，贴 Z 标签」——
  // 旧版用 datetime.now() 写 naive 本地时间（生产服务器 TZ=UTC+8，已由数据反推证实：
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
  return row?.amount != null ? unitsToFish(row.amount) : 0;
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

/** FishTransaction 行 → DTO（分页与增量两条读路径共用，避免字段漂移）。 */
function toFishTxDTO(t: {
  id: number;
  amount: number;
  type: string;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  relatedUserId: string | null;
  createdAt: Date | null;
}): FishTxDTO {
  return {
    id: t.id,
    amount: unitsToFish(t.amount),
    type: t.type,
    description: t.description,
    referenceType: t.referenceType,
    referenceId: t.referenceId,
    relatedUserId: t.relatedUserId,
    createdAt: t.createdAt ? t.createdAt.toISOString() : null,
  };
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

/**
 * 筛选条口径 → Prisma where。
 *
 * feed_all / transfer_all 是「合称」特例：一侧是支出、另一侧是收入，两个 type 都要。
 * 分页查询与增量查询共用这一份 —— 两边各写一份必然 drift，而漏掉半边账是静默的。
 */
function applyTypeFilter(where: Prisma.FishTransactionWhereInput, type?: string | null): void {
  if (!type) return;
  if (type === 'feed_all') where.type = { in: ['feed', 'feed_receive'] };
  else if (type === 'transfer_all') where.type = { in: ['transfer', 'transfer_receive'] };
  else where.type = type;
}

/**
 * 增量查询：`id > sinceId` 的流水，按 **id 升序**。
 *
 * 【为什么需要它】站外对账方（银行 / 记账机器人）不能靠翻页 —— 新行会不断插入，
 * 页码在两次请求之间会漂移，结果是**漏记或重记客户的钱**。给一个单调游标就够：
 * 取回 → 处理 → 把 `nextCursor` 存下来，构造上不可能漏。
 *
 * 用 id 而不是 createdAt 作游标：id 是自增主键，严格单调且同毫秒也不会并列
 * （createdAt 是 INTEGER 毫秒，同毫秒多笔时无全序）。
 *
 * 【已知边界（文档同步）】转账被远端故障回滚时，那两条流水会被**删除**。
 * 对账方若「一看见就入账」，可能入了一笔随后消失的钱 —— 所以拉取时请留一个
 * 小滞后（只处理 createdAt 早于 now-10s 的行），见 docs/bot/fish-bot.md §3.3.1。
 */
export async function getTransactionsSince(
  userId: string,
  sinceId: number,
  limit = 100,
  type?: string | null
): Promise<FishTxDTO[]> {
  const take = Math.min(100, Math.max(1, limit));
  const where: Prisma.FishTransactionWhereInput = { userId, id: { gt: Math.max(0, sinceId) } };
  applyTypeFilter(where, type);

  const rows = await prisma.fishTransaction.findMany({
    where,
    orderBy: { id: 'asc' },
    take,
  });
  return rows.map(toFishTxDTO);
}

/** 分页查询用户交易流水。 */
export async function getTransactions(
  userId: string,
  page = 1,
  perPage = 20,
  type?: string | null
): Promise<TransactionsPage> {
  const p = Math.max(1, page);
  const pp = Math.min(100, Math.max(1, perPage));

  const where: Prisma.FishTransactionWhereInput = { userId };
  applyTypeFilter(where, type);

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
    transactions: rows.map(toFishTxDTO),
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

/** 小鱼干余额排行榜。 */
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
    balance: unitsToFish(u.driedFish),
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
 * 增加小鱼干 + 写流水（仅本地写）。必须在一个事务里调用，
 * tx 由调用方从 prisma.$transaction 传入，以便与其它写入原子提交。
 *
 * @returns 创建的流水行 id —— 供写路径的远端同步失败补偿（fish-sync）精确删除。
 *
 * ⚠️ 生产上线：调用链要在远端账户服务 transfer 成功后才提交该事务（fail-closed）。
 */
export async function addFish(tx: TxClient, input: AddFishInput): Promise<{ txId: number }> {
  if (input.amount <= 0) throw new Error('amount 必须为正数');

  // 存储 = 0.1 鱼干为单位（fish-units.ts）；input.amount 是业务单位的鱼干。
  const units = fishToUnits(input.amount);

  await tx.user.update({
    where: { id: input.userId },
    data: { driedFish: { increment: units } },
  });

  const row = await tx.fishTransaction.create({
    data: {
      userId: input.userId,
      amount: units,
      type: input.type,
      description: input.description ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      relatedUserId: input.relatedUserId ?? null,
      // 必须显式写：schema 里 createdAt 是 DateTime? 且**没有** @default(now())
      //（既有库结构如此），漏写会让整条流水时间为 NULL —— 流水倒序会乱、今日签到判定失效。
      // 用 nowForDb() 而非 new Date()：本库时间戳语义是「UTC+8 墙上时间贴 Z」，
      // 详见 src/lib/db-time.ts 的说明。
      createdAt: nowForDb(),
    },
    select: { id: true },
  });
  return { txId: row.id };
}
