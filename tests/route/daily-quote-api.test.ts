import { beforeEach, describe, it, expect, vi } from 'vitest';
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) =>
  name === 'raricy_session' && session.token ? { value: session.token } : undefined }) }));

import { resetDb, makeUser, prisma } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { checkIn } from '@/lib/checkin-service';
import { submitQuote, quoteContentKey, quoteReviewVersion } from '@/lib/daily-quote-service';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { dayStart, nowForDb, todayStr } from '@/lib/db-time';
import { GET as today } from '@/app/api/daily-quotes/today/route';
import { GET as history } from '@/app/api/daily-quotes/history/route';
import { GET as mine, POST as submit } from '@/app/api/daily-quotes/submissions/route';
import { PATCH as edit } from '@/app/api/daily-quotes/submissions/[id]/route';
import { PATCH as review } from '@/app/api/admin/daily-quotes/[id]/route';
import { POST as resonate } from '@/app/api/daily-quotes/[id]/resonance/route';
import { POST as favorite, DELETE as unfavorite } from '@/app/api/daily-quotes/[id]/favorite/route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (data: unknown, method = 'POST') => new Request('http://localhost/api/daily-quotes/submissions', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const historyRequest = (search = '') => new Request(`http://localhost/api/daily-quotes/history${search}`);
const input = { content: '接口测试的一句话', category: '治愈', source_type: 'original', signature: 'anonymous' };
async function login(id: string) { session.token = await createSessionToken({ uid: id, sv: 0 }); }
async function reviewCurrent(id: string, action: string, reason = '') {
  const quote = await prisma.dailyQuote.findUniqueOrThrow({ where: { id } });
  return review(body({ action, reason, version: quoteReviewVersion(quote) }, 'PATCH'), ctx(id));
}
/** 第 n 天前的 UTC+8 日期（按本站时钟算，不写死具体日期 —— 用例不会随真实日期漂移变红）。 */
const pastDay = (n: number) => new Date(dayStart(todayStr()).getTime() - n * 86400000).toISOString().slice(0, 10);

beforeEach(async () => { await resetDb(); __resetRateLimitStore(); session.token = undefined; });

