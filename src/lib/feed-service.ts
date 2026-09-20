// ─────────────────────────────────────────────────────────────────────────────
// feed-service.ts — 文章投喂小鱼干
//
// 【模型】投喂者付全额，作者获 80% 分成；单用户对单篇累计上限 5。
//   另外那 20% **由系统回收、不落任何人的账** —— 本地没有系统账户行，别为了
//   「配平」给谁补一笔。这是刻意的，不是漏写。
//
// 【写路径】扣投喂者 + 加作者分成 + BlogFeed 累计 + Blog.fishCount 累加 + 两条流水，
//   **全部在一个 SQLite 事务里提交**：要么都成、要么都不成，没有中间态，
//   因此也没有补偿事务、没有账本登记（见 docs/architecture.md §6.3.1 的历史注记 ——
//   账户微服务曾在站外，那时一次投喂得拆成「投喂者 → 系统 → 作者」两跳，
//   第二跳或事后退款再失败，就会留下只能人工对账的残局）。
//
// 【幂等】投喂**不登记幂等记录**：一次投喂就是一笔新交易，不存在「同一个键重发
//   应当等价于没跑」的调用方，键本身也带随机后缀（判据见 fish-idempotency.ts 头部）。
//   真正挡住重复投喂的不是去重，而是「单篇每人累计 ≤ 5」这个额度。
//
// 【故障语义】没有远端了：本地事务失败就是真故障，如实上抛 → 路由 500。
//   余额不足与累计超限是**业务结果**（400），不是故障。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { sendNotification } from './notification-service';

const FEED_CAP = 5; // 单用户对单篇文章累计投喂上限

export interface FeedResult {
  ok: true;
  fedTotal: number;
  remaining: number;
  fishCount: number;
  balance: number;
  authorIncome: number;
}

export interface FeedError {
  ok: false;
  code: number; // 400 / 404
  message: string;
}

/** 查询用户对某文章的投喂状态（是否已投 + 累计投喂量 + 上限）。 */
export async function getFeedStatus(
  blogId: string,
  userId: string
): Promise<{ fed: number; remaining: number; isFull: boolean }> {
  const feed = await prisma.blogFeed.findUnique({
    where: { uq_blog_feed_user: { blogId, userId } },
    select: { amount: true },
  });
  const fed = feed ? unitsToFish(feed.amount) : 0;
  return { fed, remaining: Math.max(0, FEED_CAP - fed), isFull: fed >= FEED_CAP };
}

export interface FeederRow {
  user_id: string;
  username: string;
  avatar_path: string | null;
  amount: number;
}

/**
 * 投喂者列表。
 *
 * 排序按投喂量倒序（不是时间）—— 这个列表给作者看「谁投得最多」。
 * 字段名用 snake_case 是因为前端 FeedButton 直接消费该形状，别改成 camelCase。
 */
export async function getFeeders(
  blogId: string,
  offset = 0,
  limit = 50
): Promise<{ feeders: FeederRow[]; total: number; offset: number; limit: number }> {
  const lim = Math.max(1, Math.min(limit, 200));
  const off = Math.max(0, offset);

  const [total, feeds] = await Promise.all([
    prisma.blogFeed.count({ where: { blogId } }),
    prisma.blogFeed.findMany({
      where: { blogId },
      orderBy: { amount: 'desc' },
      skip: off,
      take: lim,
      select: { userId: true, amount: true },
    }),
  ]);

  const users = feeds.length
    ? await prisma.user.findMany({
        where: { id: { in: feeds.map((f) => f.userId) } },
        select: { id: true, username: true, avatarPath: true },
      })
    : [];
  const map = new Map(users.map((u) => [u.id, u]));

  return {
    feeders: feeds.map((f) => {
      const u = map.get(f.userId);
      return {
        user_id: f.userId,
        username: u?.username ?? '未知',
        avatar_path: u?.avatarPath ?? null,
        amount: unitsToFish(f.amount),
      };
    }),
    total,
    offset: off,
    limit: lim,
  };
}

/**
 * 用户投喂小鱼干给文章。作者收到 80%（另外 20% 由系统回收，不落任何人的账）。
 *
 * 余额、两条流水、BlogFeed、Blog.fishCount 全在**一个事务**里 —— 任一步失败
 * （余额不足 / 累计超限 / 写库报错）都整笔回滚，不存在「扣了投喂者、作者没收到」
 * 这类中间态，也就不需要任何事后撤销。
 *
 * @returns 业务结果。**不抛故障类异常** —— 没有远端了，本地事务要么成要么不成。
 */
