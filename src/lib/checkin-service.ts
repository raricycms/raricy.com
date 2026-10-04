// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑
//
// 【一步式：签到即到账】checkIn() 在**一个 SQLite 事务**里做两件事：建当日记录、
//   发 CHECKIN_REWARD_FISH 条鱼干并写流水（走 addFish → postEntry，唯一记账内核）。
//   成功即「今天签到了、鱼干也到手了」—— 没有中间态。
//
// 【2026-09 之前是两步式（签到 → 由用户的选择决定拿多少），已合并成一步】
//   两步换来的是一个「已签到、未领奖」的中间态：它按 UTC+8 当天查记录，跨过午夜就
//   作废（用户白签一天），库里因此会攒下需要补偿脚本兜底的行。奖励改成固定值之后，
//   「选择决定拿多少」不再有任何意义，中间态的成本却一分不少 —— 所以合并回一步。
//   ⚠️ 别把它再拆开：拆开就要重新引入上面那一串失败模式。
//
// 【发鱼干：一个事务，没有补偿】建记录 + 余额 + 流水在同一个事务里提交（纯 DB 写入，
//   写锁只持有毫秒级）。账目与业务数据在同一个库里，原子性由事务本身给出 ——
//   要么全生效、要么全不生效，不存在「本地记了、别处没记」的中间态，因此也没有任何
//   回退/复原代码。⚠️ 失败时事务整体回滚，用户重按一次即可 —— 这是回滚**自然给出**的
//   状态，别为了「回到可再签态」再写一遍复原语句（那只会与事务的回滚打架）。
//
// 【幂等靠库内状态，不靠幂等键】签到天然幂等：唯一约束 (userId, checkinDate) 只在
//   第一次建得成行，冲突（P2002）就是「今天已签到」—— 而那一笔鱼干是连同它自己那一行
//   一起提交的，冲突即意味着它早就到账了，不会被重复发第二次。故本路径**不登记幂等
//   记录**（`account_sync_ledger`）—— 那类记录是给「键由调用方给定、重放必须回报原
//   结果」的操作用的，判据见 fish-idempotency.ts 头部。
//
// checkinDate 存储：UTC+8 当天的“零点 UTC”ISO 值（如 2026-07-15T00:00:00.000Z），
//   与规整后 dev.db 中既有行的存储格式一致，保证唯一约束 (userId, checkinDate) 生效。
//
// 【前置条件：发布过至少一篇未软删的文章】2026-10 起，core+ 之外再加一道 ——
//   本人名下要有 `Blog.ignore = false` 的行。软删就是 `ignore = true`（见 blog-service
//   头部），所以**把文章全删光 = 没发过**：判据只看此刻有没有活着的文章，不看历史。
//   · 【为什么加】把批量小号的成本抬起来：一个只签到、从不产出的号连门都进不去。
//     它与「非核心账号没有鱼干赚取渠道」是同一条地基的延伸 —— 鱼干是 core+ 体系的
//     报酬，报酬该对应产出。
//   · 【它是门槛，不是墙】发一篇就能过，拦的是「注册完立刻签到」的脚本，不是决心要刷
//     的人。别指望这一条兜底 —— 能不能凭空造 core 号是另一处的事，见
//     api/admin/users/route.ts 头部。
//   · 【在哪判】与档位同款：**页面与两个方法各自判**（见 docs/architecture.md §8）。
//     checkIn() 是纯发鱼内核，不重复判 —— 与 core 档位一样，那道门不在服务层里。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, todayStr } from './db-time';
import { addFish, getTodayCheckinFish } from './fish-service';
import { unitsToFish } from './fish-units';
import { frameUrlFor } from './frame-service';
import type { Prisma } from '@prisma/client';

/** 每日签到的固定奖励（鱼干）。页面文案与流水描述都跟着它走。 */
export const CHECKIN_REWARD_FISH = 3;

/**
 * 写进流水的那句描述。
 * **与 prisma/migrations/25_rewrite_checkin_descriptions 改写存量行的目标值逐字一致**
 * —— 同一批流水不该长出两种样子。
 */
const CHECKIN_DESCRIPTION = '每日签到';

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

