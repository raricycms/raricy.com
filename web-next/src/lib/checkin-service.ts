// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑（对齐 Flask app/service/checkin.py）
//
// 与 Flask 侧的差异（本次迁移切片有意简化）：
//   Flask 是两步流程：check_in() 先建记录（fortune_value=NULL），再由
//   claim_fortune() 让用户翻牌赋值。本切片合并为一步：POST /api/checkin 直接
//   建记录 + 抽运势 + 发鱼干 + 累加 totalFortune，body 可带 chosenIndex（0-4）
//   指定翻哪张牌，缺省则随机翻一张。
//
// ⚠️ 生产上线注意：发鱼干这一步必须与账户微服务做 fail-closed 同步
//   （远端 transfer 成功后才 commit 本地事务，远端失败则整体回滚）。
//   本切片只写本地 DB —— 见 doCheckin() 内的醒目注释。
//
// checkinDate 存储：UTC+8 当天的“零点 UTC”ISO 值（如 2026-07-15T00:00:00.000Z），
//   与规整后 dev.db 中既有行的存储格式一致，保证唯一约束 (userId, checkinDate) 生效。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
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
    driedFish: user?.driedFish ?? 0,
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

  try {
    // ⚠️ 生产 fail-closed 提醒：以下本地写入（DailyCheckIn + User.totalFortune +
    //   driedFish + FishTransaction）在正式环境必须先向账户微服务发起 transfer，
    //   远端成功后才 commit 本地事务；远端失败则整体回滚并向用户返回 503。
    //   本迁移切片仅写本地 DB，未接入账户服务。
    await prisma.$transaction(async (tx) => {
      // 唯一约束会在此拦截重复签到（并发/重复提交）→ 抛 P2002
      await tx.dailyCheckIn.create({
        // createdAt 必须显式写：schema 里是 DateTime? 且无 @default(now())，
        // 而 Flask 模型是 default=datetime.now（真实库 2170 行全部有值）。
        // 漏写会让排行榜的次级排序键（max(created_at) asc）失效。
        data: { userId, checkinDate, fortuneValue, fortunePool: pool, createdAt: nowForDb() },
      });

      // 累加 totalFortune
      await tx.user.update({
        where: { id: userId },
        data: { totalFortune: { increment: fortuneValue } },
      });

      // 发鱼干 + 写流水（仅本地，见上方 fail-closed 提醒）
      await addFish(tx, {
        userId,
        amount: fortuneValue,
        type: 'checkin',
        description: `每日签到（运势值 ${fortuneValue}）`,
      });
    });
  } catch (e) {
    // 唯一约束冲突 → 今天已签到
    if (isUniqueViolation(e)) {
      const status = await getTodayStatus(userId);
      return { alreadyChecked: true, message: '今天已签到', status };
    }
    throw e;
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
    driedFish: user?.driedFish ?? 0,
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
