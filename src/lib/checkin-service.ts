// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑（对齐 Flask app/service/checkin.py）
//
// 【两步式：签到 → 翻牌定命】（Flask 原始设计，本文件忠实复原）
//   1. checkIn()：只建当日记录 —— fortune_value 留 NULL、fortune_pool 洗好落库。
//      不发鱼、不累加 totalFortune、不碰账户服务。成功即「已签到、待翻牌」。
//   2. claimFortune()：用户点选一张牌（chosenIndex 0-4）—— 服务端从**签到当时
//      落库的那副牌**里取 pool[chosenIndex] 赋值。此刻才：发鱼干 + 累加
//      totalFortune + 远端账户同步（fail-closed）。翻哪张、拿哪个值，在翻牌
//      这一瞬间由用户的选择决定 —— 而非签到瞬间抽定后由前端「演」出来。
//
// 【为什么恢复两步】概率上两种设计等价（池均匀、每值 1/5），但语义不同：
//   合并版在签到瞬间抽定值，翻牌只是把既定值交换到被点的牌上做动画；
//   两步式里「灵性/直觉选牌」真正决定了结果。
//
// 【发鱼干的 fail-closed 机制】详见 src/lib/fish-sync.ts：本地事务先提交 + 账本
//   登记 pending → 提交后调远端 → 失败走补偿事务。**补偿把 fortune_value 复原为
//   NULL（行保留）**，用户保持「已签到未翻牌」可重选牌 —— 对齐 Flask claim_fortune
//   的 rollback 语义（rollback 后同样回到待翻牌态）。绝不可删行：删行会释放唯一
//   约束，让用户误以为要重新签到，且当天会重复占天数。
//
// 【幂等键】checkin-{userId}-{date}：claim 是唯一发钱点，键与旧版完全一致，
//   重复提交/重放不会重复发放。
//
// 【已知语义副作用（Flask 同款，非 bug）】跨 UTC+8 午夜窗口：用户在 23:59 签到、
//   00:00 后才点牌 → claim 按「今天」查不到记录 → 400「今天还没有签到」，
//   那张牌作废。一步式没有这个窗口 —— 这是回到两步式的固有代价。
//
// checkinDate 存储：UTC+8 当天的“零点 UTC”ISO 值（如 2026-07-15T00:00:00.000Z），
//   与规整后 dev.db 中既有行的存储格式一致，保证唯一约束 (userId, checkinDate) 生效。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import {
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  AccountServiceError,
} from './account-client';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
  type PendingSyncEntry,
} from './fish-sync';
import type { Prisma } from '@prisma/client';

const FORTUNE_LABELS: Record<number, string> = {
  1: '平平淡淡也是真',
  2: '小有运气',
  3: '运势不错',
  4: '好运连连',
  5: '运势爆棚',
};

/** 运势值对应的文案，越界返回空串。 */
export function fortuneLabel(value: number | null | undefined): string {
  if (value == null) return '';
  return FORTUNE_LABELS[value] ?? '';
}

