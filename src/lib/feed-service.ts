// ─────────────────────────────────────────────────────────────────────────────
// feed-service.ts — 文章投喂小鱼干（对齐 Flask app/web/blog/services/feed_fish_service.py）
//
// 投喂模型：投喂者付全额，作者获 80% 分成；单用户对单篇累计上限 5。
//
// ★★★ 写路径 fail-closed（CLAUDE.md「鱼干写路径」）★★★
//   远端 HTTP 调用**不在 SQLite 事务内**（写锁被占最长 5s 会拖垮并发写路径），
//   改为「先提交本地 + 同步账本登记 + 事务外同步 + 失败补偿」：
//   Tx A：扣投喂者 / 加作者 / BlogFeed / Blog.fishCount / 两条流水 + 账本行 pending
//         ──→ 提交；随后调用账户微服务（幂等键与旧版一致）。
//   远端成功 → 账本标 synced；远端失败 → 补偿事务精确撤销本地写入（对用户仍等价于
//   「回滚 + 503」），绝不出现“本地已扣鱼干但远端没记账”且无人知晓的不一致。
//   机制详见 src/lib/fish-sync.ts。远端不可达一律以 AccountServiceError(503)
//   向上抛，路由据此返回 503（**绝不静默成功**）。
//
//   dev fallback：当 ACCOUNT_SERVICE_INTERNAL_TOKEN 未配置时，跳过远端同步与账本，
//   仅写本地并打印告警，使该切片在无账户服务时可运行；fail-closed 结构保持不变。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { sendNotification } from './notification-service';
import {
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  decryptApiKey,
  makeFeedIdempotencyKey,
  AccountServiceError,
} from './account-client';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
} from './fish-sync';
import type { Prisma } from '@prisma/client';

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
        amount: unitsToFish(f.amount),
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
 * 【远端同步失败补偿所需的快照】Tx A 里捕获撤销所需的全部事实
 * （两条流水 id / priorFeedAmount / feedSeq），补偿事务按 id 精确撤销。
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

  // 未配置账户服务：生产 fail-closed（不做任何本地写入直接拒绝）；dev 仅本地 + 告警。
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('投喂');
    console.warn(
      `[feed-service] ACCOUNT_SERVICE 未配置，投喂仅写本地库（dev fallback）。` +
        ` user=${userId} blog=${blogId} amount=${amount}`
    );
  } else if (!feeder.fishApiKeyEncrypted) {
    throw new AccountServiceError('投喂者没有关联的账户 Key，无法完成远端结算', 503);
  } else {
    // fail-fast：先解出投喂者 Key，解密失败即 503（不做任何本地写入）。
    decryptApiKey(feeder.fishApiKeyEncrypted);
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
    // ── Phase 1：本地事务（纯 DB，无远端 IO —— 写锁只持有毫秒级）────────────────
    const phase1 = await prisma.$transaction(async (tx) => {
      // 金额换算：业务单位（鱼干）→ 存储单位（0.1 鱼干，见 fish-units.ts）。
      const units = fishToUnits(amount);
      // 1.1 原子扣减投喂者鱼干（WHERE driedFish >= amount 防超扣）。
      const dec = await tx.user.updateMany({
        where: { id: userId, driedFish: { gte: units } },
        data: { driedFish: { decrement: units } },
      });
      if (dec.count === 0) {
        throw new FeedBusinessError(400, '小鱼干不足');
      }
      // 投喂者支出流水（负数表示支出）。
      const feederTx = await tx.fishTransaction.create({
        data: {
          userId,
          amount: -units,
          type: 'feed',
          description: `投喂文章「${blog.title}」`,
          referenceType: 'blog',
          referenceId: blogId,
          relatedUserId: blog.authorId,
          createdAt: nowForDb(),
        },
        select: { id: true },
      });

      // 1.2 作者收入 80%（复用 addFish：加余额 + 写 feed_receive 流水）。
      const incomeTx = await addFish(tx, {
        userId: blog.authorId,
        amount: authorIncome,
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
      // 再按受影响行数判定（0 行 = 超限），与上面扣鱼干的 updateMany(gte) 同一套路。
      const existing = await tx.blogFeed.findUnique({
        where: { uq_blog_feed_user: { blogId, userId } },
        select: { amount: true },
      });
      // BlogFeed.amount 存储单位 → 业务单位（鱼干）后再算累计量（feedSeq 进幂等键，
      // 保持与旧版一致的鱼干口径）。
      const priorAmount = existing ? unitsToFish(existing.amount) : null;
      const feedSeq = (priorAmount ?? 0) + amount; // 投喂后累计量（并入远端幂等键）
      if (feedSeq > FEED_CAP) {
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
      await tx.blog.update({
        where: { id: blogId },
        data: { fishCount: { increment: amount } },
      });

      // 1.5 账本登记 pending（与业务写入同事务提交；幂等键与远端三键同根）。
      if (remoteEnabled) {
        await recordPendingSync(tx, {
          idempotencyKey: makeFeedIdempotencyKey(blogId, userId, feedSeq, 'sync'),
          operation: 'feed',
          payload: {
            feederId: userId,
            authorId: blog.authorId,
            amount,
            authorIncome,
            blogId,
            blogTitle: blog.title,
            feederName: feeder.username,
            feedSeq,
          },
        });
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

      const fedTotal = feedRow ? unitsToFish(feedRow.amount) : amount;
      return {
        fedTotal,
        remaining: Math.max(0, FEED_CAP - fedTotal),
        fishCount: blogRow?.fishCount ?? 0,
        balance: feederRow ? unitsToFish(feederRow.driedFish) : 0,
        authorIncome,
        // 补偿所需快照
        feedSeq,
        priorFeedAmount: priorAmount,
        feederTxId: feederTx.id,
        authorTxId: incomeTx.txId,
      };
    });

    // ── Phase 2：事务外远端同步（提交后调用；失败走补偿，不再占用写锁）──────────
    if (remoteEnabled) {
      const entry = {
        idempotencyKey: makeFeedIdempotencyKey(blogId, userId, phase1.feedSeq, 'sync'),
        operation: 'feed' as const,
        payload: {
          feederId: userId,
          authorId: blog.authorId,
          amount,
          authorIncome,
          blogId,
          blogTitle: blog.title,
          feederName: feeder.username,
          feedSeq: phase1.feedSeq,
        },
      };
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        // ── Phase 3：远端失败 → 补偿事务精确撤销本地写入（对用户仍等价于回滚）──
        try {
          const undoUnits = fishToUnits(amount);
          const incomeUnits = fishToUnits(authorIncome);
          await prisma.$transaction(async (tx) => {
            // 3.1 删除两条流水（按 id 精确撤销）
            await tx.fishTransaction.deleteMany({
              where: { id: { in: [phase1.feederTxId, phase1.authorTxId] } },
            });
            // 3.2 投喂者拿回全额（此前扣过 units，余额不可能因此变负）
            await tx.user.update({
              where: { id: userId },
              data: { driedFish: { increment: undoUnits } },
            });
            // 3.3 作者退回分成（防负：余额可能已被花掉一部分）
            const dec = await tx.user.updateMany({
              where: { id: blog.authorId, driedFish: { gte: incomeUnits } },
              data: { driedFish: { decrement: incomeUnits } },
            });
            if (dec.count === 0) {
              throw new Error(
                `作者余额不足以退回分成（author=${blog.authorId} income=${authorIncome}）`
              );
            }
            // 3.4 BlogFeed 回退：Tx A 前不存在 → 整行删除；存在 → 减去本次量
            if (phase1.priorFeedAmount === null) {
              await tx.blogFeed.delete({
                where: { uq_blog_feed_user: { blogId, userId } },
              });
            } else {
              await tx.blogFeed.update({
                where: { uq_blog_feed_user: { blogId, userId } },
                data: { amount: { decrement: undoUnits }, updatedAt: nowForDb() },
              });
            }
            // 3.5 fishCount 回退（fishCount 仍是鱼干口径的整数列，与 Tx A 的 increment 同量）
            const decFish = await tx.blog.updateMany({
              where: { id: blogId, fishCount: { gte: amount } },
              data: { fishCount: { decrement: amount } },
            });
            if (decFish.count === 0) {
              throw new Error(`fishCount 不足以回退（blog=${blogId} amount=${amount}）`);
            }
            // 3.6 删除账本行：释放幂等键，用户重试时可以重建（无痕失败）。
            // 成功补偿 = 两边都回到原点，账本行不再保留（'compensated' 状态仅存在于
            // 语义上；保留行会撞 idempotencyKey 唯一约束，挡住用户的重试）。
            await tx.accountSyncLedger.deleteMany({
              where: { idempotencyKey: entry.idempotencyKey },
            });
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
          : new AccountServiceError(`投喂同步失败: ${String(syncErr)}`, 503);
      }
    }

    // 通知文章作者（对齐 Flask feed_fish：自投喂不通知；**在提交与同步之后**发，
    // 且通知失败不影响已成功的投喂 —— 钱已经结算完了，不能因为发通知失败而退回）。
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
      fedTotal: phase1.fedTotal,
      remaining: phase1.remaining,
      fishCount: phase1.fishCount,
      balance: phase1.balance,
      authorIncome: phase1.authorIncome,
    };
  } catch (e) {
    if (e instanceof FeedBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
    if (e instanceof AccountServiceError) {
      // 远端失败：本地已被补偿（等价于回滚），向上抛让路由返回 503。
      console.warn(
        `[feed-service] 账户服务投喂同步失败，本地写入已补偿回滚` +
          `（user=${userId} blog=${blogId} amount=${amount}）: ${e.message}`
      );
      throw e;
    }
    // 兜底：意外异常按 fail-closed 处理，包装为 503。
    console.error(
      `[feed-service] 投喂异常（user=${userId} blog=${blogId} amount=${amount}）:`,
      e
    );
    throw new AccountServiceError(`投喂失败: ${String(e)}`, 503);
  }
}
