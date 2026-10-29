import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';
import { checkIn } from '@/lib/checkin-service';
import { dayStart, nowForDb, todayStr } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';
import {
  getTodayQuote, quoteContentKey, quoteView, resonateQuote, submitQuote,
  reviewQuote, saveQuote, listSavedQuotes, listQuoteHistory, listSubmissions,
} from '@/lib/daily-quote-service';

beforeEach(async () => {
  await resetDb(); __resetRateLimitStore();
  // 冻结在 UTC+8 的 2026-10-21 07:00，todayStr() = '2026-10-21'：
  // 「今天 / 过去的期」判定在整套用例里是确定的，不随真实日期漂移。
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
async function community(submitterId: string, signature = 'nickname') {
  const content = `投稿内容${++sequence}`;
  return prisma.dailyQuote.create({ data: {
    id: `community-test-${++sequence}`, kind: 'community', content, contentKey: quoteContentKey(content),
    category: '治愈', sourceType: 'original', submitterId, signature, status: 'approved', createdAt: nowForDb(),
  } });
}
/** 写入「某天选中了这一句」的选用记录（共鸣 / 收藏都要求内容已发布 = 有过 edition）。 */
async function publish(day: string, quoteId: string) {
  return prisma.dailyQuoteEdition.create({ data: { day, quoteId, createdAt: nowForDb() } });
}
async function published(submitterId: string, signature = 'nickname') {
  const quote = await community(submitterId, signature);
  await publish('2026-10-21', quote.id);
  return quote;
}
/** 造 n 个连续过去的日期（含 endDay），用于分页夹具。 */
function daysBefore(endDay: string, n: number): string[] {
  const base = dayStart(endDay).getTime();
  return Array.from({ length: n }, (_, i) => new Date(base - i * 86400000).toISOString().slice(0, 10));
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

describe('共鸣：每人每句一生一次、全额投喂、匿名与回滚', () => {
  it('扣付款者1鱼干，投稿人全额收到；重复与并发请求只记一次', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    await checkIn(reader.id); // +3 鱼干，让余额有来源（账本不变式的前提）
    const quote = await published(author.id, 'anonymous');

    const results = await Promise.all([resonateQuote(quote.id, reader.id), resonateQuote(quote.id, reader.id)]);
    // 恰好一次真正写入：另一个请求要么读到已写下的资格行，要么撞联合主键后幂等返回。
    expect(results.filter((r) => !r.already_resonated)).toHaveLength(1);
    expect(results.every((r) => r.resonated && !r.can_resonate && r.resonance_count === 1)).toBe(true);
    const replay = await resonateQuote(quote.id, reader.id);
    expect(replay).toMatchObject({ already_resonated: true, resonated: true, can_resonate: false, resonance_count: 1 });

    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).driedFish)).toBe(2);
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: author.id } })).driedFish)).toBe(1);
    // 明细只一行（审计），累计资格也只一行（判据与人数）。
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(1);
    const payerLedger = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: reader.id, type: 'quote_resonance' } });
    expect(payerLedger.relatedUserId).toBeNull();
    const dto = await quoteView(quote, reader.id);
    expect(dto.resonated).toBe(true); expect(dto.can_resonate).toBe(false); expect(dto.resonance_count).toBe(1);
    await expectLedgerConsistent();
  });
  it('余额不足全部回滚，补足后仍可共鸣；作者入账失败也不扣钱', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    const quote = await published(author.id);
    await expect(resonateQuote(quote.id, reader.id)).rejects.toMatchObject({ status: 400 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(0);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await checkIn(reader.id);
    await prisma.user.update({ where: { id: author.id }, data: { role: 'user' } });
    await expect(resonateQuote(quote.id, reader.id)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(0);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(1); // 只有签到那一笔
    // 恢复作者资格后仍能首访成功，且钱只扣一次。
    await prisma.user.update({ where: { id: author.id }, data: { role: 'core' } });
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: false, resonance_count: 1 });
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: author.id } })).driedFish)).toBe(1);
    await expectLedgerConsistent();
  });
  it('经典免费；跨 UTC+8 零点仍幂等；不能给自己投喂', async () => {
    const reader = await makeUser({ role: 'core' });
    const quote = await builtin();
    await publish('2026-10-21', quote.id);
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: false, resonance_count: 1 });
    vi.setSystemTime(new Date('2026-10-21T16:00:00Z')); // 跨过 UTC+8 零点 → 2026-10-22
    expect(todayStr()).toBe('2026-10-22');
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: true, resonated: true, resonance_count: 1 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(1);
    expect(await prisma.fishTransaction.count()).toBe(0);
    const own = await community(reader.id);
    await publish('2026-10-22', own.id);
    await expect(resonateQuote(own.id, reader.id)).rejects.toMatchObject({ status: 400 });
    await expectLedgerConsistent();
  });
  it('付费共鸣跨日不再扣款：明细一行、双方余额不变', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    await checkIn(reader.id);
    const quote = await published(author.id);
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: false, resonance_count: 1 });
    vi.setSystemTime(new Date('2026-10-21T16:00:00Z'));
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({
      already_resonated: true, resonated: true, can_resonate: false, resonance_count: 1,
    });
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).driedFish)).toBe(2);
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: author.id } })).driedFish)).toBe(1);
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(1);
    await expectLedgerConsistent();
  });
  it('取消收藏、重新收藏都不会恢复共鸣资格', async () => {
    const author = await makeUser({ role: 'core' });
    const reader = await makeUser({ role: 'core' });
    await checkIn(reader.id);
    const quote = await published(author.id);
    await resonateQuote(quote.id, reader.id);
    await saveQuote(quote.id, reader.id, true);
    await saveQuote(quote.id, reader.id, false);
    await saveQuote(quote.id, reader.id, true);
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: true, resonance_count: 1 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    expect(unitsToFish((await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).driedFish)).toBe(2);
    const dto = await quoteView(quote, reader.id);
    expect(dto).toMatchObject({ resonated: true, favorited: true, can_resonate: false });
    await expectLedgerConsistent();
  });
  it('90 天后再入选同一句：仍显示已共鸣、不能再付一次', async () => {
    const reader = await makeUser({ role: 'core' });
    const quote = await builtin('九十天后再次入选');
    await publish('2026-10-21', quote.id);
    await checkIn(reader.id);
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(quote.id);
    await resonateQuote(quote.id, reader.id);

    vi.setSystemTime(new Date('2027-01-20T02:00:00Z')); // 第 91 天（UTC+8 的 2027-01-20）
    expect(todayStr()).toBe('2027-01-20');
    await checkIn(reader.id);
    const again = await getTodayQuote(reader.id);
    expect(again.day).toBe('2027-01-20');
    expect(again.quote).toMatchObject({ id: quote.id, resonated: true, can_resonate: false, resonance_count: 1 });
    expect(await resonateQuote(quote.id, reader.id)).toMatchObject({ already_resonated: true, resonance_count: 1 });
    expect(await prisma.dailyQuoteResonance.count()).toBe(1);
    expect(await prisma.dailyQuoteResonanceOnce.count()).toBe(1);
    await expectLedgerConsistent();
  });
});

