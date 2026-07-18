// ─────────────────────────────────────────────────────────────────────────────
// feed-service.ts — 文章投喂小鱼干（对齐 Flask app/web/blog/services/feed_fish_service.py）
//
// 投喂模型：投喂者付全额，作者获 80% 分成；单用户对单篇累计上限 5。
//
// ★★★ 写路径 fail-closed（CLAUDE.md Phase 1.5）★★★
//   本地先在一个 Prisma 交互式事务里收集全部变更（扣投喂者 / 加作者 / BlogFeed /
//   Blog.fishCount / 两条流水），**在事务提交之前**调用账户微服务同步；
//   远端成功 → 事务提交；远端抛错 → 抛出后事务自动回滚，绝不出现
//   “本地已扣鱼干但远端没记账”的不一致。远端不可达一律以 AccountServiceError(503)
//   向上抛，路由据此返回 503（**绝不静默成功**）。
//
//   dev fallback：当 ACCOUNT_SERVICE_INTERNAL_TOKEN 未配置时，跳过远端同步、
//   仅写本地并打印告警，使该切片在无账户服务时可运行；fail-closed 结构保持不变。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import { sendNotification } from './notification-service';
import {
  accountClient,
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  decryptApiKey,
  AccountServiceError,
} from './account-client';

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

/** 查询用户对某文章的投喂状态（对齐 get_feed_status）。 */
export async function getFeedStatus(
  blogId: string,
  userId: string
): Promise<{ fed: number; remaining: number; isFull: boolean }> {
  const feed = await prisma.blogFeed.findUnique({
    where: { uq_blog_feed_user: { blogId, userId } },
    select: { amount: true },
  });
  const fed = feed?.amount ?? 0;
  return { fed, remaining: Math.max(0, FEED_CAP - fed), isFull: fed >= FEED_CAP };
}

export interface FeederRow {
  user_id: string;
  username: string;
  avatar_path: string | null;
  amount: number;
}

