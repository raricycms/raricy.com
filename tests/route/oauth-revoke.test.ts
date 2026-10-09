import { beforeEach, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { createOAuthApplication, createAccessToken, validateAccessToken } from '@/lib/oauth';
import { POST } from '@/app/api/oauth/revoke/route';

// 此 CSRF 豁免入口不得依赖 cookie 的权限。
vi.mock('next/headers', () => ({ cookies: () => { throw new Error('不得读取 cookie'); } }));
beforeEach(async () => { await resetDb(); });
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api/oauth/revoke', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

it('只吊销所持原始 token，跨站 cookie 不增加权限，其他令牌不受影响', async () => {
  const owner = await makeUser({ role: 'owner' });
  const { application } = await createOAuthApplication({ name: 'test', redirectUris: ['https://example.com/cb'] }, owner.id);
  const first = await createAccessToken(application.id, owner.id, ['profile']);
  const second = await createAccessToken(application.id, owner.id, ['profile']);
  const res = await POST(request({}, { authorization: `Bearer ${first.token}`, origin: 'https://other.example', cookie: 'raricy_session=irrelevant' }));
  expect(res.status).toBe(200);
  expect(await validateAccessToken(first.token)).toBeNull();
  expect(await validateAccessToken(second.token)).not.toBeNull();
  expect((await POST(request({ token: first.token }))).status).toBe(200);
  expect((await POST(request({ token: 'unknown' }))).status).toBe(200);
});
it.each([null, [], { token: 42 }, { token: {} }])('非法 body %j 返回 400，不写库', async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(await prisma.oAuthAccessToken.count()).toBe(0);
});