/** UTC+8 当天的 YYYY-MM-DD（对齐 Flask _today_utc8）。 */
export function todayUtc8(): string {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** 把 YYYY-MM-DD 转成存库用的 Date（零点 UTC）。 */
function dateAtDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** 生成洗牌后的 "3,1,5,2,4"（1-5 各一张，共 5 张）。 */
function shuffledPool(): string {
  const nums = [1, 2, 3, 4, 5];
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums.join(',');
}

/** 解析 fortune_pool 字符串为数组；非法返回 null。 */
function parsePool(pool: string | null): number[] | null {
  if (!pool) return null;
  const vals = pool.split(',').map((x) => Number.parseInt(x, 10));
  if (vals.length !== 5 || vals.some((v) => Number.isNaN(v))) return null;
  return vals;
}

export interface CheckinStatus {
  checkedIn: boolean;
  /** 已签到但 fortuneValue 仍为 NULL（等待翻牌）。 */
  fortunePending: boolean;
  totalCount: number;
  today: string;
  fortuneValue: number | null;
  fortunePool: number[] | null;
  totalFortune: number;
  driedFish: number;
}

/** 今日签到状态 + 累计天数 + 余额（对齐 get_today_status）。 */
export async function getTodayStatus(userId: string): Promise<CheckinStatus> {
  const today = todayUtc8();

  const [record, totalCount, user] = await Promise.all([
    prisma.dailyCheckIn.findUnique({
      where: { uq_user_checkin_date: { userId, checkinDate: dateAtDay(today) } },
      select: { fortuneValue: true, fortunePool: true },
    }),
    prisma.dailyCheckIn.count({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { totalFortune: true, driedFish: true },
    }),
  ]);

  const checkedIn = record !== null;
  return {
    checkedIn,
    fortunePending: checkedIn && record.fortuneValue == null,
    totalCount,
    today,
    fortuneValue: record?.fortuneValue ?? null,
    fortunePool: record ? parsePool(record.fortunePool) : null,
    totalFortune: user?.totalFortune ?? 0,
    driedFish: unitsToFish(user?.driedFish ?? 0),
  };
}

export type CheckinResult =
  | { alreadyChecked: true; message: string; status: CheckinStatus }
  | { alreadyChecked: false; totalCount: number };

/**
 * 第一步：签到。只建当日记录（fortune_value=NULL、fortune_pool 洗好落库），
 * 唯一约束 (userId, checkinDate) 保证一天一次；命中冲突 → 返回「今天已签到」。
 * 不发鱼、不累加运势、不碰账户服务 —— 发钱在 claimFortune()。
 */
export async function checkIn(userId: string): Promise<CheckinResult> {
  const today = todayUtc8();
  const checkinDate = dateAtDay(today);
  const pool = shuffledPool();

  // 生产漏配置守卫（比 Flask 严的运营防线，fail-closed 哲学）：
  // 本步虽无远端调用，但若 prod 漏配 ACCOUNT_SERVICE，签到行会堆积成永远无法
  // claim 的死记录 —— 直接拒绝比放行更安全。dev 下静默放行（无 warn：
  // 本步没有跳过任何远端操作，真正的发钱点 claimFortune 才会告警）。
  if (!accountServiceEnabled()) {
    assertRemoteRequiredInProduction('签到');
  }

  try {
    // createdAt 必须显式写：schema 里是 DateTime? 且无 @default(now())，
    // 而 Flask 模型是 default=datetime.now（真实库 2170 行全部有值）。
    // 漏写会让排行榜的次级排序键（max(created_at) asc）失效。
    await prisma.dailyCheckIn.create({
      data: { userId, checkinDate, fortunePool: pool, createdAt: nowForDb() },
      select: { id: true },
    });
  } catch (e) {
    // 唯一约束冲突 → 今天已签到（并发/重复提交，本地事务已回滚）
    if (isUniqueViolation(e)) {
      const status = await getTodayStatus(userId);
      return { alreadyChecked: true, message: '今天已签到', status };
    }
    throw e;
  }

  const totalCount = await prisma.dailyCheckIn.count({ where: { userId } });
  return { alreadyChecked: false, totalCount };
}

// ── claimFortune 的结果 ──────────────────────────────────────────────────────

export type ClaimResult =
  | { ok: false; message: string }
  | {
      ok: true;
      /** true = 已被（本请求或并发请求）翻过，幂等返回现值；false = 本请求翻的。 */
      alreadyClaimed: boolean;
      fortuneValue: number;
      pool: number[];
      totalFortune: number;
      driedFish: number;
    };

/** 读用户余额（鱼干存储单位 → 鱼干）。 */
async function readBalances(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { totalFortune: true, driedFish: true },
  });
  return { totalFortune: u?.totalFortune ?? 0, driedFish: unitsToFish(u?.driedFish ?? 0) };
}

/** 幂等成功结果（翻过牌了）：现值 + 牌池 + 余额。 */
async function idempotentResult(userId: string, record: { fortuneValue: number | null; fortunePool: string | null }) {
  const balances = await readBalances(userId);
  return {
    ok: true as const,
    alreadyClaimed: true,
    fortuneValue: record.fortuneValue ?? 0,
    pool: parsePool(record.fortunePool) ?? [],
    ...balances,
  };
}

/**
 * 第二步：翻牌。用户在签到落库的那副牌（fortune_pool）里点选一张（0-4），
 * 服务端从池中取 pool[chosenIndex] 赋值给 fortune_value，并发鱼干 + 累加
 * totalFortune + 远端账户同步。翻牌才是命运揭晓的一刻 —— 用户的选择决定结果。
 *
 * 判序对齐 Flask claim_fortune（顺序不能乱）：
 *   ① 无当天记录 → 「今天还没有签到」；
 *   ② fortune_value 已定 → 幂等成功返回（已在①之后、index 校验之前 ——
 *      已翻过牌的用户带非法 index 再来，返回的是现值而非「无效的选择」）；
 *   ③ 牌池解析失败 → 「运势池数据异常」；
 *   ④ index 非整数/越界 → 「无效的选择」（绝不静默随机开盲盒：用户想选某张牌
 *      却拿到随机牌，且翻牌只能一次、无法重来）；
 *   ⑤ 原子 UPDATE … WHERE fortune_value IS NULL —— 并发翻牌只赢一个，
 *      rowcount==0 的输家幂等返回（对齐 Flask 的 atomic update，防 TOCTOU 双发鱼）。
 *
 * @param chosenIndex 必填，0-4。
 */