export interface CheckinStatus {
  checkedIn: boolean;
  /**
   * 前置条件是否满足：本人名下有没有**未软删**的文章（见文件头）。
   * false 时签到会被拒（POST 403 / 页面渲染引导态）—— 它与 checkedIn 是两件事：
   * checkedIn 说「今天签过没」，canCheckIn 说「够不够格签」。
   */
  canCheckIn: boolean;
  totalCount: number;
  today: string;
  /** 签一次给多少（常量，随接口下发，前端与机器人都不用猜）。 */
  rewardFish: number;
  /** **今天已经到手**的签到鱼干（读流水；没签到或没到账 = 0）。 */
  todayFish: number;
  driedFish: number;
}

/**
 * 签到的前置条件：本人名下有没有**至少一篇未软删的文章**。
 * 软删 = `Blog.ignore = true`（schema 里叫 ignore，是文章域的软删标志，见 blog-service
 * 头部）—— 删掉的不算，所以「全删光」等于「没发过」。
 *
 * 与档位判定一样，这是**给页面与路由用的**：checkIn() 不调用它（理由见文件头）。
 */
export async function hasPublishedBlog(userId: string): Promise<boolean> {
  const n = await prisma.blog.count({ where: { authorId: userId, ignore: false } });
  return n > 0;
}

/** 今日签到状态 + 累计天数 + 余额。 */
export async function getTodayStatus(userId: string): Promise<CheckinStatus> {
  const today = todayUtc8();

  const [record, totalCount, user, todayFish, canCheckIn] = await Promise.all([
    prisma.dailyCheckIn.findUnique({
      where: { uq_user_checkin_date: { userId, checkinDate: dateAtDay(today) } },
      select: { id: true },
    }),
    prisma.dailyCheckIn.count({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } }),
    // 今日到手多少**读流水**，不按常量推算：奖励将来若改，今天已签的人仍显示真实数目。
    getTodayCheckinFish(userId),
    hasPublishedBlog(userId),
  ]);

  return {
    checkedIn: record !== null,
    canCheckIn,
    totalCount,
    today,
    rewardFish: CHECKIN_REWARD_FISH,
    todayFish,
    driedFish: unitsToFish(user?.driedFish ?? 0),
  };
}

export type CheckinResult =
  | { alreadyChecked: true; message: string; status: CheckinStatus }
  | {
      alreadyChecked: false;
      totalCount: number;
      rewardFish: number;
      todayFish: number;
      driedFish: number;
    };

/**
 * 签到：建当日记录 + 发 CHECKIN_REWARD_FISH 条鱼干（一个事务，见文件头）。
 * 唯一约束 (userId, checkinDate) 保证一天一次；命中冲突 → 「今天已签到」，一分不再发。
 */
export async function checkIn(userId: string): Promise<CheckinResult> {
  const today = todayUtc8();
  const checkinDate = dateAtDay(today);

  try {
    await prisma.$transaction(async (tx) => {
      // createdAt 必须显式写：schema 里是 DateTime? 且无 @default(now())，
      // 而真实库 2170 行全部有值（历史上由默认值兜住）。
      // 漏写会让排行榜的次级排序键（max(created_at) asc）失效。
      await tx.dailyCheckIn.create({
        data: { userId, checkinDate, createdAt: nowForDb() },
        select: { id: true },
      });

      // 发鱼干 + 写流水，与建行同事务 —— 「签到」与「到账」是一件事的两面。
      await addFish(tx, {
        userId,
        amount: CHECKIN_REWARD_FISH,
        type: 'checkin',
        description: CHECKIN_DESCRIPTION,
      });
    });
  } catch (e) {
    // 唯一约束冲突 → 今天已签到（并发/重复提交，本地事务已整体回滚：这一次没建行、
    // 也没发鱼，用户的钱包与账本一毫未动）。
    if (isUniqueViolation(e)) {
      const status = await getTodayStatus(userId);
      return { alreadyChecked: true, message: '今天已签到', status };
    }
    throw e;
  }

  const [totalCount, driedFish] = await Promise.all([
    prisma.dailyCheckIn.count({ where: { userId } }),
    readFishBalance(userId),
  ]);
  return {
    alreadyChecked: false,
    totalCount,
    rewardFish: CHECKIN_REWARD_FISH,
    // 刚写完的那笔就是今天的签到鱼 —— 不必再读一次流水。
    todayFish: CHECKIN_REWARD_FISH,
    driedFish,
  };
}

/** 读用户余额（鱼干存储单位 → 鱼干）。 */
async function readFishBalance(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { driedFish: true },
  });
  return unitsToFish(u?.driedFish ?? 0);
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
