import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';
import { checkIn } from '@/lib/checkin-service';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';
import {
  getTodayQuote, quoteContentKey, quoteView, resonateQuote, submitQuote,
  reviewQuote, saveQuote, listSavedQuotes, listSubmissions,
} from '@/lib/daily-quote-service';

beforeEach(async () => {
  await resetDb(); __resetRateLimitStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T23:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

let sequence = 0;
async function builtin(content = `山有木兮${++sequence}`) {
  return prisma.dailyQuote.create({ data: {
    id: `builtin-test-${++sequence}`, kind: 'builtin', content, contentKey: quoteContentKey(content),
    category: '哲思', authorName: '古人', sourceType: 'quotation', sourceName: '测试典籍',
    status: 'approved', createdAt: nowForDb(),
  } });
}
async function published(submitterId: string, signature = 'nickname') {
  const content = `投稿内容${++sequence}`;
  const quote = await prisma.dailyQuote.create({ data: {
    id: `community-test-${++sequence}`, kind: 'community', content, contentKey: quoteContentKey(content),
    category: '治愈', sourceType: 'original', submitterId, signature, status: 'approved', createdAt: nowForDb(),
  } });
  await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-21', quoteId: quote.id, createdAt: nowForDb() } });
  return quote;
}

describe('全站每日选取与90天去重', () => {
  it('必须先完成当天签到，读取一言不会代签或发鱼', async () => {
    const user = await makeUser({ role: 'core' });
    await builtin();
    await expect(getTodayQuote(user.id)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.dailyCheckIn.count()).toBe(0);
    expect(await prisma.dailyQuoteEdition.count()).toBe(0);
  });
  it('社区优先；多个用户并发打开得到同一句，刷新不会换句', async () => {
    const author = await makeUser({ role: 'core' });
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await builtin();
    const quote = await submitQuote(author.id, { content: '今天也要开心。', category: '治愈', signature: 'anonymous', source_type: 'original' });
    const admin = await makeUser({ role: 'admin' });
    await reviewQuote(quote.id, admin.id, 'approve', '');
    await checkIn(a.id); await checkIn(b.id);
    const results = await Promise.all([getTodayQuote(a.id), getTodayQuote(b.id), getTodayQuote(a.id)]);
    expect(results.map((r) => r.quote?.id)).toEqual([quote.id, quote.id, quote.id]);
    expect(results[0].quote?.author).toBe('匿名');
    expect(JSON.stringify(results[0])).not.toContain(author.id);
    expect(JSON.stringify(results[0])).not.toContain(author.username);
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
  });
  it('社区用过后启用经典兜底；第90天不重，第91天可重新使用', async () => {
    const user = await makeUser({ role: 'core' });
    const old = await builtin('旧日一言');
    const fresh = await builtin('新的经典');
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-07-23', quoteId: old.id, createdAt: nowForDb() } });
    await checkIn(user.id);
    expect((await getTodayQuote(user.id)).quote?.id).toBe(fresh.id);
    vi.setSystemTime(new Date('2026-10-21T16:00:00Z'));
    await checkIn(user.id);
    const next = await getTodayQuote(user.id);
    expect(next.day).toBe('2026-10-22');
    expect(next.quote?.id).toBe(old.id);
  });
  it('当天内容被下架只显示占位，不重新抽取；归档作者不可见', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    const quote = await published(author.id);
    await builtin(); await checkIn(reader.id);
    await prisma.dailyQuote.update({ where: { id: quote.id }, data: { status: 'retired' } });
    expect((await getTodayQuote(reader.id)).quote).toBeNull();
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
    await prisma.dailyQuote.update({ where: { id: quote.id }, data: { status: 'approved' } });
    await prisma.user.update({ where: { id: author.id }, data: { archivedAt: nowForDb() } });
    expect((await getTodayQuote(reader.id)).quote).toBeNull();
  });
});

describe('共鸣：全额投喂、每日去重、匿名与回滚', () => {
  it('扣付款者1鱼干，投稿人全额收到；重复与并发请求只记一次', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    await checkIn(reader.id);
    const quote = await published(author.id, 'anonymous');
    await Promise.all([resonateQuote(quote.id, reader.id), resonateQuote(quote.id, reader.id)]);
    await resonateQuote(quote.id, reader.id);
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).driedFish)).toBe(2);
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: author.id } })).driedFish)).toBe(1);
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    const payerLedger = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: reader.id, type: 'quote_resonance' } });
    expect(payerLedger.relatedUserId).toBeNull();
    const dto = await quoteView(quote, reader.id);
    expect(dto.resonated).toBe(true); expect(dto.resonance_count).toBe(1);
    await expectLedgerConsistent();
  });
  it('余额不足全部回滚，补足后仍可共鸣；作者入账失败也不扣钱', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    const quote = await published(author.id);
    await expect(resonateQuote(quote.id, reader.id)).rejects.toMatchObject({ status: 400 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await checkIn(reader.id);
    await prisma.user.update({ where: { id: author.id }, data: { role: 'user' } });
    await expect(resonateQuote(quote.id, reader.id)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(0);
    await expectLedgerConsistent();
  });
  it('经典免费；跨 UTC+8 零点可再共鸣；不能给自己投喂', async () => {
    const reader = await makeUser({ role: 'core' });
    const quote = await builtin();
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-21', quoteId: quote.id, createdAt: nowForDb() } });
    await resonateQuote(quote.id, reader.id);
    vi.setSystemTime(new Date('2026-10-21T16:00:00Z'));
    await resonateQuote(quote.id, reader.id);
    expect(await prisma.dailyQuoteResonance.count()).toBe(2);
    expect(await prisma.fishTransaction.count()).toBe(0);
    const own = await prisma.dailyQuote.create({ data: {
      id: 'own', kind: 'community', content: '自己的一言', contentKey: 'own', category: '励志',
      sourceType: 'original', submitterId: reader.id, status: 'approved', createdAt: nowForDb(),
    } });
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-22', quoteId: own.id, createdAt: nowForDb() } });
    await expect(resonateQuote(own.id, reader.id)).rejects.toMatchObject({ status: 400 });
    await expectLedgerConsistent();
  });
});