describe('每日一言的HTTP权限、隐私与输入', () => {
  it('所有接口未登录401，普通用户403；core不能审核', async () => {
    const handlers = [() => today(), () => history(historyRequest()), () => mine(), () => submit(body(input)),
      () => edit(body(input, 'PATCH'), ctx('missing')), () => review(body({ action: 'approve' }, 'PATCH'), ctx('missing')),
      () => resonate(body({}), ctx('missing')), () => favorite(body({}), ctx('missing')), () => unfavorite(body({}, 'DELETE'), ctx('missing'))];
    for (const handler of handlers) expect((await handler()).status).toBe(401);
    const plain = await makeUser(); await login(plain.id);
    for (const handler of handlers) expect((await handler()).status).toBe(403);
    const core = await makeUser({ role: 'core' }); await login(core.id);
    expect((await review(body({ action: 'approve' }, 'PATCH'), ctx('missing'))).status).toBe(403);
  });
  it('禁言拦住全部写操作；无效JSON报400；投稿每天最多5次', async () => {
    const user = await makeUser({ role: 'core', isBanned: true }); await login(user.id);
    expect((await submit(body(input))).status).toBe(403);
    expect((await edit(body(input, 'PATCH'), ctx('missing'))).status).toBe(403);
    expect((await resonate(body({}), ctx('missing'))).status).toBe(403);
    expect((await favorite(body({}), ctx('missing'))).status).toBe(403);
    expect((await unfavorite(body({}, 'DELETE'), ctx('missing'))).status).toBe(403);
    // 只读的往期接口不受禁言影响：禁言是「不能说话」，不是「不能回看历史」。
    expect((await history(historyRequest())).status).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { isBanned: false } });
    expect((await submit(new Request('http://localhost', { method: 'POST', body: '{' }))).status).toBe(400);
    expect((await edit(new Request('http://localhost', { method: 'PATCH', body: '{' }), ctx('missing'))).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await submit(body({ ...input, content: `${input.content}${i}` }))).status).toBe(200);
    expect((await submit(body({ ...input, content: '第六次投稿' }))).status).toBe(429);
  });
  it('作者可保存待审投稿，读回所有编辑字段；他人无法编辑，审核通过后返回409', async () => {
    const author = await makeUser({ role: 'core' });
    const quote = await submitQuote(author.id, input);
    const other = await makeUser({ role: 'core' }); await login(other.id);
    expect((await edit(body({ ...input, content: '他人改稿' }, 'PATCH'), ctx(quote.id))).status).toBe(404);
    await login(author.id);
    const changed = { content: '作者修改后的稿件', category: '哲思', signature: 'nickname', source_type: 'quotation', source_name: '作品出处' };
    const response = await edit(body(changed, 'PATCH'), ctx(quote.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ submission: { id: quote.id, status: 'pending' } });
    expect((await (await mine()).json()).submissions).toEqual([expect.objectContaining({ ...changed, id: quote.id, status: 'pending' })]);
    expect((await edit(body({ ...changed, content: '字'.repeat(51) }, 'PATCH'), ctx(quote.id))).status).toBe(400);
    const admin = await makeUser({ role: 'admin' }); await login(admin.id);
    expect((await reviewCurrent(quote.id, 'approve')).status).toBe(200);
    await login(author.id);
    expect((await edit(body(changed, 'PATCH'), ctx(quote.id))).status).toBe(409);
  });
  it('未签到不可取一言；响应不含匿名身份、待审内容或其他人的投稿', async () => {
    const author = await makeUser({ role: 'core' });
    await submitQuote(author.id, input);
    const user = await makeUser({ role: 'core' }); await login(user.id);
    expect((await today()).status).toBe(403);
    await prisma.dailyQuote.create({ data: {
      id: 'classic', kind: 'builtin', content: '内置的原文', contentKey: quoteContentKey('内置的原文'), category: '哲思',
      sourceType: 'quotation', sourceName: '典籍', authorName: '古人', status: 'approved', createdAt: nowForDb(),
    } });
    await checkIn(user.id);
    const response = await today();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const data = await response.json();
    expect(data.quote.content).toBe('内置的原文');
    expect(data.quote).not.toHaveProperty('submitterId');
    expect((await (await mine()).json()).submissions).toEqual([]);
    expect(JSON.stringify(data)).not.toContain(author.id);
  });

  it('往期接口：core+ 分页结构、no-store、排除今天，且不泄露投稿人身份', async () => {
    // 显式给用户名：默认用户名是 `u_<id>`，含 id 子串，会让「响应不含投稿人 id」的断言失效。
    const author = await makeUser({ role: 'core', username: 'history-author' });
    const classic = { id: 'history-classic', kind: 'builtin', content: '往期经典', contentKey: quoteContentKey('往期经典'),
      category: '哲思', sourceType: 'quotation', sourceName: '典籍', authorName: '古人' };
    const named = { id: 'history-named', kind: 'community', content: '往期署名投稿', contentKey: quoteContentKey('往期署名投稿'),
      category: '治愈', signature: 'nickname', sourceType: 'original', submitterId: author.id };
    const anon = { id: 'history-anon', kind: 'community', content: '往期匿名投稿', contentKey: quoteContentKey('往期匿名投稿'),
      category: '治愈', signature: 'anonymous', sourceType: 'original', submitterId: author.id };
    for (const quote of [classic, named, anon]) {
      await prisma.dailyQuote.create({ data: { ...quote, status: 'approved', createdAt: nowForDb() } });
    }
    await prisma.dailyQuoteEdition.create({ data: { day: pastDay(1), quoteId: classic.id, createdAt: nowForDb() } });
    await prisma.dailyQuoteEdition.create({ data: { day: pastDay(2), quoteId: named.id, createdAt: nowForDb() } });
    await prisma.dailyQuoteEdition.create({ data: { day: pastDay(3), quoteId: anon.id, createdAt: nowForDb() } });
    // 今天的期不属于往期（否则它就是绕过签到的今日读口）。
    await prisma.dailyQuoteEdition.create({ data: { day: todayStr(), quoteId: classic.id, createdAt: nowForDb() } });

    const reader = await makeUser({ role: 'core' }); await login(reader.id);
    const response = await history(historyRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const data = await response.json();
    expect(data).toMatchObject({ code: 200, page: 1, pages: 1, total: 3 });
    expect(data.editions.map((item: { day: string }) => item.day)).toEqual([pastDay(1), pastDay(2), pastDay(3)]);
    expect(data.editions.every((item: { quote: unknown }) => item.quote !== null)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('submitterId');
    expect(JSON.stringify(data)).not.toContain(author.id);
    const anonymousEntry = data.editions.find((item: { quote: { id: string } | null }) => item.quote?.id === anon.id);
    expect(anonymousEntry.quote).toMatchObject({ author: '匿名', submitter_name: '匿名' });
    expect(JSON.stringify(anonymousEntry)).not.toContain(author.username);

    // 页码非法 / 越界都由服务层收敛到有效页，不返回空列表也不 500。
    expect((await (await history(historyRequest('?page=999'))).json()).page).toBe(1);
    expect((await (await history(historyRequest('?page=abc'))).json()).page).toBe(1);
    expect((await (await history(historyRequest('?page=-2'))).json()).page).toBe(1);
  });

  // 审核的三条成功路径。**这里的价值在「真的写了一条审计日志」**：早先只测了 401/403/400，
  // 一条都没走到 adminActionLog.create，于是「create 没带 select、真库回读 JSON 列抛 P2023、
  // 整个事务回滚」这个线上故障在测试里全程是绿的（见 tests/unit/audit-json-column-guard.test.ts）。
  it('审核通过与拒绝写入状态与内部审计日志，匿名拒绝不外泄当事人', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const named = await submitQuote(author.id, { ...input, signature: 'nickname' });
    const anon = await submitQuote(author.id, { ...input, content: '匿名投稿的一句话', signature: 'anonymous' });
    await login(admin.id);

    expect((await reviewCurrent(named.id, 'approve')).status).toBe(200);
    expect((await reviewCurrent(anon.id, 'reject', '不予收录')).status).toBe(200);

    const rows = await prisma.dailyQuote.findMany({
      where: { id: { in: [named.id, anon.id] } }, select: { id: true, status: true, reviewReason: true, reviewerId: true },
    });
    expect(rows.find((r) => r.id === named.id)).toMatchObject({ status: 'approved', reviewerId: admin.id });
    expect(rows.find((r) => r.id === anon.id)).toMatchObject({ status: 'rejected', reviewReason: '不予收录' });

    const logs = await prisma.adminActionLog.findMany({
      where: { objectType: 'daily_quote', objectId: { in: [named.id, anon.id] } },
      select: { action: true, visibility: true, hideTarget: true, targetUserId: true },
    });
    expect(logs).toHaveLength(2);
    // 待审内容与拒绝原因属作者隐私：只进内部日志，不进 /audit 公示面
    expect(logs.every((l) => l.visibility === 'internal')).toBe(true);
    expect(logs.find((l) => l.action === 'daily_quote_approve')).toMatchObject({ hideTarget: false, targetUserId: author.id });
    // 匿名稿件的那条日志必须打上 hideTarget，否则 /audit 详情会把作者交代出去
    expect(logs.find((l) => l.action === 'daily_quote_reject')).toMatchObject({ hideTarget: true, targetUserId: author.id });

    // 已通过的稿件不能再通过（状态 CAS），且不去重写日志
    expect((await reviewCurrent(named.id, 'approve')).status).toBe(409);
  });

  it('内置稿件可下架，且拒绝与下架必须填原因', async () => {
    const admin = await makeUser({ role: 'admin' });
    await prisma.dailyQuote.create({ data: {
      id: 'builtin-probe', kind: 'builtin', content: '待下架的内置原文', contentKey: quoteContentKey('待下架的内置原文'),
      category: '哲思', sourceType: 'quotation', sourceName: '典籍', authorName: '古人', status: 'approved', createdAt: nowForDb(),
    } });
    const pending = await submitQuote((await makeUser({ role: 'core' })).id, input);
    await login(admin.id);

    expect((await reviewCurrent('builtin-probe', 'retire', '  ')).status).toBe(400);
    expect((await reviewCurrent('builtin-probe', 'retire', '内容重复')).status).toBe(200);
    expect((await reviewCurrent(pending.id, 'reject')).status).toBe(400);

    const builtin = await prisma.dailyQuote.findUnique({ where: { id: 'builtin-probe' }, select: { status: true } });
    expect(builtin?.status).toBe('retired');
    // 内置稿件没有投稿人 → 日志的 targetUserId 是 null（也因此不可申诉）
    const log = await prisma.adminActionLog.findFirst({
      where: { objectType: 'daily_quote', objectId: 'builtin-probe' }, select: { action: true, targetUserId: true },
    });
    expect(log).toMatchObject({ action: 'daily_quote_retire', targetUserId: null });
  });

  it('审核必须携带页面版本；作者改动任一字段后旧版本不能通过或拒绝', async () => {
    const author = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });
    const quote = await submitQuote(author.id, input);
    const snapshot = quoteReviewVersion(await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } }));
    await login(author.id);
    expect((await edit(body({ ...input, signature: 'nickname' }, 'PATCH'), ctx(quote.id))).status).toBe(200);
    await login(admin.id);
    expect((await review(body({ action: 'approve' }, 'PATCH'), ctx(quote.id))).status).toBe(400);
    for (const action of ['approve', 'reject']) {
      const response = await review(body({ action, reason: '审核说明', version: snapshot }, 'PATCH'), ctx(quote.id));
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain('稿件已被作者修改');
    }
    expect((await prisma.dailyQuote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('pending');
    expect(await prisma.adminActionLog.count()).toBe(0);
    expect((await reviewCurrent(quote.id, 'approve')).status).toBe(200);
  });
});
