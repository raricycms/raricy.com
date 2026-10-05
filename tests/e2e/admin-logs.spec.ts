// ─────────────────────────────────────────────────────────────────────────────
// admin-logs.spec.ts —— /admin/logs（审计日志运维检索）的门控
//
// 【为什么必须是 E2E】这一页的档位是**页面自己**把的（父 /admin 母版只判 core+，
// 见 src/app/admin/layout.tsx 的文件头）。也就是说：把 requireAdmin() 那一行删掉，
// tsc 不报、单测不管、构建照过 —— 页面会安安静静地对**所有 core 用户**开放，
// 而它显示的是含内部日志与真实当事人的记录。只有真的走一遍 HTTP 才暴露。
//
// 与 /audit 的分工（公示 vs 运维）见 docs/architecture.md §4 的路由表。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

test.describe('/admin/logs 门控', () => {
  test('未登录 → 302/307 去登录页', async ({ request }) => {
    const res = await request.get('/admin/logs', { maxRedirects: 0 });
    expect([302, 307]).toContain(res.status());
    expect(res.headers().location ?? '').toContain('/login?next=');
  });

  test('core 用户 → 403（这一页是 admin+，别跟着父母版的 core 档放行）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.get('/admin/logs');
    expect(res.status()).toBe(403);
  });

  test('普通用户 → 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    const res = await page.request.get('/admin/logs');
    expect(res.status()).toBe(403);
  });

  test('admin → 200，且渲染出检索表单', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get('/admin/logs');
    expect(res.status()).toBe(200);
    await page.goto('/admin/logs');
    await expect(page.locator('.admin-hero h1')).toHaveText('日志检索');
    // 检索入口真的在页面上（动作下拉 + 执行者/当事人两个输入 + 「不限时间」档）。
    await expect(page.locator('form.audit-filter-bar select[name="action"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="admin"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="target"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar select[name="range"]')).toBeVisible();
  });
});
