import { beforeEach, describe, expect, it } from 'vitest';
import { planFeedFeeRefund, refundFeedFees } from '@/lib/feed-fee-refund';
import { feedBlog } from '@/lib/feed-service';
import { getBalance, getTransactions, getTransactionsSince, postEntry } from '@/lib/fish-service';
import { nowForDb } from '@/lib/db-time';
import { fishToUnits, MAX_FISH_UNITS } from '@/lib/fish-units';
import { makeBlog, prisma, resetDb } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';

beforeEach(resetDb);

/** 真实账本夹具：模拟旧投喂比例与历史补发，不调用已免手续费的新投喂。 */
async function oldFeed(
  blogId: string, authorId: string, feederId: string,
  amount: number, income: number, backpay = 0
) {
  await prisma.$transaction(async (tx) => {
    await postEntry(tx, {
      userId: feederId, units: fishToUnits(-amount), type: 'feed',
      referenceType: 'blog', referenceId: blogId, relatedUserId: authorId,
    });
    await postEntry(tx, {
      userId: authorId, units: fishToUnits(income), type: 'feed_receive',
      referenceType: 'blog', referenceId: blogId, relatedUserId: feederId,
    });
    if (backpay) {
      await postEntry(tx, {
        userId: authorId, units: fishToUnits(backpay), type: 'feed_backpay',
        referenceType: 'blog', referenceId: blogId,
      });
    }
    await tx.blogFeed.upsert({
      where: { uq_blog_feed_user: { blogId, userId: feederId } },
      create: {
        blogId, userId: feederId, amount: fishToUnits(amount),
        createdAt: nowForDb(), updatedAt: nowForDb(),
      },
      update: { amount: { increment: fishToUnits(amount) }, updatedAt: nowForDb() },
    });
    await tx.blog.update({ where: { id: blogId }, data: { fishCount: { increment: amount } } });
  });
}

async function scene() {
  const author = await makeFishUser(0, { role: 'core' });
  const feeder = await makeFishUser(100, { role: 'core' });
  const blog = await makeBlog({ authorId: author.id });
  return { author, feeder, blog };
}