export async function claimFortune(userId: string, chosenIndex: number): Promise<ClaimResult> {
  const today = todayUtc8();
  const checkinDate = dateAtDay(today);

  // ── 事务外预读（只读不持锁）──────────────────────────────────────────────
  const record = await prisma.dailyCheckIn.findUnique({
    where: { uq_user_checkin_date: { userId, checkinDate } },
    select: { fortuneValue: true, fortunePool: true },
  });
  if (!record) return { ok: false, message: '今天还没有签到' };

  // ① → ② 幂等快路径
  if (record.fortuneValue != null) {
    return idempotentResult(userId, record);
  }

  // ③ 牌池校验
  const pool = parsePool(record.fortunePool);
  if (!pool) return { ok: false, message: '运势池数据异常' };

  // ④ index 校验
  if (!Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex >= pool.length) {
    return { ok: false, message: '无效的选择' };
  }
  const fortuneValue = pool[chosenIndex];

  // 远端同步是否启用（未配置 internal token → 开发模式）。
  // 未配置：生产 fail-closed（不做任何本地写入直接拒绝）；dev 仅本地 + 告警。
  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('签到翻牌');
    console.warn(
      `[checkin-service] ACCOUNT_SERVICE 未配置，翻牌发鱼仅写本地库（dev fallback）。` +
        `user=${userId} date=${today} value=${fortuneValue}`
    );
  }

  // 远端幂等键（与旧版完全一致，重复提交不会重复发放）。
  const entry: PendingSyncEntry = {
    idempotencyKey: `checkin-${userId}-${today}`,
    operation: 'checkin',
    payload: {
      toUserId: userId,
      amount: fortuneValue,
      description: `每日签到（运势值 ${fortuneValue}）`,
      date: today,
      fortuneValue,
    },
  };

  try {
    // ── Phase 1：赢家事务（纯 DB，无远端 IO —— 写锁只持有毫秒级）────────────────
    //   fortune_value 原子置值（NULL → value）+ totalFortune + 鱼干 + 流水 +
    //   账本行 pending 全部原子提交；远端同步在事务外进行（详见 fish-sync.ts）。
    const phase1 = await prisma.$transaction(async (tx) => {
      // 原子认领：并发翻牌只有一个能拿到 count>0（对齐 Flask 的
      // UPDATE … WHERE fortune_value IS NULL + rowcount 判断）
      const claim = await tx.dailyCheckIn.updateMany({
        where: { userId, checkinDate, fortuneValue: null },
        data: { fortuneValue },
      });
      if (claim.count === 0) return { won: false as const };

      // 累加 totalFortune
      await tx.user.update({
        where: { id: userId },
        data: { totalFortune: { increment: fortuneValue } },
      });

      // 发鱼干 + 写流水（本地）
      const fish = await addFish(tx, {
        userId,
        amount: fortuneValue,
        type: 'checkin',
        description: entry.payload.description as string,
      });

      // 账本登记 pending（远端启用时）
      if (remoteEnabled) {
        await recordPendingSync(tx, entry);
      }

      return { won: true as const, fishTxId: fish.txId };
    });

    if (!phase1.won) {
      // 并发输家：别人已翻 —— 事务外重读现值后幂等返回（别在事务里嵌套查询）
      const cur = await prisma.dailyCheckIn.findUniqueOrThrow({
        where: { uq_user_checkin_date: { userId, checkinDate } },
        select: { fortuneValue: true, fortunePool: true },
      });
      return idempotentResult(userId, cur);
    }

    // ── Phase 2：事务外远端同步（系统账户 → 用户；提交后调用，失败走补偿）────────
    if (remoteEnabled) {
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        // ── Phase 3：远端失败 → 补偿事务把 fortune_value 复原为 NULL ──────────
        //   【不变式】复原而非删行：用户保持「已签到未翻牌」，可重选牌再 claim；
        //   删行会释放唯一约束 → 用户误以为要重新签到（与 Flask rollback 语义背离）。
        //   复原守卫用本笔的 value —— 若值已被并发改写（count==0），说明
        //   局面已被别笔 claim 接管，绝不能回退余额（会扣错钱），交给 reconcile。
        try {
          await prisma.$transaction(async (tx) => {
            const reset = await tx.dailyCheckIn.updateMany({
              where: { userId, checkinDate, fortuneValue },
              data: { fortuneValue: null },
            });
            if (reset.count === 0) {
              throw new Error(
                `fortune_value 已被并发改写，跳过余额回退（user=${userId} date=${today} value=${fortuneValue}）`
              );
            }
            const decFortune = await tx.user.updateMany({
              where: { id: userId, totalFortune: { gte: fortuneValue } },
              data: { totalFortune: { decrement: fortuneValue } },
            });
            if (decFortune.count === 0) {
              throw new Error(`totalFortune 不足以回退（user=${userId} value=${fortuneValue}）`);
            }
            const decFish = await tx.user.updateMany({
              where: { id: userId, driedFish: { gte: fishToUnits(fortuneValue) } },
              data: { driedFish: { decrement: fishToUnits(fortuneValue) } },
            });
            if (decFish.count === 0) {
              throw new Error(`driedFish 不足以回退（user=${userId} value=${fortuneValue}）`);
            }
            await tx.fishTransaction.deleteMany({ where: { id: phase1.fishTxId } });
            // 删除账本行：释放幂等键，用户重选牌重试时可以重建（无痕失败）
            await tx.accountSyncLedger.deleteMany({ where: { idempotencyKey: entry.idempotencyKey } });
          });
        } catch (undoErr) {
          // 补偿也失败：账本行留 pending/failed，sync-retry 可幂等重放收敛。
          await settleSync(entry.idempotencyKey, 'failed', String(undoErr)).catch(() => {
            /* 尽力而为 */
          });
          await logReconcileRequired(entry, undoErr);
        }
        throw syncErr instanceof AccountServiceError
          ? syncErr
          : new AccountServiceError(`账户服务暂不可用，签到失败: ${String(syncErr)}`, 503);
      }
    }
  } catch (e) {
    // 远端失败：本地已被补偿（复原为待翻牌态，等价于 Flask 的 rollback），
    // 向上抛让路由返回 503。对齐 Flask：`except AccountClientError: rollback; raise`
    if (e instanceof AccountServiceError) {
      console.warn(
        `[checkin-service] 账户服务翻牌同步失败，fortune_value 已复原为 NULL，` +
          `用户可重选牌（user=${userId} date=${today}）: ${e.message}`
      );
      throw e;
    }
    // 兜底：意外异常也按 fail-closed 处理，包装成 503（对齐 Flask 的兜底分支）。
    // 注意别把它吞成「翻牌成功」——本地已复原，静默成功会让用户以为拿到运势了。
    console.error(`[checkin-service] 翻牌异常（user=${userId} date=${today}）:`, e);
    throw new AccountServiceError(`账户服务暂不可用，签到失败: ${String(e)}`, 503);
  }

  const balances = await readBalances(userId);
  return {
    ok: true,
    alreadyClaimed: false,
    fortuneValue,
    pool,
    ...balances,
  };
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Prisma.PrismaClientKnownRequestError).code === 'P2002'
  );
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarPath: string | null;
  value: number; // count 榜为天数，fortune 榜为总运势
}

