import { beforeEach, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { createAuthorizationCode, createAccessToken, revokeUserApplicationTokens } from '@/lib/oauth';
import { POST } from '@/app/api/oauth/token/route';

vi.mock('@/lib/password', async (original) => ({
  ...await original<typeof import('@/lib/password')>(), verifyPassword: async () => true,
}));
const CALLBACK = 'https://app.example.com/cb';
beforeEach(async () => { await resetDb(); __resetRateLimitStore(); });

async function fixture() {
  const user = await makeUser();
  const app = await prisma.oAuthApplication.create({ data: {
    id: 'unbind-app', clientId: 'unbind-client', clientSecretHash: 'fixture', name: 'test',
    redirectUris: JSON.stringify([CALLBACK]), createdById: user.id, createdAt: nowForDb(),
  } });
  return { user, app };
}
function exchange(code: string) {
  return POST(new Request('https://raricy.test/api/oauth/token', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_id: 'unbind-client', client_secret: 'fixture', grant_type: 'authorization_code',
      code, redirect_uri: CALLBACK,
    }),
  }));
}

it('解绑后，未兑换的旧授权码不能重新建立绑定', async () => {
  const { user, app } = await fixture();
  await createAccessToken(app.id, user.id, ['profile']);
  const { code } = await createAuthorizationCode(app.id, user.id, CALLBACK, ['profile']);
  expect(await revokeUserApplicationTokens(user.id, app.id)).toEqual({ found: true, revoked: 1 });
  const response = await exchange(code);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  expect(await prisma.oAuthAccessToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
});

it('只有未兑换授权码时，也能撤销该应用的授权', async () => {
  const { user, app } = await fixture();
  const { code } = await createAuthorizationCode(app.id, user.id, CALLBACK, ['profile']);
  expect(await revokeUserApplicationTokens(user.id, app.id)).toEqual({ found: true, revoked: 0 });
  expect((await exchange(code)).status).toBe(400);
});

it('令牌落库失败不丢失授权码，数据库恢复后可重试兑换', async () => {
  const { user, app } = await fixture();
  const { code } = await createAuthorizationCode(app.id, user.id, CALLBACK, ['profile']);
  await prisma.$executeRawUnsafe("CREATE TRIGGER fail_oauth_token BEFORE INSERT ON oauth_access_tokens BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  await expect(exchange(code)).rejects.toThrow();
  await prisma.$executeRawUnsafe('DROP TRIGGER fail_oauth_token');
  expect((await exchange(code)).status).toBe(200);
});