export async function feedBlog(
  blogId: string,
  userId: string,
  amount: number
): Promise<FeedResult | FeedError> {
  // 1. 入参校验：整数 1~5。
  if (!Number.isInteger(amount) || amount <= 0 || amount > FEED_CAP) {
    return { ok: false, code: 400, message: '投喂数量需为 1~5 的整数' };
  }

  // 2. 文章存在性（软删除排除）。
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: { id: true, title: true, authorId: true, ignore: true },
  });
  if (!blog || blog.ignore) {
    return { ok: false, code: 404, message: '文章不存在' };
  }

  // 3. 投喂者存在性。只为一条准确的文案：「库里没有这个人」与「余额不够」在内核眼里
  //    都是条件写的 count=0，不先判就会把前者报成「小鱼干不足」。
  const feeder = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!feeder) {
    return { ok: false, code: 404, message: '用户不存在' };
  }

  const authorIncome = Math.round(amount * 0.8 * 10) / 10; // 保留 1 位小数

  // 业务错误容器：事务回调里抛出后在外层转成 FeedError（不当作 500）。
  class FeedBusinessError extends Error {
    constructor(
      public code: number,
      message: string
    ) {
      super(message);
    }
  }

  try {
    // ── 一个事务：扣投喂者、加作者分成、BlogFeed 累计、Blog.fishCount 累加 ────────
    const applied = await prisma.$transaction(async (tx) => {
      // 金额换算：业务单位（鱼干）→ 存储单位（0.1 鱼干，见 fish-units.ts）。
      const units = fishToUnits(amount);

      // 1.1 投喂者出账（走内核：单条带谓词的 UPDATE 扣减 + 一条负数流水）。
      //     余额不足由内核抛 InsufficientFishError，外层转成 400 业务结果。
      await postEntry(tx, {
        userId,
        units: -units,
        type: 'feed',
        description: `投喂文章「${blog.title}」`,
        referenceType: 'blog',
        referenceId: blogId,
        relatedUserId: blog.authorId,
      });

      // 1.2 作者收入 80%（走内核：加余额 + 一条 feed_receive 流水）。
      //     另外 20% **不落任何人的账** —— 系统回收不由一行流水表达，
      //     别为了「配平」给谁补一笔。
      await postEntry(tx, {
        userId: blog.authorId,
        units: fishToUnits(authorIncome),
        type: 'feed_receive',
        description: `文章「${blog.title}」被投喂`,
        referenceType: 'blog',
        referenceId: blogId,
        relatedUserId: userId,
      });

      // 1.3 累计投喂量：更新或创建 BlogFeed，强制单篇累计 ≤ 5。
      //
      // ⚠️ 这里是「读 → 判断 → 写」，**不是原子表达式**。当前之所以成立，是因为
      // SQLite 的写锁把并发事务串行化了（已用并发用例实测：同篇并发投喂不破 5）。
      // **迁到 Postgres/MySQL 后此处会失效** ——
      // READ COMMITTED 下两个事务可能同时读到 amount=3、各自 +2，结果 7 > 5。
      // 届时应改为原子条件写，例如：
      //   UPDATE blog_feeds SET amount = amount + ?
      //    WHERE blog_id = ? AND user_id = ? AND amount + ? <= 5
      // 再按受影响行数判定（0 行 = 超限），与扣鱼干的 updateMany(gte) 同一套路。
      const existing = await tx.blogFeed.findUnique({
        where: { uq_blog_feed_user: { blogId, userId } },
        select: { amount: true },
      });
      // BlogFeed.amount 是存储单位，换成鱼干后再与上限比（上限是鱼干口径的整数）。
      const priorAmount = existing ? unitsToFish(existing.amount) : 0;
      if (priorAmount + amount > FEED_CAP) {
        throw new FeedBusinessError(400, '投喂已满（单篇文章每人最多投喂 5 条）');
      }
      if (existing) {
        await tx.blogFeed.update({
          where: { uq_blog_feed_user: { blogId, userId } },
          data: { amount: { increment: units }, updatedAt: nowForDb() },
        });
      } else {
        await tx.blogFeed.create({
          data: { blogId, userId, amount: units, createdAt: nowForDb(), updatedAt: nowForDb() },
        });
      }

      // 1.4 累计文章投喂总量。
      //     ⚠️ fishCount 是**鱼干口径**的整数列，不参与 fish-units 的换算
      //     （见 fish-units.ts 头部那条唯一的例外）—— 别为了「统一」把它也 ×10。
      await tx.blog.update({
        where: { id: blogId },
        data: { fishCount: { increment: amount } },
      });

      // 读回事务内的最新值（仍在事务中，故为本事务可见的最新状态）。
      const [feedRow, blogRow, feederRow] = await Promise.all([
        tx.blogFeed.findUnique({
          where: { uq_blog_feed_user: { blogId, userId } },
          select: { amount: true },
        }),
        tx.blog.findUnique({ where: { id: blogId }, select: { fishCount: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { driedFish: true } }),
      ]);

      const fedTotal = feedRow ? unitsToFish(feedRow.amount) : amount;
      return {
        fedTotal,
        remaining: Math.max(0, FEED_CAP - fedTotal),
        fishCount: blogRow?.fishCount ?? 0,
        balance: feederRow ? unitsToFish(feederRow.driedFish) : 0,
        authorIncome,
      };
    });

    // 通知文章作者（自投喂不通知；**在事务提交之后**发，
    // 且通知失败不影响已成功的投喂 —— 钱已经记完了，不能因为发通知失败而退回）。
    if (userId !== blog.authorId) {
      try {
        await sendNotification({
          recipientId: blog.authorId,
          action: '文章投喂',
          actorId: userId,
          objectType: 'blog',
          objectId: blogId,
          detail: `你的文章《${blog.title}》收到了 ${amount} 条小鱼干投喂！`,
        });
      } catch (notifyErr) {
        console.warn(
          `[feed-service] 投喂成功但通知作者失败（不影响投喂结果）` +
            `（blog=${blogId} author=${blog.authorId}）:`,
          notifyErr
        );
      }
    }

    return {
      ok: true,
      fedTotal: applied.fedTotal,
      remaining: applied.remaining,
      fishCount: applied.fishCount,
      balance: applied.balance,
      authorIncome: applied.authorIncome,
    };
  } catch (e) {
    if (e instanceof FeedBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
    if (e instanceof InsufficientFishError) {
      // 余额不足是**业务结果**，不是故障 —— 内核在事务里抛出时，整笔投喂已整体回滚。
      return { ok: false, code: 400, message: '小鱼干不足' };
    }
    // 兜底：意外异常如实上抛（→ 路由 500）。没有远端了，本地事务失败就是真故障，
    // 包装成「稍后重试即可」的 503 是在骗调用方。
    console.error(
      `[feed-service] 投喂异常（user=${userId} blog=${blogId} amount=${amount}）:`,
      e
    );
    throw e;
  }
}