describe('往期一言：只读、按日倒序、缺日不补、批量状态', () => {
  it('只列过去实际用过的期；排除今天与未来；缺日不补；查询不创建 edition', async () => {
    const reader = await makeUser({ role: 'core' });
    const a = await builtin(); const b = await builtin(); const c = await builtin();
    await publish('2026-10-20', a.id);
    await publish('2026-10-18', b.id); // 10-19、10-17、10-16 没有选用记录 → 历史里也不该有
    await publish('2026-10-15', c.id);
    await publish('2026-10-21', a.id); // 今天：不属于往期
    await publish('2026-10-25', b.id); // 未来（脏数据）：同样不得出现
    const before = await prisma.dailyQuoteEdition.count();

    const result = await listQuoteHistory(reader.id);
    expect(result).toMatchObject({ page: 1, pages: 1, total: 3 });
    expect(result.editions.map((item) => item.day)).toEqual(['2026-10-20', '2026-10-18', '2026-10-15']);
    expect(result.editions.every((item) => item.quote !== null)).toBe(true);
    // 纯读取：不补抽、不创建任何 edition。
    expect(await prisma.dailyQuoteEdition.count()).toBe(before);
  });
  it('下架 / 待审 / 作者归档：日期保留，内容为 null', async () => {
    const reader = await makeUser({ role: 'core' });
    const author = await makeUser({ role: 'core' });
    const retired = await community(author.id);
    await publish('2026-10-20', retired.id);
    const visible = await builtin();
    await publish('2026-10-19', visible.id);
    const pending = await community(author.id);
    await prisma.dailyQuote.update({ where: { id: pending.id }, data: { status: 'pending' } });
    await publish('2026-10-18', pending.id);
    const goneAuthor = await makeUser({ role: 'core' });
    const orphan = await community(goneAuthor.id);
    await publish('2026-10-17', orphan.id);
    await prisma.dailyQuote.update({ where: { id: retired.id }, data: { status: 'retired' } });
    await prisma.user.update({ where: { id: goneAuthor.id }, data: { archivedAt: nowForDb() } });

    const result = await listQuoteHistory(reader.id);
    expect(result.editions.map((item) => item.day)).toEqual(['2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17']);
    expect(result.editions.find((item) => item.day === '2026-10-19')?.quote?.id).toBe(visible.id);
    expect(result.editions.filter((item) => item.day !== '2026-10-19').every((item) => item.quote === null)).toBe(true);
  });
  it('批量装配本人状态与人数；归档账号的旧共鸣不计入人数', async () => {
    const reader = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    const q1 = await builtin(); const q2 = await builtin();
    await publish('2026-10-20', q1.id);
    await publish('2026-10-19', q2.id);
    await resonateQuote(q1.id, reader.id);
    await resonateQuote(q1.id, other.id);
    await saveQuote(q2.id, reader.id, true);
    // 归档账号的历史共鸣：资格行保留（恢复后不能重新共鸣），但不计入显示人数。
    const archived = await makeUser({ role: 'core' });
    await prisma.user.update({ where: { id: archived.id }, data: { archivedAt: nowForDb() } });
    await prisma.dailyQuoteResonanceOnce.create({ data: { quoteId: q2.id, userId: archived.id, firstResonatedAt: nowForDb() } });

    const result = await listQuoteHistory(reader.id);
    const first = result.editions.find((item) => item.day === '2026-10-20')!.quote!;
    const second = result.editions.find((item) => item.day === '2026-10-19')!.quote!;
    expect(first).toMatchObject({ id: q1.id, resonated: true, can_resonate: false, favorited: false, resonance_count: 2 });
    expect(second).toMatchObject({ id: q2.id, resonated: false, can_resonate: true, favorited: true, resonance_count: 0 });
    await expectLedgerConsistent();
  });
  it('分页：每页20期、倒序连续；越界页码归一到有效末页；非法页码回第一页', async () => {
    const reader = await makeUser({ role: 'core' });
    const days = daysBefore('2026-10-20', 21);
    for (const day of days) await publish(day, (await builtin()).id);

    const first = await listQuoteHistory(reader.id, 1);
    expect(first).toMatchObject({ page: 1, pages: 2, total: 21 });
    expect(first.editions).toHaveLength(20);
    expect(first.editions[0].day).toBe('2026-10-20');
    expect(first.editions[19].day).toBe('2026-10-01');

    const last = await listQuoteHistory(reader.id, 2);
    expect(last).toMatchObject({ page: 2, pages: 2, total: 21 });
    expect(last.editions.map((item) => item.day)).toEqual(['2026-09-30']);

    // 越界 / 非法页码都收敛到有效页，而不是空列表。
    expect(await listQuoteHistory(reader.id, 999)).toMatchObject({ page: 2, total: 21 });
    expect(await listQuoteHistory(reader.id, 0)).toMatchObject({ page: 1 });
    expect(await listQuoteHistory(reader.id, -3)).toMatchObject({ page: 1 });
    expect(await listQuoteHistory(reader.id, Number.NaN)).toMatchObject({ page: 1 });
  });
  it('空历史：page=1、pages=0，不报错也不补抽', async () => {
    const reader = await makeUser({ role: 'core' });
    const result = await listQuoteHistory(reader.id, 3);
    expect(result).toEqual({ page: 1, pages: 0, total: 0, editions: [] });
    expect(await prisma.dailyQuoteEdition.count()).toBe(0);
  });
});

