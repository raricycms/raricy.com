import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { hashPassword, verifyPassword } from '@/lib/password';
import { createAuthorizationCode, validateAccessToken } from '@/lib/oauth';
import { POST } from '@/app/api/oauth/token/route';

// 密码计算是昂贵边界：默认替身便于用真实配额跑满窗口；另有一条使用真实 scrypt。
vi.mock('@/lib/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/password')>();
  return { ...actual, verifyPassword: vi.fn() };
});

const verify = vi.mocked(verifyPassword);
const CALLBACK = 'https://app.example.com/cb';
const SECRET = 'test-client-secret';
type Format = 'json' | 'form' | 'basic';

function request(clientId: string, secret = 'wrong', format: Format = 'json', extra = {}) {
  const body = { client_id: clientId, client_secret: secret, grant_type: 'authorization_code', ...extra };
  if (format === 'form') {
    return new Request('https://raricy.test/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  }
  return new Request('https://raricy.test/api/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(format === 'basic'
        ? { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function makeApp(clientId = 'test-client') {
  const owner = await makeUser({ role: 'owner' });
  const application = await prisma.oAuthApplication.create({
    data: { id: clientId, clientId, clientSecretHash: 'fixture-hash', name: 'test-app',
      redirectUris: JSON.stringify([CALLBACK]), createdById: owner.id, createdAt: nowForDb() },
  });
  return { application, owner };
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  verify.mockReset();
  verify.mockImplementation(async (secret) => secret === SECRET);
});
afterEach(() => vi.useRealTimers());

describe('OAuth token 密码计算前限频', () => {
  it.each<Format>(['json', 'form', 'basic'])('%s：错误密钥也计数，超额时不再验证密码', async (format) => {
    const { application } = await makeApp();
    for (let i = 0; i < 60; i++) {
      const res = await POST(request(application.clientId, 'wrong', format));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    }
    for (let i = 0; i < 5; i++) {
      const res = await POST(request(application.clientId, 'wrong', format));
      // 沿用已有 OAuth 限频的 invalid_request / 400 形状。
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_request', error_description: '请求过于频繁，请稍后再试' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(verify).toHaveBeenCalledTimes(60);
  });

  it('Basic 凭据优先；改变 body.client_id 或请求格式不能换桶', async () => {
    const { application } = await makeApp();
    for (let i = 0; i < 60; i++) {
      const res = await POST(request(application.clientId, 'wrong', i % 2 ? 'json' : 'form'));
      expect(res.status).toBe(401);
    }
    const res = await POST(request(application.clientId, 'wrong', 'basic', {
      client_id: 'a-different-body-client', client_secret: SECRET,
    }));
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(verify).toHaveBeenCalledTimes(60);
  });

  it('65 个并发错误请求最多运行 60 次密码校验', async () => {
    const { application } = await makeApp();
    const results = await Promise.all(Array.from({ length: 65 }, () => POST(request(application.clientId))));
    expect(results.filter((r) => r.status === 401)).toHaveLength(60);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(verify).toHaveBeenCalledTimes(60);
  });

  it('正确密钥也计数；额度满后不能先烧密码计算再拒绝', async () => {
    const { application } = await makeApp();
    for (let i = 0; i < 60; i++) {
      // 密钥正确但缺少 code；校验通过后返回 invalid_request。
      const res = await POST(request(application.clientId, SECRET));
      expect(await res.json()).toMatchObject({ error: 'invalid_request', error_description: '缺少 code 或 redirect_uri' });
    }
    const res = await POST(request(application.clientId, SECRET));
    expect(await res.json()).toMatchObject({ error_description: '请求过于频繁，请稍后再试' });
    expect(verify).toHaveBeenCalledTimes(60);
  });

  it('每个应用独立计数，60 秒窗口过去后恢复密码校验', async () => {
    const { application } = await makeApp();
    const { application: other } = await makeApp('other-client');
    for (let i = 0; i < 60; i++) await POST(request(application.clientId));
    expect((await POST(request(other.clientId))).status).toBe(401);
    expect((await POST(request(application.clientId))).status).toBe(400);
    vi.setSystemTime(new Date('2026-10-09T12:01:00Z'));
    expect((await POST(request(application.clientId))).status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(62);
  });

  it('额度内仍可正常兑换授权码，错误密钥不消费授权码', async () => {
    const { application, owner } = await makeApp();
    const { code } = await createAuthorizationCode(application.id, owner.id, CALLBACK, ['profile']);
    const fields = { code, redirect_uri: CALLBACK };
    expect((await POST(request(application.clientId, 'wrong', 'json', fields))).status).toBe(401);
    const res = await POST(request(application.clientId, SECRET, 'basic', fields));
    expect(res.status).toBe(200);
    const minted = await res.json();
    expect(minted).toMatchObject({ token_type: 'Bearer', scope: 'profile' });
    expect(await validateAccessToken(minted.access_token)).toMatchObject({ userId: owner.id });
    expect((await POST(request(application.clientId, SECRET, 'json', fields))).status).toBe(400);
    expect(await prisma.oAuthAccessToken.count()).toBe(1);
  });

  it('真实 scrypt：60 次错误密钥后停止运行哈希', async () => {
    const actual = await vi.importActual<typeof import('@/lib/password')>('@/lib/password');
    verify.mockImplementation(actual.verifyPassword);
    const { application } = await makeApp();
    await prisma.oAuthApplication.update({ where: { id: application.id }, data: { clientSecretHash: await hashPassword(SECRET) } });
    for (let i = 0; i < 60; i++) expect((await POST(request(application.clientId))).status).toBe(401);
    expect((await POST(request(application.clientId))).status).toBe(400);
    expect(verify).toHaveBeenCalledTimes(60);
  }, 20000);
});
