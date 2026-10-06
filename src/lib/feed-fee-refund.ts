// 历史投喂手续费返还（CLI fish refund-feed-fees）。
//
// 按流水上的「原收款作者 + 文章」核算：投喂者实付 - 作者已收 - 历史补发 - 已退款。
// 不能直接拿 feed_receive × 25%：早期分成比例不同，且已有 feed_backpay 补发。
// 不按当前角色或文章软删状态筛选：这是归还原来扣掉的收入，不是新增赚取渠道。
//
// 每位作者独立一笔事务，事务内重新核算；加余额、写退款流水、登记确定键同时提交。
// 重跑时已退款进入「已收」总额，欠款归零。键包含该文章的累计实付金额：若旧进程
// 又产生了一笔收费投喂，重跑仍能补足新差额。上线应先切换免手续费代码，再跑本命令。

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { claimIdempotency } from './fish-idempotency';
import { postEntry } from './fish-service';
import { fishToUnits, MAX_FISH_UNITS, unitsToFish } from './fish-units';

const REFUND_TYPE = 'feed_fee_refund';
const FEED_TYPES = ['feed', 'feed_receive', 'feed_backpay', REFUND_TYPE];
type Reader = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

interface RefundRow {
  authorId: string;
  username: string | null;
  blogId: string;
  title: string | null;
  spentUnits: number | bigint;
  receivedUnits: number | bigint;
  balanceUnits: number | null;
}

export interface FeedFeeRefundItem {
  authorId: string;
  username: string;
  blogId: string;
  title: string;
  spentUnits: number;
  receivedUnits: number;
  refundUnits: number;
}

/** 只读预检：拒绝不完整的对手方 / 文章信息与尚未整数化的历史库。 */
async function validateSource() {
  const invalid = await prisma.fishTransaction.findFirst({
    where: {
      type: { in: FEED_TYPES },
      OR: [
        { referenceType: null },
        { referenceType: { not: 'blog' } },
        { referenceId: null },
        { type: 'feed', relatedUserId: null },
        { type: 'feed', amount: { gte: 0 } },
        { type: { in: FEED_TYPES.slice(1) }, amount: { lte: 0 } },
      ],
    },
    select: { id: true },
  });
  if (invalid) throw new Error(`投喂流水 ${invalid.id} 信息或金额异常，未执行补偿`);

  const badUnits = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `SELECT id FROM fish_transactions
     WHERE type IN ('feed', 'feed_receive', 'feed_backpay', 'feed_fee_refund')
       AND (amount != CAST(amount AS INTEGER)
         OR (type = 'feed' AND (-amount < ? OR -amount > ? OR (-amount % ?) != 0)))
     LIMIT 1`,
    fishToUnits(1), fishToUnits(5), fishToUnits(1)
  );
  if (badUnits.length) {
    throw new Error(`投喂流水 ${badUnits[0].id} 不是当前鱼干存储单位，请先检查数据库迁移`);
  }
}

async function pendingRefunds(reader: Reader, authorId: string | null = null) {
  const rows = await reader.$queryRawUnsafe<RefundRow[]>(
    `WITH entries AS (
       SELECT related_user_id AS authorId, reference_id AS blogId,
              -amount AS spentUnits, 0 AS receivedUnits
       FROM fish_transactions WHERE type = 'feed' AND reference_type = 'blog'
       UNION ALL
       SELECT user_id, reference_id, 0, amount FROM fish_transactions
       WHERE type IN ('feed_receive', 'feed_backpay', 'feed_fee_refund')
         AND reference_type = 'blog'
     )
     SELECT e.authorId, e.blogId, u.username, b.title,
            SUM(e.spentUnits) AS spentUnits, SUM(e.receivedUnits) AS receivedUnits,
            u.dried_fish AS balanceUnits
     FROM entries e
     LEFT JOIN users u ON u.id = e.authorId
     LEFT JOIN blogs b ON b.id = e.blogId
     WHERE (? IS NULL OR e.authorId = ?)
     GROUP BY e.authorId, e.blogId ORDER BY e.authorId, e.blogId`,
    authorId, authorId
  );
  const items: FeedFeeRefundItem[] = [];
  const authorTotals = new Map<string, number>();
  for (const row of rows) {
    const spentUnits = Number(row.spentUnits);
    const receivedUnits = Number(row.receivedUnits);
    const refundUnits = spentUnits - receivedUnits;
    if (!row.username || row.balanceUnits === null ||
        !Number.isSafeInteger(spentUnits) || !Number.isSafeInteger(receivedUnits) ||
        refundUnits < 0) {
      throw new Error(`作者 ${row.authorId} 的文章 ${row.blogId} 投喂账目异常，未执行补偿`);
    }
    if (refundUnits === 0) continue;
    const total = (authorTotals.get(row.authorId) ?? 0) + refundUnits;
    if (total + Number(row.balanceUnits) > MAX_FISH_UNITS) {
      throw new Error(`作者 ${row.username} 补偿后余额超过存储上限，未执行补偿`);
    }
    authorTotals.set(row.authorId, total);
    items.push({
      authorId: row.authorId, username: row.username, blogId: row.blogId,
      title: row.title ?? row.blogId, spentUnits, receivedUnits, refundUnits,
    });
  }
  return items;
}

export async function planFeedFeeRefund() {
  await validateSource();
  const items = await pendingRefunds(prisma);
  return {
    authors: new Set(items.map((item) => item.authorId)).size,
    articles: items.length,
    totalFish: unitsToFish(items.reduce((sum, item) => sum + item.refundUnits, 0)),
    items,
  };
}

export async function refundFeedFees(opts: { dryRun?: boolean } = {}) {
  const plan = await planFeedFeeRefund();
  const result = {
    ...plan, dryRun: opts.dryRun === true, succeeded: 0, skipped: 0,
    refundedFish: 0, failed: [] as { authorId: string; username: string; reason: string }[],
  };
  if (result.dryRun) return result;

  const authors = new Map(plan.items.map((item) => [item.authorId, item.username]));
  let refundedUnits = 0;
  for (const [authorId, username] of authors) {
    try {
      const units = await prisma.$transaction(async (tx) => {
        const items = await pendingRefunds(tx, authorId);
        let total = 0;
        for (const item of items) {
          const hash = createHash('sha256')
            .update(JSON.stringify([authorId, item.blogId, item.spentUnits]))
            .digest('hex');
          await claimIdempotency(tx, {
            idempotencyKey: `feed-fee-refund-${hash.slice(0, 40)}`,
            operation: REFUND_TYPE,
            payload: {
              authorId, blogId: item.blogId, spentUnits: item.spentUnits,
              receivedUnits: item.receivedUnits, refundUnits: item.refundUnits,
            },
          });
          await postEntry(tx, {
            userId: authorId, units: item.refundUnits, type: REFUND_TYPE,
            description: `返还文章「${item.title}」历史投喂手续费`,
            referenceType: 'blog', referenceId: item.blogId,
          });
          total += item.refundUnits;
        }
        return total;
      }, { maxWait: 10_000, timeout: 30_000 });
      if (units === 0) result.skipped++;
      else result.succeeded++;
      refundedUnits += units;
    } catch (error) {
      result.failed.push({
        authorId, username, reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.refundedFish = unitsToFish(refundedUnits);
  return result;
}