describe('投稿审核与私密一言集', () => {
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
    await publish('2026-10-20', quote.id);
    await saveQuote(quote.id, a.id, true); await saveQuote(quote.id, a.id, true);
    expect((await listSavedQuotes(a.id)).total).toBe(1);
    expect((await listSavedQuotes(b.id)).total).toBe(0);
    await saveQuote(quote.id, a.id, false); await saveQuote(quote.id, a.id, true);
    expect(await prisma.dailyQuoteFavorite.count()).toBe(1);
    expect((await listSavedQuotes(a.id)).quotes[0]).toMatchObject({ id: quote.id, last_day: '2026-10-20' });
    await prisma.dailyQuote.update({ where: { id: quote.id }, data: { status: 'retired' } });
    // 下架：内容不可展示，但日期与「可移出」的能力都保留。
    expect((await listSavedQuotes(a.id)).quotes[0]).toMatchObject({ id: quote.id, quote: null, last_day: '2026-10-20' });
    await saveQuote(quote.id, a.id, false);
    expect((await listSavedQuotes(a.id)).total).toBe(0);
  });
  it('一言集带最近入选日期；分页收敛；批量状态与今日入口一致', async () => {
    const reader = await makeUser({ role: 'core' });
    const days = daysBefore('2026-10-20', 21);
    const quotes = [];
    for (let i = 0; i < 21; i++) {
      const quote = await builtin();
      quotes.push(quote);
      await publish(days[i], quote.id);
      // 收藏时间显式错开：冻结时钟下 createdAt 全相同会让分页排序不确定。
      await prisma.dailyQuoteFavorite.create({ data: {
        userId: reader.id, quoteId: quote.id,
        createdAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60000),
      } });
    }
    // 最近入选日期 = 该内容所有 edition 里最大的 day（不是收藏时间）。
    await publish('2026-10-21', quotes[20].id);
    await resonateQuote(quotes[20].id, reader.id);

    const first = await listSavedQuotes(reader.id, 1);
    expect(first).toMatchObject({ page: 1, pages: 2, total: 21 });
    expect(first.quotes).toHaveLength(20);
    expect(first.quotes[0]).toMatchObject({
      id: quotes[20].id, last_day: '2026-10-21', quote: { resonated: true, can_resonate: false, favorited: true, resonance_count: 1 },
    });
    expect(first.quotes[1]).toMatchObject({ id: quotes[19].id, last_day: '2026-10-01' });

    const last = await listSavedQuotes(reader.id, 2);
    expect(last).toMatchObject({ page: 2, pages: 2, total: 21 });
    expect(last.quotes).toHaveLength(1);
    expect(last.quotes[0].id).toBe(quotes[0].id); // 最早收藏 → 第二页
    expect(await listSavedQuotes(reader.id, 99)).toMatchObject({ page: 2, total: 21 });
    expect(await listSavedQuotes(reader.id, 0)).toMatchObject({ page: 1 });
    expect(await listSavedQuotes(reader.id, Number.NaN)).toMatchObject({ page: 1 });
    await expectLedgerConsistent();
  });
});
