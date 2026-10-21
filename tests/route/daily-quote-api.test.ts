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
});
