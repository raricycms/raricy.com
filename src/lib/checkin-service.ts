// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑（对齐 Flask app/service/checkin.py）
//
// 与 Flask 侧的差异（本次迁移切片有意简化）：
//   Flask 是两步流程：check_in() 先建记录（fortune_value=NULL），再由
//   claim_fortune() 让用户翻牌赋值。本切片合并为一步：POST /api/checkin 直接
//   建记录 + 抽运势 + 发鱼干 + 累加 totalFortune，body 可带 chosenIndex（0-4）
//   指定翻哪张牌，缺省则随机翻一张。
//
// 发鱼干走 fail-closed 与账户微服务同步（本地事务先提交 + 账本登记，提交后调远端，
//   远端失败则补偿回滚本地 + 503）—— 对齐 Flask claim_fortune 的最终语义。
//   机制详见 src/lib/fish-sync.ts。见 doCheckin()。
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

  return {
    checkedIn: record !== null,
    totalCount,
    today,
    fortuneValue: record?.fortuneValue ?? null,
    fortunePool: record ? parsePool(record.fortunePool) : null,
    totalFortune: user?.totalFortune ?? 0,
    driedFish: unitsToFish(user?.driedFish ?? 0),
  };
}

/** 指定了非法的 chosenIndex（对齐 Flask claim_fortune 的「无效的选择」）。 */
export interface CheckinInvalidChoice {
  invalidChoice: true;
  alreadyChecked: false;
  message: string;
}

export type CheckinResult =
  | { alreadyChecked: true; invalidChoice?: false; message: string; status: CheckinStatus }
  | CheckinInvalidChoice
  | {
      alreadyChecked: false;
      invalidChoice?: false;
      fortuneValue: number;
      pool: number[];
      chosenIndex: number;
      totalFortune: number;
      driedFish: number;
      totalCount: number;
    };

/** 类型守卫：结果是否为「无效的选择」。 */
export function isInvalidChoice(r: CheckinResult): r is CheckinInvalidChoice {
  return 'invalidChoice' in r && r.invalidChoice === true;
}

/**
 * 执行一次签到（合并版）：建记录 → 抽运势 → 发鱼干 → 累加 totalFortune。
 * 唯一约束 (userId, checkinDate) 保证一天一次；命中冲突 → 返回“今天已签到”。
 *
 * @param chosenIndex 可选，0-4 指定翻哪张牌；缺省或越界则随机翻一张。
 */