/**
 * 投喂者列表（对齐 Flask feed_fish_service.get_feeders）。
 *
 * 排序按投喂量倒序（不是时间）—— 与 Flask 一致：这个列表给作者看「谁投得最多」。
 * 字段名用 snake_case 是因为前端 FeedButton 直接消费该形状（对齐 Flask 的 JSON）。
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
        amount: f.amount,
      };
    }),
    total,
    offset: off,
    limit: lim,
  };
}

/**
 * 用户投喂小鱼干给文章。作者收到 80%。
 *
 * @throws AccountServiceError 远端账户服务不可达 / 同步失败（→ 路由 503）
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

  // 3. 投喂者信息（用户名 + 加密的账户 Key，用于远端同步）。
  const feeder = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, fishApiKeyEncrypted: true },
  });
  if (!feeder) {
    return { ok: false, code: 404, message: '用户不存在' };
  }

  const authorIncome = Math.round(amount * 0.8 * 10) / 10; // 保留 1 位小数

  // 远端同步是否启用（未配置 internal token → dev 本地模式）。
  const remoteEnabled = accountServiceEnabled();

  // dev 模式下也需要判断 Key 是否可解密——若启用远端则先解出投喂者 Key，
  // 解密失败即 fail-closed（在进入事务前抛出，避免脏事务）。
  let feederApiKey = '';
  if (remoteEnabled) {
    if (!feeder.fishApiKeyEncrypted) {
      throw new AccountServiceError('投喂者没有关联的账户 Key，无法完成远端结算', 503);
    }
    feederApiKey = decryptApiKey(feeder.fishApiKeyEncrypted); // 失败抛 AccountServiceError(503)
  }

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
    const result = await prisma.$transaction(
      async (tx) => {
        // ── 本地写入（全部在事务内，远端失败则整体回滚）──────────────────────

        // 3.1 原子扣减投喂者鱼干（WHERE driedFish >= amount 防超扣）。
        const dec = await tx.user.updateMany({
          where: { id: userId, driedFish: { gte: amount } },
          data: { driedFish: { decrement: amount } },
        });
        if (dec.count === 0) {
          throw new FeedBusinessError(400, '小鱼干不足');
        }
        // 投喂者支出流水（负数表示支出）。
        await tx.fishTransaction.create({
          data: {
            userId,
            amount: -amount,
            type: 'feed',
            description: `投喂文章「${blog.title}」`,
            referenceType: 'blog',
            referenceId: blogId,
            relatedUserId: blog.authorId,
          },
        });

        // 3.2 作者收入 80%（复用 addFish：加余额 + 写 feed_receive 流水）。
        await addFish(tx, {
          userId: blog.authorId,
          amount: authorIncome,
          type: 'feed_receive',
          description: `文章「${blog.title}」被投喂`,
          referenceType: 'blog',
          referenceId: blogId,
          relatedUserId: userId,
        });

        // 3.3 累计投喂量：更新或创建 BlogFeed，强制单篇累计 ≤ 5。
        //
        // ⚠️ 这里是「读 → 判断 → 写」，**不是原子表达式**。当前之所以成立，是因为
        // SQLite 的写锁把并发事务串行化了（已用并发用例实测：同篇并发投喂不破 5）。
        // **迁到 Postgres/MySQL 后（见 docs/nextjs-migration/03 §7）此处会失效** ——
        // READ COMMITTED 下两个事务可能同时读到 amount=3、各自 +2，结果 7 > 5。
        // 届时应改为原子条件写，例如：
        //   UPDATE blog_feeds SET amount = amount + ?
        //    WHERE blog_id = ? AND user_id = ? AND amount + ? <= 5
        // 再按受影响行数判定（0 行 = 超限），与上面扣鱼干的 updateMany(gte) 同一套路。
        const existing = await tx.blogFeed.findUnique({
          where: { uq_blog_feed_user: { blogId, userId } },
          select: { amount: true },
        });
        const feedSeq = (existing?.amount ?? 0) + amount; // 投喂后累计量（并入远端幂等键）
        if (feedSeq > FEED_CAP) {
          throw new FeedBusinessError(400, '投喂已满（单篇文章每人最多投喂 5 条）');
        }
        if (existing) {
          await tx.blogFeed.update({
            where: { uq_blog_feed_user: { blogId, userId } },
            data: { amount: { increment: amount }, updatedAt: nowForDb() },
          });
        } else {
          await tx.blogFeed.create({
            data: { blogId, userId, amount, createdAt: nowForDb(), updatedAt: nowForDb() },
          });
        }

        // 3.4 累计文章投喂总量。
        await tx.blog.update({
          where: { id: blogId },
          data: { fishCount: { increment: amount } },
        });

        // ── 远端同步：★ 提交前 ★ 调用账户服务（fail-closed 关键点）─────────────
        // 远端抛错 → 从事务回调抛出 → Prisma 回滚整个本地事务。
        if (remoteEnabled) {
          await accountClient.feedTransfer({
            feederId: userId,
            feederApiKey,
            authorId: blog.authorId,
            amount,
            authorIncome,
            blogId,
            blogTitle: blog.title,
            feederName: feeder.username,
            feedSeq,
          });
        } else {
          // 未配置账户服务。
          //
          // 【生产必须 fail-closed】漏配 ACCOUNT_SERVICE_INTERNAL_TOKEN 时若静默放行，
          // 投喂会只写本地、远端毫无记账，且只留一条 console.warn —— 与 Phase 1.5 的
          // 意图完全相反（这是 fail-OPEN）。故生产环境直接抛 503 让问题当场暴露。
          assertRemoteRequiredInProduction('投喂');
          // 开发环境：仅本地记账，明确告警。
          console.warn(
            `[feed-service] ACCOUNT_SERVICE 未配置，投喂仅写本地库（dev fallback）。` +
              ` user=${userId} blog=${blogId} amount=${amount}`
          );
        }

        // 读取事务内的最新值（仍在事务中，故为本事务可见的最新状态）。
        const [feedRow, blogRow, feederRow] = await Promise.all([
          tx.blogFeed.findUnique({
            where: { uq_blog_feed_user: { blogId, userId } },
            select: { amount: true },
          }),
          tx.blog.findUnique({ where: { id: blogId }, select: { fishCount: true } }),
          tx.user.findUnique({ where: { id: userId }, select: { driedFish: true } }),
        ]);

        const fedTotal = feedRow?.amount ?? amount;
        return {
          fedTotal,
          remaining: Math.max(0, FEED_CAP - fedTotal),
          fishCount: blogRow?.fishCount ?? 0,
          balance: feederRow?.driedFish ?? 0,
          authorIncome,
        };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    // 通知文章作者（对齐 Flask feed_fish：自投喂不通知；**在事务提交之后**发，
    // 且通知失败不回滚已成功的投喂 —— 钱已经结算完了，不能因为发通知失败而退回）。
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

    return { ok: true, ...result };
  } catch (e) {
    if (e instanceof FeedBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
    if (e instanceof AccountServiceError) {
      // 远端失败：本地事务已回滚，向上抛让路由返回 503。
      console.warn(
        `[feed-service] 账户服务投喂同步失败，本地事务已回滚` +
          `（user=${userId} blog=${blogId} amount=${amount}）: ${e.message}`
      );
      throw e;
    }
    // 兜底：意外异常按 fail-closed 处理，包装为 503。
    console.error(
      `[feed-service] 投喂异常，本地事务已回滚（user=${userId} blog=${blogId} amount=${amount}）:`,
      e
    );
    throw new AccountServiceError(`投喂失败: ${String(e)}`, 503);
  }
}
