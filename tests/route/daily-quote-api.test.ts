import { beforeEach, describe, it, expect, vi } from 'vitest';
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) =>
  name === 'raricy_session' && session.token ? { value: session.token } : undefined }) }));

import { resetDb, makeUser, prisma } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { checkIn } from '@/lib/checkin-service';
import { submitQuote, quoteContentKey } from '@/lib/daily-quote-service';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { nowForDb } from '@/lib/db-time';
import { GET as today } from '@/app/api/daily-quotes/today/route';
import { GET as mine, POST as submit } from '@/app/api/daily-quotes/submissions/route';
import { PATCH as review } from '@/app/api/admin/daily-quotes/[id]/route';
import { POST as resonate } from '@/app/api/daily-quotes/[id]/resonance/route';
import { POST as favorite, DELETE as unfavorite } from '@/app/api/daily-quotes/[id]/favorite/route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (data: unknown, method = 'POST') => new Request('http://localhost/api/daily-quotes/submissions', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const input = { content: '接口测试的一句话', category: '治愈', source_type: 'original', signature: 'anonymous' };
async function login(id: string) { session.token = await createSessionToken({ uid: id, sv: 0 }); }

beforeEach(async () => { await resetDb(); __resetRateLimitStore(); session.token = undefined; });

describe('每日一言的HTTP权限、隐私与输入', () => {
  it('所有接口未登录401，普通用户403；core不能审核', async () => {
    const handlers = [() => today(), () => mine(), () => submit(body(input)),
      () => review(body({ action: 'approve' }, 'PATCH'), ctx('missing')),
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
    expect((await resonate(body({}), ctx('missing'))).status).toBe(403);
    expect((await favorite(body({}), ctx('missing'))).status).toBe(403);
    expect((await unfavorite(body({}, 'DELETE'), ctx('missing'))).status).toBe(403);
    await prisma.user.update({ where: { id: user.id }, data: { isBanned: false } });
    expect((await submit(new Request('http://localhost', { method: 'POST', body: '{' }))).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await submit(body({ ...input, content: `${input.content}${i}` }))).status).toBe(200);
    expect((await submit(body({ ...input, content: '第六次投稿' }))).status).toBe(429);
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

  // 审核的三条成功路径。**这里的价值在「真的写了一条审计日志」**：早先只测了 401/403/400，
  // 一条都没走到 adminActionLog.create，于是「create 没带 select、真库回读 JSON 列抛 P2023、
  // 整个事务回滚」这个线上故障在测试里全程是绿的（见 tests/unit/audit-json-column-guard.test.ts）。
  it('审核通过与拒绝写入状态与内部审计日志，匿名拒绝不外泄当事人', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const named = await submitQuote(author.id, { ...input, signature: 'nickname' });
    const anon = await submitQuote(author.id, { ...input, content: '匿名投稿的一句话', signature: 'anonymous' });
    await login(admin.id);

    expect((await review(body({ action: 'approve' }, 'PATCH'), ctx(named.id))).status).toBe(200);
    expect((await review(body({ action: 'reject', reason: '不予收录' }, 'PATCH'), ctx(anon.id))).status).toBe(200);

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
    expect((await review(body({ action: 'approve' }, 'PATCH'), ctx(named.id))).status).toBe(409);
  });

  it('内置稿件可下架，且拒绝与下架必须填原因', async () => {
    const admin = await makeUser({ role: 'admin' });
    await prisma.dailyQuote.create({ data: {
      id: 'builtin-probe', kind: 'builtin', content: '待下架的内置原文', contentKey: quoteContentKey('待下架的内置原文'),
      category: '哲思', sourceType: 'quotation', sourceName: '典籍', authorName: '古人', status: 'approved', createdAt: nowForDb(),
    } });
    const pending = await submitQuote((await makeUser({ role: 'core' })).id, input);
    await login(admin.id);

    expect((await review(body({ action: 'retire', reason: '  ' }, 'PATCH'), ctx('builtin-probe'))).status).toBe(400);
    expect((await review(body({ action: 'retire', reason: '内容重复' }, 'PATCH'), ctx('builtin-probe'))).status).toBe(200);
    expect((await review(body({ action: 'reject', reason: '' }, 'PATCH'), ctx(pending.id))).status).toBe(400);

    const builtin = await prisma.dailyQuote.findUnique({ where: { id: 'builtin-probe' }, select: { status: true } });
    expect(builtin?.status).toBe('retired');
    // 内置稿件没有投稿人 → 日志的 targetUserId 是 null（也因此不可申诉）
    const log = await prisma.adminActionLog.findFirst({
      where: { objectType: 'daily_quote', objectId: 'builtin-probe' }, select: { action: true, targetUserId: true },
    });
    expect(log).toMatchObject({ action: 'daily_quote_retire', targetUserId: null });
  });
});
