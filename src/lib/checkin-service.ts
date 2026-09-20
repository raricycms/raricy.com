// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑
//
// 【两步式：签到 → 翻牌定命】（两步是刻意的，别合并成一步）
//   1. checkIn()：只建当日记录 —— fortune_value 留 NULL、fortune_pool 洗好落库。
//      不发鱼、不累加 totalFortune。成功即「已签到、待翻牌」。
//   2. claimFortune()：用户点选一张牌（chosenIndex 0-4）—— 服务端从**签到当时
//      落库的那副牌**里取 pool[chosenIndex] 赋值。此刻才：发鱼干 + 累加
//      totalFortune。翻哪张、拿哪个值，在翻牌这一瞬间由用户的选择决定 ——
//      而非签到瞬间抽定后由前端「演」出来。
//
// 【为什么恢复两步】概率上两种设计等价（池均匀、每值 1/5），但语义不同：
//   合并版在签到瞬间抽定值，翻牌只是把既定值交换到被点的牌上做动画；
//   两步式里「灵性/直觉选牌」真正决定了结果。
//
// 【发鱼干：一个事务，没有补偿】置 fortune_value + 累加 totalFortune + 发鱼干 +
//   写流水在**同一个 SQLite 事务**里提交（纯 DB 写入，写锁只持有毫秒级）。
//   账目与业务数据在同一个库里，原子性由事务本身给出 —— 要么全生效、要么全不
//   生效，不存在「本地记了、别处没记」的中间态，因此也没有任何回退/复原代码。
//   ⚠️ 失败时事务整体回滚，签到行原样留在「已签到、fortune_value IS NULL」，
//   用户重选一张牌即可 —— 这个状态是回滚**自然给出**的，别为了「回到待翻牌态」
//   再写一遍复原语句（那只会与事务的回滚打架）。
//
// 【幂等靠库内状态，不靠幂等键】claim 是唯一发钱点，而它天然幂等：
//   · 并发翻牌 → 「UPDATE … WHERE fortune_value IS NULL」的 rowcount 只有一个人赢；
//   · 已翻过 → 事务前读到 fortune_value != null，幂等回报现值（一分钱不再发）。
//   故本路径**不登记幂等记录**（`account_sync_ledger`）—— 那类记录是给「键由调用方
//   给定、重放必须回报原结果」的操作用的，判据见 fish-idempotency.ts 头部。
//
// 【已知语义副作用，非 bug】跨 UTC+8 午夜窗口：用户在 23:59 签到、
//   00:00 后才点牌 → claim 按「今天」查不到记录 → 400「今天还没有签到」，
//   那张牌作废。一步式没有这个窗口 —— 这是回到两步式的固有代价。
//
// checkinDate 存储：UTC+8 当天的“零点 UTC”ISO 值（如 2026-07-15T00:00:00.000Z），
//   与规整后 dev.db 中既有行的存储格式一致，保证唯一约束 (userId, checkinDate) 生效。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, todayStr } from './db-time';
import { addFish } from './fish-service';
import { unitsToFish } from './fish-units';
import { frameUrlFor } from './frame-service';
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

/**
 * UTC+8 当天的 YYYY-MM-DD。
 * 直接委托 db-time 的 todayStr()：同一个「本站时钟」只有一处实现，别再手写 Date.now()+8h。
 */