describe('投稿审核与私密收藏', () => {
  it('50字按 Unicode 字符计数；引用必填出处；重复内容不能绕过永久拒绝', async () => {
    const user = await makeUser({ role: 'core' }); const admin = await makeUser({ role: 'admin' });
    const input = { category: '治愈', signature: 'anonymous', source_type: 'original' };
    await expect(submitQuote(user.id, { ...input, content: '字'.repeat(51) })).rejects.toMatchObject({ status: 400 });
    await expect(submitQuote(user.id, { ...input, content: '引用内容', source_type: 'quotation' })).rejects.toMatchObject({ status: 400 });
    const quote = await submitQuote(user.id, { ...input, content: '好'.repeat(49) + '𠮷' });
    await reviewQuote(quote.id, admin.id, 'reject', '不予收录');
    await expect(reviewQuote(quote.id, admin.id, 'approve', '')).rejects.toMatchObject({ status: 409 });
    await expect(submitQuote(user.id, { ...input, content: '好'.repeat(49) + '𠮷！' })).rejects.toMatchObject({ status: 400 });
    const smaller = await submitQuote(user.id, { ...input, content: '同一句话。' });
    await reviewQuote(smaller.id, admin.id, 'reject', '不合适');
    __resetRateLimitStore();
    await expect(submitQuote(user.id, { ...input, content: '同一句话！' })).rejects.toMatchObject({ status: 409 });
    expect((await listSubmissions(user.id))[0].reviewReason).toBe('不合适');
  });
  it('只能收藏已发布内容；收藏归本人，取消再加可恢复；下架可移出', async () => {
    const a = await makeUser({ role: 'core' }); const b = await makeUser({ role: 'core' });
    const quote = await builtin();
    await expect(saveQuote(quote.id, a.id, true)).rejects.toMatchObject({ status: 404 });
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-21', quoteId: quote.id, createdAt: nowForDb() } });
    await saveQuote(quote.id, a.id, true); await saveQuote(quote.id, a.id, true);
    expect((await listSavedQuotes(a.id)).total).toBe(1);
    expect((await listSavedQuotes(b.id)).total).toBe(0);
    await saveQuote(quote.id, a.id, false); await saveQuote(quote.id, a.id, true);
    expect(await prisma.dailyQuoteFavorite.count()).toBe(1);
    await prisma.dailyQuote.update({ where: { id: quote.id }, data: { status: 'retired' } });
    expect((await listSavedQuotes(a.id)).quotes[0].quote).toBeNull();
    await saveQuote(quote.id, a.id, false);
    expect((await listSavedQuotes(a.id)).total).toBe(0);
  });
});
