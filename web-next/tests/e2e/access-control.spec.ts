// 未登录 / 权限不足时的门控行为。
//
// 【为什么分两种预期】本站的门控**故意**有两套语义，别把它们当成同一件事：
//   · redirect('/login')  —— /admin/*、/checkin、/fish/*：跳登录页
//   · forbidden()         —— requireCoreUser 的页面（/blog 等）：原地渲染 403 页，URL 不变
// 后者是为对齐原 Flask 的 abort(403)（见 src/lib/guard.ts）。若哪天有人把 guard 改成
// 统一跳转，403 页那条语义就悄悄没了 —— 这两组用例就是为了让那种改动当场可见。

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

test.describe('未登录访问受控页面', () => {
  test('/checkin 跳转登录页，并带上回跳地址', async ({ page }) => {
    await page.goto('/checkin');
    // 带 ?next= 才能在登录后回到这里（对齐 Flask-Login 的 login_view 行为）。
    // Next 侧一度只跳 '/login'、登录后一律回首页 —— 那是行为回归。
    await expect(page).toHaveURL('/login?next=%2Fcheckin');
    await expect(page.locator('#loginForm')).toBeVisible();
  });

  test('/admin 跳转登录页，并带上回跳地址', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL('/login?next=%2Fadmin');
  });

  test('/blog 原地渲染 403（对齐原站 abort(403)，非跳转）', async ({ page }) => {
    const res = await page.goto('/blog');
    // 状态码必须真的是 403 —— 渲染 403 页面但回 200 会让爬虫/监控误判
    expect(res?.status()).toBe(403);
    await expect(page).toHaveURL(/\/blog$/); // URL 不变，这是与 redirect 的分水岭
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });
});

test.describe('角色门控', () => {
  test('普通用户（role=user）访问 /admin 被挡回登录页', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    await page.goto('/admin');
    // AdminLayout: hasAdminRights(user) 为假 → redirect(loginUrlWithNext('/admin'))
    await expect(page).toHaveURL('/login?next=%2Fadmin');
    // 顶栏能证明「他确实登着录」，被挡是因为角色不够，不是因为没登录 ——
    // 少了这一条，用例在「会话根本没生效」时也会绿。
    await expect(page.locator('#userDropdownToggle')).toContainText(SEED_USERS.plain.username);
  });

  test('普通用户（role=user）访问 /blog 得到 403，而非登录页', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.goto('/blog');
    expect(res?.status()).toBe(403);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });

  test('管理员访问 /admin 正常进入', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('h1')).toContainText('管理概览');
  });

  test('普通用户顶栏不出现「管理面板」入口', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    await page.goto('/');
    // 入口藏在用户下拉里（移动端折叠），故不看可见性、只看它在不在 DOM 里
    await expect(page.locator('#userDropdownMenu a[href="/admin"]')).toHaveCount(0);
  });
});