export async function doCheckin(userId: string, chosenIndex?: number): Promise<CheckinResult> {
  const today = todayUtc8();
  const checkinDate = dateAtDay(today);
  const pool = shuffledPool();
  const poolArr = parsePool(pool)!; // 刚生成，必合法

  // 抽牌：未指定 → 随机；指定了就必须合法。
  //
  // 【为什么越界要报错而不是静默随机】对齐 Flask claim_fortune 的
  // `{'success': False, 'message': '无效的选择'}`。用户传了 index 说明他想选某张牌，
  // 若静默换成随机牌，他拿到的不是自己选的，而且唯一约束已锁死当天、无法重来。
  // NaN 尤其隐蔽：`NaN >= 0` 为 false 会落进随机分支 —— 前端一个 parseInt 失败
  // 就变成开盲盒。故此处显式校验。
  let idx: number;
  if (chosenIndex == null) {
    idx = Math.floor(Math.random() * poolArr.length);
  } else if (
    !Number.isInteger(chosenIndex) ||
    chosenIndex < 0 ||
    chosenIndex >= poolArr.length
  ) {
    return { invalidChoice: true, alreadyChecked: false, message: '无效的选择' };
  } else {
    idx = chosenIndex;
  }
  const fortuneValue = poolArr[idx];

  // 远端同步是否启用（未配置 internal token → 开发模式）。
  // 未配置：生产 fail-closed（不做任何本地写入直接拒绝）；dev 仅本地 + 告警。
  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('签到');
    console.warn(
      `[checkin-service] ACCOUNT_SERVICE 未配置，签到仅写本地库（dev fallback）。user=${userId}`
    );
  }

  // 远端幂等键（与旧版完全一致，重复提交不会重复发放）。
  const idempotencyKey = `checkin-${userId}-${today}`;
  const description = `每日签到（运势值 ${fortuneValue}）`;

  try {
    // ── Phase 1：本地事务（纯 DB，无远端 IO —— 写锁只持有毫秒级）────────────────
    //   DailyCheckIn + User.totalFortune + driedFish + FishTransaction + 账本行 pending
    //   全部原子提交；远端同步在事务外进行（机制详见 src/lib/fish-sync.ts）。
    const phase1 = await prisma.$transaction(async (tx) => {
      // 唯一约束会在此拦截重复签到（并发/重复提交）→ 抛 P2002
      const record = await tx.dailyCheckIn.create({
        // createdAt 必须显式写：schema 里是 DateTime? 且无 @default(now())，
        // 而 Flask 模型是 default=datetime.now（真实库 2170 行全部有值）。
        // 漏写会让排行榜的次级排序键（max(created_at) asc）失效。
        data: { userId, checkinDate, fortuneValue, fortunePool: pool, createdAt: nowForDb() },
        select: { id: true },
      });

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
        description,
      });

      // 账本登记 pending（远端启用时）
      if (remoteEnabled) {
        await recordPendingSync(tx, {
          idempotencyKey,
          operation: 'checkin',
          payload: {
            toUserId: userId,
            amount: fortuneValue,
            description,
            date: today,
            fortuneValue,
          },
        });
      }

      return { fishTxId: fish.txId };
    });

    // ── Phase 2：事务外远端同步（系统账户 → 用户；提交后调用，失败走补偿）────────
    // 对齐 Flask claim_fortune：幂等键 checkin-{userId}-{date} 保证重复提交不重复发放。
    if (remoteEnabled) {
      const entry = {
        idempotencyKey,
        operation: 'checkin' as const,
        payload: {
          toUserId: userId,
          amount: fortuneValue,
          description,
          date: today,
          fortuneValue,
        },
      };
      try {
        await executeSync(entry);
        await settleSync(idempotencyKey, 'synced');
      } catch (syncErr) {
        // ── Phase 3：远端失败 → 补偿事务精确撤销本地写入（对用户仍等价于回滚）──
        //   删签到记录（唯一约束释放 → 用户当天可重试）+ 回退运势与鱼干 + 删流水 + 删账本行。
        try {
          await prisma.$transaction(async (tx) => {
            await tx.dailyCheckIn.delete({
              where: { uq_user_checkin_date: { userId, checkinDate } },
            });
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
            // 删除账本行：释放幂等键，用户重试时可以重建（无痕失败）
            await tx.accountSyncLedger.deleteMany({ where: { idempotencyKey } });
          });
        } catch (undoErr) {
          // 补偿也失败：账本行留 pending/failed，sync-retry 可幂等重放收敛。
          await settleSync(idempotencyKey, 'failed', String(undoErr)).catch(() => {
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
    // 唯一约束冲突 → 今天已签到（并发/重复提交，本地事务已回滚/已补偿）
    if (isUniqueViolation(e)) {
      const status = await getTodayStatus(userId);
      return { alreadyChecked: true, message: '今天已签到', status };
    }
    // 远端失败：本地写入已被补偿（等价于回滚），向上抛让路由返回 503。
    // 对齐 Flask：`except AccountClientError: db.session.rollback(); raise`
    if (e instanceof AccountServiceError) {
      console.warn(
        `[checkin-service] 账户服务签到同步失败，本地写入已补偿回滚（user=${userId} date=${today}）: ${e.message}`
      );
      throw e;
    }
    // 兜底：意外异常也按 fail-closed 处理，包装成 503（对齐 Flask 的兜底分支）。
    // 注意别把它吞成「签到成功」——本地已补偿，静默成功会让用户以为签到了。
    console.error(`[checkin-service] 签到异常（user=${userId} date=${today}）:`, e);
    throw new AccountServiceError(`账户服务暂不可用，签到失败: ${String(e)}`, 503);
  }

  const [totalCount, user] = await Promise.all([
    prisma.dailyCheckIn.count({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { totalFortune: true, driedFish: true },
    }),
  ]);

  return {
    alreadyChecked: false,
    fortuneValue,
    pool: poolArr,
    chosenIndex: idx,
    totalFortune: user?.totalFortune ?? 0,
    driedFish: unitsToFish(user?.driedFish ?? 0),
    totalCount,
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
