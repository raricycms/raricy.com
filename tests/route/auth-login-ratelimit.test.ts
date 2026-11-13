// POST /api/auth/login —— 登录限频（IP / 用户名双维度）
//
// 【为什么单独测这个】登录是全站两个「未认证就能让服务端跑一次 scrypt」的入口之一
// （另一个是鱼干市场的无状态接口，见 `fish-market-bot.test.ts`）：
// 不设限等于把撞库与 CPU DoS 一起开放。限频在路由最前面，早于查库与密码校验，
// 因此本用例不需要真用户 —— 全程用错误凭据即可打到 429。
//
// 本文件打的是真实 route handler（不 mock Prisma）：限频桶与响应码都是被测语义。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser } from '../helpers/db';
import { __resetRateLimitStore, RULES, recordRateLimitHit, isRateLimited } from '@/lib/rate-limit';
import { hashPassword } from '@/lib/password';
import * as passwordWork from '@/lib/password';
import { verifyCredentials } from '@/lib/credential-auth';

// 成功登录会调 cookies() —— 单测里没有请求上下文，mock 掉（本文件只关心配额）。
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {} }) }));

import { POST as login } from '@/app/api/auth/login/route';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  // 限频桶是模块级 Map，跨用例共享 —— 不清会串味。
  __resetRateLimitStore();
});

describe('登录限频', () => {
  it('失败预算仅剩一个名额时，8 个并发请求只执行一次密码计算', async () => {
    await makeUser({ username: 'victim', passwordHash: await hashPassword('correct-horse') });
    for (let i = 0; i < RULES.loginPerUser.limit - 1; i++) recordRateLimitHit('login:user:victim');
    const spy = vi.spyOn(passwordWork, 'verifyPassword');
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => verifyCredentials('victim', 'wrong')));
      expect(results.filter((r) => !r.ok && r.status === 401)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.status === 429)).toHaveLength(7);
      expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it('成功尝试释放预留的失败额度，不把最后一个名额泄漏', async () => {
    await makeUser({ username: 'victim', passwordHash: await hashPassword('correct-horse') });
    for (let i = 0; i < RULES.loginPerUser.limit - 1; i++) recordRateLimitHit('login:user:victim');
    expect((await verifyCredentials('victim', 'correct-horse')).ok).toBe(true);
    expect(isRateLimited('login:user:victim', RULES.loginPerUser)).toBe(false);
    expect(await verifyCredentials('victim', 'wrong')).toMatchObject({ status: 401 });
    expect(await verifyCredentials('victim', 'wrong')).toMatchObject({ status: 429 });
  });
  it('同一用户名连续失败达上限后返回 429', async () => {
    const limit = RULES.loginPerUser.limit;
    // 直填用户桶到「只剩一个名额」：本用例要钉的是「失败才计数 + 名额用尽即 429」，
    // 不是 100 次逐条回 401（等价但慢）。最后一次仍走真实 route 计数。
    for (let i = 0; i < limit - 1; i++) recordRateLimitHit('login:user:victim');
    expect(
      (await login(req({ username: 'victim', password: 'wrong' }))).status,
      '最后一个名额应仍走到凭据校验'
    ).toBe(401);
    expect((await login(req({ username: 'victim', password: 'wrong' }))).status).toBe(429);
  });

  it('用户名大小写变体共用同一配额（改大小写绕不过去）', async () => {
    const limit = RULES.loginPerUser.limit;
    for (let i = 0; i < limit - 1; i++) recordRateLimitHit('login:user:victim');
    expect((await login(req({ username: 'Victim', password: 'wrong' }))).status).toBe(401);
    expect((await login(req({ username: 'VICTIM', password: 'wrong' }))).status).toBe(429);
    expect((await login(req({ username: 'victim', password: 'wrong' }))).status).toBe(429);
  });

  it('换 IP 即换桶，不受别的 IP 影响', async () => {
    const limit = RULES.loginPerIp.limit;
    const ip = '203.0.113.7';
    // 直填 IP 桶到只剩一个名额：要钉的是「IP 维度在 route 里真的生效」，
    // 不是 300 次逐条回 401。最后一次真实请求负责计数，之后仍须 429。
    for (let i = 0; i < limit - 1; i++) recordRateLimitHit(`login:ip:${ip}`);
    expect(
      (await login(req({ username: 'x', password: 'wrong' }, { 'x-real-ip': ip }))).status
    ).toBe(401);
    expect(
      (await login(req({ username: 'y', password: 'wrong' }, { 'x-real-ip': ip }))).status
    ).toBe(429);
    // 新 IP + 新用户名 → 未超限，回到凭据校验
    expect(
      (await login(req({ username: 'z', password: 'wrong' }, { 'x-real-ip': '198.51.100.9' })))
        .status
    ).toBe(401);
  });

  it('成功登录不消耗失败预算，但受独立计算预算保护', async () => {
    const username = 'gooduser';
    await makeUser({ username, passwordHash: await hashPassword('correct-horse') });
    const ip = { 'x-real-ip': '203.0.113.55' };

    for (let i = 0; i < 5; i++) {
      const res = await login(req({ username, password: 'correct-horse' }, ip));
      expect(res.status, `第 ${i + 1} 次成功登录不应被限频`).toBe(200);
    }
    expect(isRateLimited(`login:user:${username}`, RULES.loginPerUser)).toBe(false);
  });

  it('正确密码超过 20 次/分钟也在计算前返回 429，用户名和邮箱共享用户 ID 桶', async () => {
    const user = await makeUser({ username: 'gooduser', passwordHash: await hashPassword('correct-horse') });
    const spy = vi.spyOn(passwordWork, 'verifyPassword');
    try {
      for (let i = 0; i < RULES.passwordPerUser.limit; i++) {
        expect((await verifyCredentials(i % 2 ? user.email : user.username, 'correct-horse')).ok).toBe(true);
      }
      expect(await verifyCredentials(user.username, 'correct-horse')).toMatchObject({ status: 429 });
      expect(spy).toHaveBeenCalledTimes(RULES.passwordPerUser.limit);
      expect(isRateLimited(`login:user:${user.username}`, RULES.loginPerUser)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('空用户名/密码仍返回 400，且不占用限频配额', async () => {
    for (let i = 0; i < RULES.loginPerUser.limit + 2; i++) {
      expect((await login(req({ username: '', password: '' }))).status).toBe(400);
    }
    // 配额未被空请求吃掉：正常凭据仍能走到 401
    expect((await login(req({ username: 'someone', password: 'wrong' }))).status).toBe(401);
  });
});
