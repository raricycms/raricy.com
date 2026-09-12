// POST /api/auth/login —— 登录限频（IP / 用户名双维度）
//
// 【为什么单独测这个】登录是全站唯一「未认证就能让服务端跑一次 scrypt」的入口：
// 不设限等于把撞库与 CPU DoS 一起开放。限频在路由最前面，早于查库与密码校验，
// 因此本用例不需要真用户 —— 全程用错误凭据即可打到 429。
//
// 本文件打的是真实 route handler（不 mock Prisma）：限频桶与响应码都是被测语义。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser } from '../helpers/db';
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';
import { hashPassword } from '@/lib/password';

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
  it('同一用户名连续失败达上限后返回 429', async () => {
    const limit = RULES.loginPerUser.limit;
    for (let i = 0; i < limit; i++) {
      const res = await login(req({ username: 'victim', password: 'wrong' }));
      expect(res.status, `第 ${i + 1} 次应为 401（凭据错误）`).toBe(401);
    }
    expect((await login(req({ username: 'victim', password: 'wrong' }))).status).toBe(429);
  });

  it('用户名大小写变体共用同一配额（改大小写绕不过去）', async () => {
    const limit = RULES.loginPerUser.limit;
    for (let i = 0; i < limit; i++) {
      await login(req({ username: 'Victim', password: 'wrong' }));
    }
    expect((await login(req({ username: 'VICTIM', password: 'wrong' }))).status).toBe(429);
    expect((await login(req({ username: 'victim', password: 'wrong' }))).status).toBe(429);
  });

  it('同一 IP 扫一批账号，达到 IP 上限后返回 429', async () => {
    const limit = RULES.loginPerIp.limit;
    const ip = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < limit; i++) {
      const res = await login(req({ username: `victim${i}`, password: 'wrong' }, ip));
      expect(res.status, `第 ${i + 1} 次应为 401`).toBe(401);
    }
    expect((await login(req({ username: 'fresh-name', password: 'wrong' }, ip))).status).toBe(429);
  });

  it('换 IP 即换桶，不受别的 IP 影响', async () => {
    const limit = RULES.loginPerIp.limit;
    for (let i = 0; i < limit; i++) {
      await login(
        req({ username: `victim${i}`, password: 'wrong' }, { 'x-forwarded-for': '203.0.113.7' })
      );
    }
    expect(
      (await login(req({ username: 'x', password: 'wrong' }, { 'x-forwarded-for': '203.0.113.7' })))
        .status
    ).toBe(429);
    // 新 IP + 新用户名 → 未超限，回到凭据校验
    expect(
      (await login(req({ username: 'y', password: 'wrong' }, { 'x-forwarded-for': '198.51.100.9' })))
        .status
    ).toBe(401);
  });

  it('cf-connecting-ip 优先于 x-forwarded-for', async () => {
    const limit = RULES.loginPerIp.limit;
    const h = { 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '10.0.0.1' };
    for (let i = 0; i < limit; i++) {
      await login(req({ username: `victim${i}`, password: 'wrong' }, h));
    }
    expect((await login(req({ username: 'z', password: 'wrong' }, h))).status).toBe(429);
    // 同一 x-forwarded-for、不同 cf-connecting-ip → 新桶
    expect(
      (
        await login(
          req(
            { username: 'w', password: 'wrong' },
            { 'cf-connecting-ip': '198.51.100.10', 'x-forwarded-for': '10.0.0.1' }
          )
        )
      ).status
    ).toBe(401);
  });

  // 每次成功登录都要跑一遍 scrypt，100+ 次会超过默认 5s 超时 —— 显式放宽。
  it('成功登录不消耗配额（否则正常用户会被自己的成功记录挡住）', { timeout: 120_000 }, async () => {
    const username = 'gooduser';
    await makeUser({ username, passwordHash: await hashPassword('correct-horse') });
    const ip = { 'x-forwarded-for': '203.0.113.55' };

    // 连续成功登录，次数超过 per-user 上限 —— 必须次次 200
    for (let i = 0; i < RULES.loginPerUser.limit + 5; i++) {
      const res = await login(req({ username, password: 'correct-horse' }, ip));
      expect(res.status, `第 ${i + 1} 次成功登录不应被限频`).toBe(200);
    }
  });

  it('空用户名/密码仍返回 400，且不占用限频配额', async () => {
    for (let i = 0; i < RULES.loginPerUser.limit + 2; i++) {
      expect((await login(req({ username: '', password: '' }))).status).toBe(400);
    }
    // 配额未被空请求吃掉：正常凭据仍能走到 401
    expect((await login(req({ username: 'someone', password: 'wrong' }))).status).toBe(401);
  });
});
