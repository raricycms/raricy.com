import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser as makeBareUser, makeBlog, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';
import { checkIn } from '@/lib/checkin-service';
import { nowForDb, todayStr } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { getTodayQuote, quoteContentKey, quoteView, resonateQuote, submitQuote, reviewQuote, quoteReviewVersion,
  saveQuote, listSavedQuotes, listQuoteHistory, listSubmissions, editQuoteSubmission, listReviewQuotes,
  ensureEditionForDay, __resetDailyQuoteIssuanceState } from '@/lib/daily-quote-service';

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
  await resetDb(); __resetRateLimitStore(); __resetDailyQuoteIssuanceState();
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
      // P03：每天的发行由后台任务触发；测试里显式模拟启动钩子/定时器。
      await ensureEditionForDay(todayStr());
      expect((await getTodayQuote(reader.id)).quote?.id).toBe(id);
    }
    vi.setSystemTime(new Date('2027-01-30T02:00:00Z')); await checkIn(reader.id);
    await ensureEditionForDay(todayStr());
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(classic.id);
    for (const q of [q1, q2, q3]) expect(await prisma.dailyQuoteEdition.count({ where: { quoteId: q.id } })).toBe(1);
    expect((await listSubmissions(a.id)).every((q) => q.display_status === 'selected')).toBe(true);
    await expectLedgerConsistent();
  });

  it('作者降级或禁言暂停候选；删光博客不再暂停候选（P03 只留账号资格）', async () => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await content(author.id); const classic = await content();
    // 降级 / 禁言：账号资格不满足 → 只发经典。
    for (const [i, data] of [{ role: 'user' }, { role: 'core', isBanned: true }].entries()) {
      await prisma.user.update({ where: { id: author.id }, data });
      vi.setSystemTime(new Date(`2026-10-${21 + i}T02:00:00Z`)); await checkIn(reader.id);
      await ensureEditionForDay(todayStr());
      expect((await getTodayQuote(reader.id)).quote?.id).toBe(classic.id);
    }
    // 恢复账号资格后**删光博客**：P03 决定不再把「名下有未删除博客」当候选判据
    // （博客要求只留在参与门槛），社区稿仍应被选登。
    await prisma.user.update({ where: { id: author.id }, data: { role: 'core', isBanned: false } });
    await prisma.blog.updateMany({ where: { authorId: author.id }, data: { ignore: true } });
    vi.setSystemTime(new Date('2026-10-23T02:00:00Z')); await checkIn(reader.id);
    await ensureEditionForDay(todayStr());
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(quote.id);
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).firstSelectedDay).toBe('2026-10-23');
    await expectLedgerConsistent();
  });

  it('发行失败不消耗社区稿；重复调度同一天只认领一次', async () => {
    const author = await makeUser(); const reader = await makeUser(); const quote = await content(author.id);
    await content(); await checkIn(reader.id);
    await prisma.$executeRawUnsafe("CREATE TRIGGER quote_edition_failure BEFORE INSERT ON daily_quote_editions BEGIN SELECT RAISE(ABORT,'edition failed'); END");
    try {
      const failed = await ensureEditionForDay(todayStr());
      expect(failed.status).toBe('failed');
      // 失败态可由读口区分，且进程不崩。
      expect((await getTodayQuote(reader.id)).state).toBe('failed');
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER quote_edition_failure'); }
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).firstSelectedDay).toBeNull();
    expect(await prisma.dailyQuoteEdition.count()).toBe(0);

    // 下一次调度重试（并发两次）：只产生一条 edition、只认领一次。
    const results = await Promise.all([ensureEditionForDay(todayStr()), ensureEditionForDay(todayStr())]);
    expect(results.every((result) => result.status === 'published' && result.quoteId === quote.id)).toBe(true);
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
    expect(await prisma.dailyQuoteEdition.count({ where: { quoteId: quote.id } })).toBe(1);
    expect((await getTodayQuote(reader.id)).state).toBe('published');
  });

  it('无博客 core 仍可读、可投稿，稿件也能进候选池（P02 取消发文条件）', async () => {
    const user = await makeBareUser({ role: 'core' }); const classic = await content();
    const own = await content(user.id); // 本人已通过但从未选登的社区稿
    // P02：阅读 / 参与 / 投稿 / 选稿都不再要求「名下有未删除博客」。
    await checkIn(user.id);
    expect((await listQuoteHistory(user.id)).total).toBe(0);
    expect(await listSavedQuotes(user.id)).toMatchObject({ total: 0 });
    expect(await listSubmissions(user.id)).toMatchObject([{ id: own.id, display_status: 'approved' }]);
    expect((await submitQuote(user.id, input)).id).toBeTruthy();
    await expect(editQuoteSubmission('missing', user.id, input)).rejects.toMatchObject({ status: 404 });
    // 选稿：无博客不影响候选资格 → 今天的期可以选中本人的社区稿。
    await ensureEditionForDay(todayStr());
    expect((await getTodayQuote(user.id)).quote?.id).toBe(own.id);
    expect(classic.id).not.toBe(own.id);
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: own.id } })).firstSelectedDay).toBe(todayStr());
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
    await checkIn(admin.id); await ensureEditionForDay(todayStr()); expect((await getTodayQuote(admin.id)).quote?.id).toBe(quote.id);
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