describe('历史投喂手续费返还', () => {
  it.each([1, 2, 3, 4, 5])('投喂 %i 的历史 20%% 手续费补足，投喂者和投喂计数不变', async (amount) => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, amount, amount * 0.8);
    const feedBefore = await prisma.blogFeed.findMany();
    const blogBefore = await prisma.blog.findUnique({ where: { id: blog.id } });
    const result = await refundFeedFees();
    expect(result).toMatchObject({ authors: 1, succeeded: 1, refundedFish: amount / 5, failed: [] });
    expect(await getBalance(author.id)).toBe(amount);
    expect(await getBalance(feeder.id)).toBe(100 - amount);
    expect(await prisma.blogFeed.findMany()).toEqual(feedBefore);
    expect(await prisma.blog.findUnique({ where: { id: blog.id } })).toEqual(blogBefore);
    expect(await prisma.fishTransaction.findFirst({ where: { type: 'feed_fee_refund' } }))
      .toMatchObject({ userId: author.id, referenceType: 'blog', referenceId: blog.id,
        amount: fishToUnits(amount / 5), transferId: null });
    expect(await prisma.accountSyncLedger.findFirst({ where: { operation: 'feed_fee_refund' } }))
      .toMatchObject({ status: 'synced' });
    await expectLedgerConsistent('历史手续费返还');
  });

  it('更早的 20% 收入 + 已补发 60%，只返还剩余 20%；未补发的按实际欠款补足', async () => {
    const { author, feeder, blog } = await scene();
    const other = await makeBlog({ authorId: author.id });
    await oldFeed(blog.id, author.id, feeder.id, 5, 1, 3);
    await oldFeed(other.id, author.id, feeder.id, 2, 0.4);
    expect(await planFeedFeeRefund()).toMatchObject({ authors: 1, articles: 2, totalFish: 2.6 });
    expect(await refundFeedFees()).toMatchObject({ refundedFish: 2.6, failed: [] });
    expect(await getBalance(author.id)).toBe(7);
    const page = await getTransactions(author.id, 1, 20, 'feed_all');
    const since = await getTransactionsSince(author.id, 0, 100, 'feed_all');
    expect(page.transactions.map((item) => item.type).sort())
      .toEqual(['feed_backpay', 'feed_fee_refund', 'feed_fee_refund', 'feed_receive', 'feed_receive']);
    expect(since.map((item) => item.id).sort()).toEqual(page.transactions.map((item) => item.id).sort());
    await expectLedgerConsistent('不同历史分成与补发');
  });

  it('dry-run 只读，重复执行以及随后全额投喂都不会重复退款', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 2, 1.6);
    const before = await prisma.fishTransaction.count();
    expect(await refundFeedFees({ dryRun: true })).toMatchObject({ totalFish: 0.4, refundedFish: 0 });
    expect(await getBalance(author.id)).toBe(1.6);
    expect(await prisma.fishTransaction.count()).toBe(before);
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await refundFeedFees()).toMatchObject({ refundedFish: 0.4 });
    const after = await prisma.fishTransaction.count();
    expect(await refundFeedFees()).toMatchObject({ authors: 0, refundedFish: 0 });
    expect(await prisma.fishTransaction.count()).toBe(after);
    expect(await feedBlog(blog.id, feeder.id, 3)).toMatchObject({ ok: true, authorIncome: 3 });
    expect(await refundFeedFees()).toMatchObject({ authors: 0, refundedFish: 0 });
    expect(await getBalance(author.id)).toBe(5);
    await expectLedgerConsistent('只读预览与重复执行');
  });

  it('新旧投喂混在同一篇，只补旧费用；旧进程后来产生新扣费仍能续补', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 1, 0.8);
    await feedBlog(blog.id, feeder.id, 1);
    expect(await refundFeedFees()).toMatchObject({ refundedFish: 0.2 });
    await oldFeed(blog.id, author.id, feeder.id, 1, 0.8);
    expect(await refundFeedFees()).toMatchObject({ refundedFish: 0.2 });
    expect(await prisma.accountSyncLedger.count({ where: { operation: 'feed_fee_refund' } })).toBe(2);
    expect(await getBalance(author.id)).toBe(3);
    await expectLedgerConsistent('切换期间的新旧投喂');
  });

  it('自投、软删、禁言、降档都不丢退款，按流水原作者归还', async () => {
    const { author, blog } = await scene();
    await prisma.$transaction((tx) => postEntry(tx, {
      userId: author.id, units: fishToUnits(5), type: 'admin_grant',
    }));
    await oldFeed(blog.id, author.id, author.id, 5, 4);
    const newAuthor = await makeFishUser(0);
    await prisma.blog.update({ where: { id: blog.id }, data: { ignore: true, authorId: newAuthor.id } });
    await prisma.user.update({ where: { id: author.id }, data: { role: 'user', isBanned: true } });
    expect(await refundFeedFees()).toMatchObject({ succeeded: 1, refundedFish: 1 });
    expect(await getBalance(author.id)).toBe(5);
    expect(await getBalance(newAuthor.id)).toBe(0);
    await expectLedgerConsistent('归还原作者既有收入');
  });

  it('一位作者的第二篇退款失败，整位回滚，其他作者可完成，重跑补足失败者', async () => {
    const author = await makeFishUser(0, { id: 'a-author' });
    const otherAuthor = await makeFishUser(0, { id: 'b-author' });
    const feeder = await makeFishUser(20);
    const first = await makeBlog({ id: 'a-blog', authorId: author.id });
    const failing = await makeBlog({ id: 'b-blog', authorId: author.id });
    const other = await makeBlog({ authorId: otherAuthor.id });
    for (const [blogId, authorId] of [[first.id, author.id], [failing.id, author.id], [other.id, otherAuthor.id]]) {
      await oldFeed(blogId, authorId, feeder.id, 5, 4);
    }
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_feed_refund BEFORE INSERT ON fish_transactions
      WHEN NEW.type='feed_fee_refund' AND NEW.reference_id='b-blog'
      BEGIN SELECT RAISE(ABORT, 'test refund failure'); END`);
    try {
      const result = await refundFeedFees();
      expect(result).toMatchObject({ succeeded: 1, refundedFish: 1 });
      expect(result.failed).toHaveLength(1);
      expect(await getBalance(author.id)).toBe(8);
      expect(await getBalance(otherAuthor.id)).toBe(5);
      expect(await prisma.accountSyncLedger.count({ where: { operation: 'feed_fee_refund' } })).toBe(1);
      await expectLedgerConsistent('部分失败之后');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_feed_refund');
    }
    expect(await refundFeedFees()).toMatchObject({ succeeded: 1, refundedFish: 2, failed: [] });
    expect(await getBalance(author.id)).toBe(10);
    expect(await prisma.fishTransaction.count({ where: { type: 'feed_fee_refund' } })).toBe(3);
    await expectLedgerConsistent('部分失败后续跑');
  });

  it('并发跑补偿也只返还一遍，失败进程重跑仍然不会多发', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 5, 4);
    await Promise.allSettled([refundFeedFees(), refundFeedFees()]);
    await refundFeedFees();
    expect(await getBalance(author.id)).toBe(5);
    expect(await prisma.fishTransaction.count({ where: { type: 'feed_fee_refund' } })).toBe(1);
    expect(await prisma.accountSyncLedger.count({ where: { operation: 'feed_fee_refund' } })).toBe(1);
    await expectLedgerConsistent('并发与续跑');
  });

  it('缺对手方的旧流水拒绝预检，不猜作者也不发钱', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 5, 4);
    await prisma.fishTransaction.updateMany({ where: { type: 'feed' }, data: { relatedUserId: null } });
    await expect(refundFeedFees()).rejects.toThrow('信息或金额异常');
    expect(await prisma.fishTransaction.count({ where: { type: 'feed_fee_refund' } })).toBe(0);
    await expectLedgerConsistent('预检拒绝缺信息');
  });

  it('尚未迁移的存储单位拒绝执行', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 5, 4);
    await prisma.$executeRawUnsafe("UPDATE fish_transactions SET amount=amount/10000.0 WHERE type IN ('feed','feed_receive')");
    await expect(refundFeedFees()).rejects.toThrow('存储单位');
    expect(await prisma.accountSyncLedger.count()).toBe(0);
  });

  it('作者已收超过实付时拒绝执行，不用负数退款冲正', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 1, 2);
    await expect(refundFeedFees()).rejects.toThrow('投喂账目异常');
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    await expectLedgerConsistent('预检拒绝超额收入');
  });

  it('退款将超过 i32 余额上限时在写入前拒绝', async () => {
    const { author, feeder, blog } = await scene();
    await oldFeed(blog.id, author.id, feeder.id, 5, 4);
    await prisma.$transaction((tx) => postEntry(tx, {
      userId: author.id, units: MAX_FISH_UNITS - fishToUnits(4), type: 'admin_grant',
    }));
    await expect(refundFeedFees()).rejects.toThrow('存储上限');
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    await expectLedgerConsistent('预检拒绝余额溢出');
  });
});