export function todayUtc8(): string {
  return todayStr();
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

/** 今日签到状态 + 累计天数 + 余额。 */
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
 * 不发鱼、不累加运势 —— 发钱在 claimFortune()。
 */
export async function checkIn(userId: string): Promise<CheckinResult> {
  const today = todayUtc8();
  const checkinDate = dateAtDay(today);
  const pool = shuffledPool();

  try {
    // createdAt 必须显式写：schema 里是 DateTime? 且无 @default(now())，
    // 而真实库 2170 行全部有值（历史上由默认值兜住）。
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
 * totalFortune（一个事务，见文件头）。翻牌才是命运揭晓的一刻 —— 用户的选择决定结果。
 *
 * 判序（顺序不能乱，每一步都在拦一类具体错误）：
 *   ① 无当天记录 → 「今天还没有签到」；
 *   ② fortune_value 已定 → 幂等成功返回（已在①之后、index 校验之前 ——
 *      已翻过牌的用户带非法 index 再来，返回的是现值而非「无效的选择」）；
 *   ③ 牌池解析失败 → 「运势池数据异常」；
 *   ④ index 非整数/越界 → 「无效的选择」（绝不静默随机开盲盒：用户想选某张牌
 *      却拿到随机牌，且翻牌只能一次、无法重来）；
 *   ⑤ 原子 UPDATE … WHERE fortune_value IS NULL —— 并发翻牌只赢一个，
 *      rowcount==0 的输家幂等返回（原子认领，防 TOCTOU 双发鱼）。
 *
 * 失败一律如实上抛（事务已整体回滚，签到行仍是待翻牌态）—— 不包装、不吞掉：
 * 本地事务失败就是真故障，让路由回 500，别假装成「稍后重试即可」的暂态。
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
  const description = `每日签到（运势值 ${fortuneValue}）`;

  // ── 一个事务：认领牌 + 运势 + 鱼干 + 流水 ─────────────────────────────────
  // 纯 DB 写入，无外部 IO —— 写锁只持有毫秒级。任一步抛错即整体回滚，
  // 签到行回到「已签到、fortune_value IS NULL」，用户重选一张牌即可。
  const won = await prisma.$transaction(async (tx) => {
    // 原子认领：并发翻牌只有一个能拿到 count>0
    // （UPDATE … WHERE fortune_value IS NULL + rowcount 判断）
    const claim = await tx.dailyCheckIn.updateMany({
      where: { userId, checkinDate, fortuneValue: null },
      data: { fortuneValue },
    });
    if (claim.count === 0) return false;

    // 累加 totalFortune
    await tx.user.update({
      where: { id: userId },
      data: { totalFortune: { increment: fortuneValue } },
    });

    // 发鱼干 + 写流水（addFish 是「只加不减」的语义壳，内核是 postEntry）
    await addFish(tx, {
      userId,
      amount: fortuneValue,
      type: 'checkin',
      description,
    });

    return true;
  });

  if (!won) {
    // 并发输家：别人已翻 —— 事务外重读现值后幂等返回（别在事务里嵌套查询）
    const cur = await prisma.dailyCheckIn.findUniqueOrThrow({
      where: { uq_user_checkin_date: { userId, checkinDate } },
      select: { fortuneValue: true, fortunePool: true },
    });
    return idempotentResult(userId, cur);
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
  /** 头像框贴图地址；null = 没戴 / 已过期 / 素材缺失。**判定已在服务层做完**。 */
  frameUrl: string | null;
  value: number; // 累计签到天数
}

/** 签到天数榜。 */
export async function getCountLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  // 排序键：
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
    select: {
      id: true,
      username: true,
      equippedFrameKey: true,
      equippedFrameExpiresAt: true,
    },
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
      frameUrl: frameUrlFor(u),
      value: g._count.id,
    });
  }
  return entries;
}

// 【为什么没有运势榜】站内不展示任何人的运势值总和：签到页的「总运势值」、运势榜、
// 个人资料页的「运势值」三处都不再露面（站长要求）。运势值只在**当天**以「今日运势」
// 的形式出现（翻牌弹窗与签到卡，见 CheckinCard 的 fortune-color--N）—— 那个是这一把
// 翻出来的值，不是累计。
//
// totalFortune 这一列**仍在存、仍在维护**：claimFortune 里照旧累加，
// compensate-unclaimed-fortunes.mjs 也照旧补记（见各文件头）。只是不再有
// 排行榜读它 —— 别顺手把 getFortuneLeaderboard 加回来。
