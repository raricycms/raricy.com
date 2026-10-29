import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser as makeBareUser, makeBlog, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';
import { checkIn } from '@/lib/checkin-service';
import { nowForDb, dayStart } from '@/lib/db-time';
import * as dbTime from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { getTodayQuote, quoteContentKey, quoteView, resonateQuote, submitQuote, reviewQuote, quoteReviewVersion,
  saveQuote, listSavedQuotes, listQuoteHistory, listSubmissions, editQuoteSubmission, listReviewQuotes } from '@/lib/daily-quote-service';

async function makeUser(role: 'core' | 'admin' | 'owner' = 'core') {
  const user = await makeBareUser({ role }); await makeBlog({ authorId: user.id }); return user;
}
let sequence = 0;
async function content(authorId?: string) {
  const id = `lifecycle-${++sequence}`;
  return prisma.dailyQuote.create({ data: { id, content: id, contentKey: quoteContentKey(id),
    kind: authorId ? 'community' : 'builtin', submitterId: authorId, category: '哲思', sourceType: 'original',
    status: 'approved', createdAt: nowForDb() } });
}
async function published(authorId: string, day = '2026-10-20') {
  const quote = await content(authorId);
  await prisma.dailyQuoteEdition.create({ data: { day, quoteId: quote.id, createdAt: nowForDb() } });
  await prisma.dailyQuote.update({ where: { id: quote.id }, data: { firstSelectedDay: day } });
  return quote;
}
const input = { content: '最初的稿件', category: '哲思', signature: 'nickname', source_type: 'original' };

