// CSRF 中间件（src/middleware.ts）在真实 HTTP 下的行为。
//
// 【为什么要在 E2E 层再打一遍】tests/unit/middleware-csrf.test.ts 已经直接调 middleware()
// 验过判定逻辑。但它是拿手搓的 NextRequest 喂进去的 —— 证明不了两件事：
//   1. matcher 是否真的生效（config.matcher 写错时单测照样全绿，因为它绕过了 matcher）
//   2. 正常的同源请求会不会被误杀（线上翻过的车：反代下 Host 判定错误 → 正常请求 403）
// 这两条都只有真发 HTTP 才看得见。
//
// 说明：这里用独立的 `request` fixture 而非 page.request —— 要精确控制 Origin 头，
// 不想被浏览器 context 的自动行为干扰。

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_PASSWORD } from './seed';

const EVIL_ORIGIN = 'http://evil.example.com';

test.describe('CSRF Origin 校验', () => {
  test('带外站 Origin 的 POST 被拒绝', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: { origin: EVIL_ORIGIN },
      data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(403);
    expect(body.message).toContain('跨源请求被拒绝');

    // 必须在**动作发生前**拦下：403 却已经下发了会话 cookie 等于没拦。
    // 只断状态码的话，「先登录再返回 403」这种写法也会绿。
    expect(res.headers()['set-cookie']).toBeUndefined();
  });

  test('带外站 Referer（无 Origin）的 POST 同样被拒绝', async ({ request }) => {
    // 中间件在缺 Origin 时回退看 Referer —— 这条分支单独覆盖
    const res = await request.post('/api/auth/login', {
      headers: { referer: `${EVIL_ORIGIN}/attack.html` },
      data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
    });
    expect(res.status()).toBe(403);
  });

  test('同源 Origin 的 POST 正常放行（防误杀）', async ({ request, baseURL }) => {
    const res = await request.post('/api/auth/login', {
      headers: { origin: baseURL! },
      data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).code).toBe(200);
  });

  test('GET 是安全方法，外站 Origin 不受影响', async ({ request }) => {
    const res = await request.get('/api/auth/me', { headers: { origin: EVIL_ORIGIN } });
    expect(res.status()).toBe(200);
  });

  test('浏览器发起的真实同源 POST 不被误杀', async ({ page }) => {
    // 真浏览器在页面上下文里 fetch 会自动带上 Origin: http://127.0.0.1:3100。
    // 这是最贴近真实用户的一条路径 —— 若 matcher / Host 判定有问题，这里会直接 403。
    await page.goto('/login');
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      return r.status;
    });
    expect(status).toBe(200);
  });
});
