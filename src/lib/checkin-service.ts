// ─────────────────────────────────────────────────────────────────────────────
// checkin-service.ts — 每日签到业务逻辑
//
// 【一步式】checkIn() 在一个 SQLite 事务里建当日记录、发 CHECKIN_REWARD_FISH 鱼干并
//   写流水（走 addFish → postEntry 记账内核）。成功即「今天签到了、鱼干也到手了」，
//   没有中间态；失败时事务整体回滚，用户重按一次即可。
//
// 【每日唯一】唯一约束 (userId, checkinDate) 只在第一次建得成行，冲突（P2002）就是
//   「今天已签到」—— 那笔鱼干与那一行同事务提交，因此不会重复发放。本路径**不登记
//   幂等键**：幂等记录是给「键由调用方给定、重放必须回报原结果」的操作用的（判据见
//   fish-idempotency.ts 头部）。日期语义与范围见 db-time.ts。
//
// 【前置条件：本人名下有未软删文章】soft delete 即 `Blog.ignore = true`，所以判据是
//   「此刻有没有活着的文章」，不看历史。**这条门不在服务层**：签到页面与
//   POST /api/checkin 各自校验，一言服务在事务内复核；checkIn() 是纯发鱼内核
//   （与 core 档位同理，见 docs/architecture.md §8）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { dayStart, nowForDb, todayStr } from './db-time';
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
 * 直接再导出 db-time 的 todayStr()：同一个「本站时钟」只有一处实现，别再手写
 * Date.now()+8h。（历史调用方/测试从本文件 import 这个名字，保留导出不断链。）
 */
export const todayUtc8 = todayStr;

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
 * 签到页面与路由校验它，一言服务也在事务内复核；checkIn() 不调用它（理由见文件头）。
 */
export async function hasPublishedBlog(userId: string, client: Pick<Prisma.TransactionClient, 'blog'> = prisma): Promise<boolean> {
  const n = await client.blog.count({ where: { authorId: userId, ignore: false } });
  return n > 0;
}

/** 今日签到状态 + 累计天数 + 余额。 */
export async function getTodayStatus(userId: string): Promise<CheckinStatus> {
  const today = todayUtc8();

  const [record, totalCount, user, todayFish, canCheckIn] = await Promise.all([
    prisma.dailyCheckIn.findUnique({
      where: { uq_user_checkin_date: { userId, checkinDate: dayStart(today) } },
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
  const key = JSON.stringify([userId, today]);
  const pending = checkinState.__checkinPending.get(key);
  if (pending) {
    await pending;
    const status = await getTodayStatus(userId);
    return { alreadyChecked: true, message: '今天已签到', status };
  }
  const operation = commitCheckin(userId, today);
  checkinState.__checkinPending.set(key, operation);
  try {
    return await operation;
  } finally {
    checkinState.__checkinPending.delete(key);
  }
}

// 只合并同用户同日的在途写入；失败原样传播并释放，数据库唯一约束仍是最终防线。
// 存在 globalThis 上，以免热更新留下另一组没有参与合并的模块实例。
const checkinState = globalThis as unknown as { __checkinPending: Map<string, Promise<CheckinResult>> };
checkinState.__checkinPending ??= new Map();

async function commitCheckin(userId: string, today: string): Promise<CheckinResult> {
  const checkinDate = dayStart(today);

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