beforeEach(async () => {
  await resetDb(); __resetRateLimitStore();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T02:00:00Z'));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('一言重构的生命周期与账务边界', () => {
  it('社区按审核时间并轮换作者；用完后只循环经典，91天后也不回流', async () => {
    const a = await makeUser(); const b = await makeUser(); const reader = await makeUser();
    const q1 = await content(a.id); const q2 = await content(a.id); const q3 = await content(b.id);
    for (const [i, quote] of [q1, q2, q3].entries()) await prisma.dailyQuote.update({ where: { id: quote.id },
      data: { reviewedAt: new Date(`2026-10-20T00:00:0${i}.000Z`) } });
    const classic = await content();
    for (const [i, id] of [q1.id, q3.id, q2.id, classic.id].entries()) {
      vi.setSystemTime(new Date(`2026-10-${21 + i}T02:00:00Z`)); await checkIn(reader.id);
      expect((await getTodayQuote(reader.id)).quote?.id).toBe(id);
    }
    vi.setSystemTime(new Date('2027-01-30T02:00:00Z')); await checkIn(reader.id);
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(classic.id);
    for (const q of [q1, q2, q3]) expect(await prisma.dailyQuoteEdition.count({ where: { quoteId: q.id } })).toBe(1);
    expect((await listSubmissions(a.id)).every((q) => q.display_status === 'selected')).toBe(true);
    await expectLedgerConsistent();
  });

  it('作者降级、禁言或删光博客暂停候选；恢复后仍可首次选登', async () => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await content(author.id); const classic = await content();
    for (const [i, data] of [{ role: 'user' }, { role: 'core', isBanned: true }, { isBanned: false }].entries()) {
      await prisma.user.update({ where: { id: author.id }, data });
      if (i === 2) await prisma.blog.updateMany({ where: { authorId: author.id }, data: { ignore: true } });
      vi.setSystemTime(new Date(`2026-10-${21 + i}T02:00:00Z`)); await checkIn(reader.id);
      expect((await getTodayQuote(reader.id)).quote?.id).toBe(classic.id);
    }
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).firstSelectedDay).toBeNull();
    await makeBlog({ authorId: author.id }); vi.setSystemTime(new Date('2026-10-24T02:00:00Z')); await checkIn(reader.id);
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(quote.id);
    await expectLedgerConsistent();
  });

  it('选登失败不消耗社区稿；跨日并发也只认领一次', async () => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await content(author.id);
    await content(); await checkIn(reader.id);
    await prisma.$executeRawUnsafe("CREATE TRIGGER quote_edition_failure BEFORE INSERT ON daily_quote_editions BEGIN SELECT RAISE(ABORT,'edition failed'); END");
    try { await expect(getTodayQuote(reader.id)).rejects.toThrow(); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER quote_edition_failure'); }
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).firstSelectedDay).toBeNull();
    await prisma.dailyCheckIn.create({ data: { userId: reader.id, checkinDate: dayStart('2026-10-22'), createdAt: nowForDb() } });
    vi.spyOn(dbTime, 'todayStr').mockReturnValueOnce('2026-10-21').mockReturnValue('2026-10-22');
    const results = await Promise.all([getTodayQuote(reader.id), getTodayQuote(reader.id)]);
    expect(results.filter((r) => r.quote?.id === quote.id)).toHaveLength(1);
    expect(await prisma.dailyQuoteEdition.count()).toBe(2);
    expect(await prisma.dailyQuoteEdition.count({ where: { quoteId: quote.id } })).toBe(1);
  });

  it('无博客 core 在所有服务出口受限；发文后恢复，删光后再次受限', async () => {
    const user = await makeBareUser({ role: 'core' }); const classic = await content();
    const operations = [() => getTodayQuote(user.id), () => listQuoteHistory(user.id), () => listSavedQuotes(user.id),
      () => listSubmissions(user.id), () => submitQuote(user.id, input), () => editQuoteSubmission('missing', user.id, input),
      () => resonateQuote(classic.id, user.id, 0), () => saveQuote(classic.id, user.id, true)];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ status: 403, reason: 'BLOG_REQUIRED' });
    const blog = await makeBlog({ authorId: user.id }); expect((await listQuoteHistory(user.id)).total).toBe(0);
    await prisma.blog.update({ where: { id: blog.id }, data: { ignore: true } });
    await expect(listSubmissions(user.id)).rejects.toMatchObject({ reason: 'BLOG_REQUIRED' });
  });

  it.each(['demoted', 'banned'])('作者 %s 时免费共鸣，恢复后不补扣或重置', async (state) => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await published(author.id);
    await prisma.user.update({ where: { id: author.id }, data: state === 'demoted' ? { role: 'user' } : { isBanned: true } });
    expect(await quoteView(quote, reader.id)).toMatchObject({ resonance_fish: 0, can_resonate: true });
    expect(await resonateQuote(quote.id, reader.id, 0)).toMatchObject({ charged_fish: 0, resonance_count: 1, balance: 0 });
    expect(await prisma.fishTransaction.count()).toBe(0);
    expect((await prisma.dailyQuoteResonance.findFirstOrThrow()).paidUnits).toBe(0);
    await prisma.user.update({ where: { id: author.id }, data: { role: 'core', isBanned: false } });
    expect(await resonateQuote(quote.id, reader.id, 0)).toMatchObject({ already_resonated: true, charged_fish: 0 });
    expect(await prisma.fishTransaction.count()).toBe(0); await expectLedgerConsistent();
  });

  it('免费变收费不意外扣款，收费变免费不扣；作者删光博客不改变既有收款资格', async () => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await published(author.id); await checkIn(reader.id);
    await expect(resonateQuote(quote.id, reader.id, 0)).rejects.toMatchObject({ status: 409, reason: 'FEE_CHANGED' });
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(0);
    await prisma.blog.updateMany({ where: { authorId: author.id }, data: { ignore: true } });
    expect(await resonateQuote(quote.id, reader.id, 1)).toMatchObject({ charged_fish: 1 });
    const second = await published(author.id, '2026-10-19'); await prisma.user.update({ where: { id: author.id }, data: { isBanned: true } });
    expect(await resonateQuote(second.id, reader.id, 1)).toMatchObject({ charged_fish: 0 }); await expectLedgerConsistent();
  });

  it('版本号防止改后改回让旧审核生效；列表分开未选登、已选登与经典', async () => {
    const author = await makeUser(); const admin = await makeUser('admin'); const quote = await submitQuote(author.id, input);
    const oldVersion = quoteReviewVersion(await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } }));
    await editQuoteSubmission(quote.id, author.id, { ...input, content: '中途的稿件', version: 1 });
    await expect(editQuoteSubmission(quote.id, author.id, { ...input, version: 1 })).rejects.toMatchObject({ reason: 'VERSION_CHANGED' });
    await editQuoteSubmission(quote.id, author.id, { ...input, version: 2 });
    await expect(reviewQuote(quote.id, admin.id, 'approve', '', oldVersion)).rejects.toMatchObject({ status: 409 });
    await reviewQuote(quote.id, admin.id, 'approve', ''); await content();
    expect((await listReviewQuotes('approved', 1, admin.id)).total).toBe(1);
    await checkIn(admin.id); expect((await getTodayQuote(admin.id)).quote?.id).toBe(quote.id);
    expect((await listReviewQuotes('approved', 1, admin.id)).total).toBe(0);
    expect((await listReviewQuotes('selected', 1, admin.id)).quotes[0].display_status).toBe('selected');
    expect((await listReviewQuotes('builtin', 1, admin.id)).total).toBe(1);
  });

  it('重复收藏保留原收藏时间，取消再加入才更新时间；经典重播不暴露最近入选日', async () => {
    const reader = await makeUser(); const classic = await content();
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-20', quoteId: classic.id, createdAt: nowForDb() } });
    await saveQuote(classic.id, reader.id, true);
    const original = (await listSavedQuotes(reader.id)).quotes[0].saved_at;
    vi.setSystemTime(new Date('2026-10-22T02:00:00Z'));
    await prisma.dailyQuoteEdition.create({ data: { day: '2026-10-22', quoteId: classic.id, createdAt: nowForDb() } });
    await saveQuote(classic.id, reader.id, true);
    const repeated = (await listSavedQuotes(reader.id)).quotes[0];
    expect(repeated).toMatchObject({ saved_at: original, first_selected_day: '2026-10-20' });
    expect(repeated).not.toHaveProperty('last_day');
    await saveQuote(classic.id, reader.id, false); await saveQuote(classic.id, reader.id, true);
    expect((await listSavedQuotes(reader.id)).quotes[0].saved_at).not.toBe(original);
  });
});
