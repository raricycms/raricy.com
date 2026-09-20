// ─────────────────────────────────────────────────────────────────────────────
// fish-service.ts — 小鱼干服务
//
// 读路径（余额 / 流水 / 排行榜）+ 写路径的**唯一记账内核** postEntry()。
//
// 【记账内核】`postEntry(tx, { userId, units, ... })` 收调用方的 tx，
//   在**同一个事务里**改余额 + 写一行 `fish_transactions`。这是全站唯一改
//   `users.driedFish` 的入口 —— 钱的路径只有一扇门，才谈得上「余额与流水对得上」。
//
//   ⚠️ **必须在调用方的事务里调用**。单条 UPDATE + 一条 INSERT 之间若没有事务包着，
//   「余额改了、流水没写」就是一次静默的账目损坏。
//
// 【为什么没有「远端账户服务」这一层】本站的鱼干账户曾经在站外一个独立的 FastAPI
//   微服务里，每次写都要 fail-closed 地调它，失败再由补偿事务撤销本地写入。那个边界
//   已经撤销（见 docs/architecture.md §6.3）：账目与业务数据在同一个 SQLite 文件里，
//   一个事务就能保证原子性，不需要补偿，也不可能出现「两个存储对不上」。
//   历史注记与当年那套 outbox 的失败模式见 §6.3。
//
// 【单位】入参 units 是**存储单位**（0.1 鱼干）的有符号整数，由调用方用
//   `fishToUnits()` 从业务鱼干换算而来。见 fish-units.ts。
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
  /** 用户间转账的共享单号；其余流水一律 null（见 migrations/14_fish_transfer_id）。 */
  transferId: string | null;
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
  transferId: string | null;
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
    transferId: t.transferId,
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
 * feed_all / transfer_all / market_all 是「合称」特例：一侧是支出、另一侧是收入，
 * 两个 type 都要。分页查询与增量查询共用这一份 —— 两边各写一份必然 drift，
 * 而漏掉半边账是静默的。
 */
function applyTypeFilter(where: Prisma.FishTransactionWhereInput, type?: string | null): void {
  if (!type) return;
  if (type === 'feed_all') where.type = { in: ['feed', 'feed_receive'] };
  else if (type === 'transfer_all') where.type = { in: ['transfer', 'transfer_receive'] };
  else if (type === 'market_all') where.type = { in: ['market_buy', 'market_sell'] };
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
 * 【取到即终态】流水与它对应的余额变动在**同一个事务**里提交，因此这里读到的
 * 每一行都是已经生效且不会再变的 —— 对账方「一看见就入账」是安全的，不需要滞后。
 * （历史注记：账户服务曾把回滚做成「删掉已写下的流水」，那时对账方必须留 10 秒滞后
 * 躲开「先可见、后消失」的行；那个窗口随转账改本地事务一起消失了。）
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

// ── 写入：记账内核 ──────────────────────────────────────────────────────────

/**
 * 余额不足（扣减时条件写的谓词没命中）。
 *
 * 与「用户不存在」在实现上都会让条件写的 count 为 0，本内核**不区分**它们：
 * 两者的正确处理都是让事务失败，而调用方要区分的只是「这是业务错误还是故障」。
 * 需要业务文案的调用方接住它转成自己的错误类型。
 */
export class InsufficientFishError extends Error {
  constructor(
    public readonly userId: string,
    public readonly neededUnits: number
  ) {
    super(`小鱼干不足（user=${userId} 需要 ${neededUnits} 单位）`);
    this.name = 'InsufficientFishError';
  }
}

export interface PostEntryInput {
  userId: string;
  /**
   * **存储单位**（0.1 鱼干）的有符号整数。正 = 入账，负 = 出账。
   * 0 / 非整数 / 非有限数一律抛 —— 静默吞掉一笔 0 会让流水与实际余额对不上。
   */
  units: number;
  type: string;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  relatedUserId?: string | null;
  /**
   * 用户间转账的共享单号。**只有 fish-market-service 的转账会传它** ——
   * 其余调用方（fish-admin / feed-service / checkin-service / market-service）
   * 没有对手方，留空即 NULL，别为了「统一」给它们编一个
   * （见 prisma/migrations/14_fish_transfer_id）。
   */
  transferId?: string | null;
}

/**
 * 记账内核：改余额 + 写一行流水。**全站唯一改 `users.driedFish` 的地方。**
 *
 * @param tx 调用方的事务客户端。必须由 `prisma.$transaction` 传入 ——
 *           与其它写入（订单、持仓、回调出账…）原子提交。
 * @returns 创建的流水行 id
 * @throws InsufficientFishError 出账时余额不足
 */
export async function postEntry(tx: TxClient, input: PostEntryInput): Promise<{ txId: number }> {
  const { units } = input;
  if (!Number.isInteger(units) || units === 0) {
    throw new Error(`units 必须是「非零整数」（存储单位 0.1 鱼干）: ${units}`);
  }

  if (units < 0) {
    // 出账：谓词写进 UPDATE（`driedFish >= need`），单条语句完成判定 + 扣减 ——
    // 读出来再判断再写回去会与并发扣款互相覆盖，扣出负余额。
    const need = -units;
    const dec = await tx.user.updateMany({
      where: { id: input.userId, driedFish: { gte: need } },
      data: { driedFish: { decrement: need } },
    });
    if (dec.count === 0) throw new InsufficientFishError(input.userId, need);
  } else {
    // 入账：increment 不可能变负，不需要条件写（DB 侧原子加，不是读-改-写）。
    await tx.user.update({
      where: { id: input.userId },
      data: { driedFish: { increment: units } },
    });
  }

  const row = await tx.fishTransaction.create({
    data: {
      userId: input.userId,
      amount: units,
      type: input.type,
      description: input.description ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      relatedUserId: input.relatedUserId ?? null,
      transferId: input.transferId ?? null,
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

export interface AddFishInput {
  userId: string;
  /** 业务单位的鱼干，**必须为正**。 */
  amount: number;
  type: string;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  relatedUserId?: string | null;
  transferId?: string | null;
}

/**
 * 入账（只加不减）。`addFish` 与 `postEntry` 的关系是**语义收窄**：
 * 前者说「这是一笔收入」（投喂分成、签到发鱼、转账收款），后者说「这是一笔账」。
 * 收窄是有用的 —— 读到 `addFish` 就不必去确认 amount 的符号。
 *
 * @throws Error amount 非正数（负数请直接用 postEntry：那是一次出账）
 */
export async function addFish(tx: TxClient, input: AddFishInput): Promise<{ txId: number }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('amount 必须为正数');
  }
  return postEntry(tx, { ...input, units: fishToUnits(input.amount) });
}