/** 签到天数榜（对齐 get_leaderboard）。 */
export async function getCountLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  // 排序键对齐 Flask get_leaderboard：
  //   ORDER BY count(id) DESC, max(created_at) ASC  —— 天数并列时「先签到的人」排前。
  // 只按 count 排的话，并列 + limit 截断时谁上榜由 SQLite 决定，没有确定性。
  const grouped = await prisma.dailyCheckIn.groupBy({
    by: ['userId'],
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: [{ _count: { id: 'desc' } }, { _max: { createdAt: 'asc' } }],
    take: limit,
  });
  if (grouped.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.userId) } },
    select: { id: true, username: true, avatarPath: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));

  const entries: LeaderboardEntry[] = [];
  let rank = 0;
  for (const g of grouped) {
    const u = map.get(g.userId);
    if (!u) continue;
    rank += 1;
    entries.push({
      rank,
      userId: u.id,
      username: u.username,
      avatarPath: u.avatarPath,
      value: g._count.id,
    });
  }
  return entries;
}

/** 运势榜：按 totalFortune 降序（对齐 get_fortune_leaderboard）。 */
export async function getFortuneLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const users = await prisma.user.findMany({
    where: { totalFortune: { gt: 0 } },
    orderBy: { totalFortune: 'desc' },
    take: limit,
    select: { id: true, username: true, avatarPath: true, totalFortune: true },
  });
  return users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    username: u.username,
    avatarPath: u.avatarPath,
    value: u.totalFortune,
  }));
}
