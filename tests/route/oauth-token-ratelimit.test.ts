import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrypt as _scrypt } from 'node:crypto';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore, recordRateLimitHit } from '@/lib/rate-limit';
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

/**
 * 直填密码预算桶（OAuth 主体档：`password:oauth:<clientId>`，见 password-budget.ts）。
 *
 * 【为什么预填而不是真打满】真实窗额度是 60 次：原本每个用例循环 60 遍只为了把桶填满，
 * 而每次 POST 都要解析请求、查应用、走路由。桶是进程内纯内存计数，直接记命中与
 * 60 次真实请求对限频语义完全等价（`recordRateLimitHit` 就是路由路径用的那个函数）。
 * 本文件仍保留少量真实请求来证明「限频挂在业务路径上」。
 */
function prefillPasswordBucket(subject: string, hits: number) {
  for (let i = 0; i < hits; i++) recordRateLimitHit(`password:${subject}`);
}

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
  it('json / form / basic 三种格式都计数且共用同一个桶；超额后不再验证密码', async () => {
    const { application } = await makeApp();
    // 预填到只剩 3 个额度：三种格式各打一次，证明「换格式不换桶」也证明都计数。
    prefillPasswordBucket(`oauth:${application.clientId}`, 60 - 3);
    for (const format of ['json', 'form', 'basic'] as Format[]) {
      const res = await POST(request(application.clientId, 'wrong', format));
      expect(res.status, format).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    }
    // 第 61 次（换回 json）被限频拦下：不再运行密码校验。
    const blocked = await POST(request(application.clientId, 'wrong', 'json'));
    // 沿用已有 OAuth 限频的 invalid_request / 400 形状。
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({
      error: 'invalid_request',
      error_description: '请求过于频繁，请稍后再试',
    });
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(verify, '超限请求不能运行密码校验').toHaveBeenCalledTimes(3);
  });

  it('Basic 凭据优先；改变 body.client_id 或请求格式不能换桶', async () => {
    const { application } = await makeApp();
    prefillPasswordBucket(`oauth:${application.clientId}`, 60);
    // Basic 头带的是真实 clientId，body 里换一个：桶必须按 Basic 解析出的 clientId 计。
    // 若按 body.client_id 建桶，这里会落进一个全新的桶 → 反而会去验证密码（401）。
    const res = await POST(request(application.clientId, 'wrong', 'basic', {
      client_id: 'a-different-body-client',
      client_secret: SECRET,
    }));
    expect(await res.json()).toMatchObject({ error: 'invalid_request', error_description: '请求过于频繁，请稍后再试' });
    expect(verify, '限频在密码计算之前生效').not.toHaveBeenCalled();
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
    // 预填到只剩 1 个额度：正确密钥的这一笔应当被验证（然后因缺 code 回 invalid_request）。
    prefillPasswordBucket(`oauth:${application.clientId}`, 59);
    // 密钥正确但缺少 code；校验通过后返回 invalid_request。
    const allowed = await POST(request(application.clientId, SECRET));
    expect(await allowed.json()).toMatchObject({
      error: 'invalid_request',
      error_description: '缺少 code 或 redirect_uri',
    });
    // 额度已满：不再运行密码校验。
    const blocked = await POST(request(application.clientId, SECRET));
    expect(await blocked.json()).toMatchObject({ error_description: '请求过于频繁，请稍后再试' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('每个应用独立计数，60 秒窗口过去后恢复密码校验', async () => {
    const { application } = await makeApp();
    const { application: other } = await makeApp('other-client');
    // 用预填桶把本应用打满（窗口起点 = 测试时钟 12:00:00）。真实请求只留首尾各一笔。
    prefillPasswordBucket(`oauth:${application.clientId}`, 60);
    expect((await POST(request(other.clientId))).status, '另一个应用有自己的桶').toBe(401);
    expect((await POST(request(application.clientId))).status, '本应用已满').toBe(400);
    vi.setSystemTime(new Date('2026-10-09T12:01:00Z'));
    expect((await POST(request(application.clientId))).status, '窗口过去后恢复').toBe(401);
    expect(verify).toHaveBeenCalledTimes(2);
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

  it('真实 scrypt：额度用满后停止运行哈希', async () => {
    const actual = await vi.importActual<typeof import('@/lib/password')>('@/lib/password');
    verify.mockImplementation(actual.verifyPassword);
    const { application } = await makeApp();
    // 【保留这条的意义】上面的用例都是 mock 掉 verifyPassword 的；这一条让**真实**
    // 的 verifyPassword 跑一遍，证明限频确实发生在真实的密码计算之前，而不是
    // 只拦住了替身调用。
    // 【为什么用低 N 的 scrypt 哈希】生产参数 scrypt:32768:8:1 已被
    // `tests/unit/password.test.ts` 钉住；这条要验的是「限频在密码计算之前生效」，
    // 走的是同一段 verifyPassword 代码路径，单次 ~4ms（若用生产参数 ~123ms，
    // 60 次在并发全量下会撞 20s 超时，见 `docs/testing.md` §1.1）。
    const salt = 'test-salt-000000';
    const derived = await new Promise<Buffer>((resolve, reject) => {
      _scrypt(SECRET, salt, 64, { N: 1024, r: 8, p: 1, maxmem: 132 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key)
      );
    });
    await prisma.oAuthApplication.update({
      where: { id: application.id },
      data: { clientSecretHash: `scrypt:1024:8:1$${salt}$${derived.toString('hex')}` },
    });
    // 预填到只剩 1 个额度：额度内的那笔真的跑一次哈希（401），满额后那笔不再跑。
    prefillPasswordBucket(`oauth:${application.clientId}`, 59);
    expect((await POST(request(application.clientId))).status, '额度内真实 scrypt 验一次').toBe(401);
    expect((await POST(request(application.clientId))).status, '额度满后限频').toBe(400);
    expect(verify).toHaveBeenCalledTimes(1);
  }, 20000);
});
