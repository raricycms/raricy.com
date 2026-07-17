// ─────────────────────────────────────────────────────────────────────────────
// broadcast-permission.spec.ts —— 群发的三层权限
//
// 群发一次触达全站，是本项目影响面最大的操作。此前路由只判 hasAdminRights，
// 任何管理员都能给所有人发通知 —— 而 Flask 在页面、接口、service 三处都卡了站长。
//
// 单测只覆盖 service 层；路由的判权与页面的门控要真发 HTTP 才验得到。
// 尤其是页面：AdminShell 侧栏对非站长隐藏了「通知发送」入口，但 URL 猜得到 ——
// 「链接藏起来」不等于「挡住」，必须有服务端 layout 守卫。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

test.describe('POST /api/admin/broadcast', () => {
  test('未登录 → 403', async ({ request }) => {
    const res = await request.post('/api/admin/broadcast', { data: { detail: 'x' } });
    expect(res.status()).toBe(403);
  });

  test('★ 管理员 → 403（不是站长就不能群发）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.post('/api/admin/broadcast', { data: { detail: '越权测试' } });
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe('没有站长权限');
  });

  test('core 用户 → 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.post('/api/admin/broadcast', { data: { detail: 'x' } });
    expect(res.status()).toBe(403);
  });
});

test.describe('/admin/broadcast 页面', () => {
  test('★ 管理员直接访问 URL → 403（侧栏藏起入口不等于挡住）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get('/admin/broadcast');
    expect(res.status()).toBe(403);
  });

  test('管理员的侧栏里没有「通知发送」入口', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin');
    await expect(page.locator('a[href="/admin/broadcast"]')).toHaveCount(0);
  });
});