// ═══════════════════════════════════════════════════════════════════════════
// P03：每日一言独立发行（发行生命周期 / 只补当天 / 四态读口）
// ═══════════════════════════════════════════════════════════════════════════

describe('P03 独立发行', () => {
  it('同一天重复发行 → 同一句、只有一条记录（幂等）', async () => {
    const author = await makeUser(); const reader = await makeUser();
    const quote = await content(author.id); await content();
    await checkIn(reader.id);
    const [first, second] = await Promise.all([ensureEditionForDay(todayStr()), ensureEditionForDay(todayStr())]);
    expect(first).toMatchObject({ status: 'published', quoteId: quote.id });
    expect(second).toMatchObject({ status: 'published', quoteId: quote.id });
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
    const later = await ensureEditionForDay(todayStr());
    expect(later.quoteId).toBe(quote.id);
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
    expect((await getTodayQuote(reader.id)).quote?.id).toBe(quote.id);
  });

  it('只补当天：请求昨天/明天一律拒绝，且不产生任何记录', async () => {
    const author = await makeUser(); await content(author.id); await content();
    const before = await prisma.dailyQuoteEdition.count();
    for (const day of ['2026-10-20', '2026-10-22']) {
      await expect(ensureEditionForDay(day)).resolves.toMatchObject({ status: 'failed' });
    }
    expect(await prisma.dailyQuoteEdition.count()).toBe(before);
  });

  it('读口四态：尚未发行 pending / 发行成功 published / 内容下架 unavailable', async () => {
    const author = await makeUser(); const reader = await makeUser();
    const quote = await content(author.id); await content();
    await checkIn(reader.id);

    // 尚未发行：读口不选句、不建记录。
    const pending = await getTodayQuote(reader.id);
    expect(pending).toMatchObject({ state: 'pending', quote: null });
    expect(await prisma.dailyQuoteEdition.count()).toBe(0);

    expect((await ensureEditionForDay(todayStr())).status).toBe('published');
    const published = await getTodayQuote(reader.id);
    expect(published).toMatchObject({ state: 'published' });
    expect(published.quote?.id).toBe(quote.id);

    // 内容下架：记录保留，正文变 null。
    await prisma.dailyQuote.update({ where: { id: quote.id }, data: { status: 'retired' } });
    const unavailable = await getTodayQuote(reader.id);
    expect(unavailable).toMatchObject({ state: 'unavailable', quote: null });
    expect(await prisma.dailyQuoteEdition.count()).toBe(1);
  });

  it('发行失败可区分：failed 状态且不消耗社区稿；重试成功后转 published', async () => {
    const author = await makeUser(); const reader = await makeUser();
    const quote = await content(author.id); await content();
    await checkIn(reader.id);
    await prisma.$executeRawUnsafe("CREATE TRIGGER quote_edition_failure2 BEFORE INSERT ON daily_quote_editions BEGIN SELECT RAISE(ABORT,'edition failed'); END");
    try {
      expect((await ensureEditionForDay(todayStr())).status).toBe('failed');
      expect((await getTodayQuote(reader.id)).state).toBe('failed');
      expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).firstSelectedDay).toBeNull();
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER quote_edition_failure2'); }
    expect((await ensureEditionForDay(todayStr())).status).toBe('published');
    expect((await getTodayQuote(reader.id)).state).toBe('published');
  });

  it('启动发行器在测试环境不启动定时器（重复调用安全）', async () => {
    const { startDailyQuotePublisher } = await import('@/lib/daily-quote-service');
    expect(() => { startDailyQuotePublisher(); startDailyQuotePublisher(); }).not.toThrow();
    // 测试环境（VITEST）不发行、不建记录。
    expect(await prisma.dailyQuoteEdition.count()).toBe(0);
  });
});
