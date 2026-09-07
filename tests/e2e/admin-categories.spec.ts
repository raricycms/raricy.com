// ─────────────────────────────────────────────────────────────────────────────
// admin-categories.spec.ts —— 栏目管理的权限、导航与全流程
//
// 栏目是站点结构（slug 是 URL 标识、决定侧栏层级与发文规则），此前只判
// hasAdminRights —— 任何管理员都能改结构。收紧为仅站长（owner），对齐
// 通知发送 / 申诉管理两个站长专属功能的门控口径。
//
// 单测覆盖 service 层（slug 锁定/字符集/父级规则见 tests/service/
// admin-category-service.test.ts）；路由判权与页面门控必须真发 HTTP 才验得到。
// 尤其是页面：AdminShell 侧栏对非站长隐藏「栏目管理」入口，但 URL 猜得到 ——
// 「链接藏起来」不等于「挡住」，必须有服务端 layout 守卫（admin/categories/layout.tsx）。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

test.describe('/api/admin/categories 权限', () => {
  test('未登录 → 403', async ({ request }) => {
    const res = await request.post('/api/admin/categories', {
      data: { name: 'x', slug: 'x' },
    });
    expect(res.status()).toBe(403);
  });

  test('★ 管理员 → 403（不是站长就不能动栏目结构）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.post('/api/admin/categories', {
      data: { name: '越权栏目', slug: 'evil-cat' },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe('没有站长权限');

    const resGet = await page.request.get('/api/admin/categories');
    expect(resGet.status()).toBe(403);
  });
});

test.describe('/admin/categories 页面门控', () => {
  test('★ 管理员直接访问 URL → 403（侧栏藏起入口不等于挡住）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get('/admin/categories');
    expect(res.status()).toBe(403);
  });

  test('管理员的侧栏里没有「栏目管理」入口', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin');
    await expect(page.locator('a[href="/admin/categories"]')).toHaveCount(0);
  });
});

test.describe('站长全流程', () => {
  test('侧栏可见「栏目管理」→ 进入页面 → 新建栏目成功', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    // 入口在站长专属导航组里
    await page.goto('/admin');
    const nav = page.locator('a[href="/admin/categories"]');
    await expect(nav).toHaveCount(1);
    await nav.click();
    await expect(page).toHaveURL(/\/admin\/categories$/);
    await expect(page.getByRole('heading', { name: '栏目管理' })).toBeVisible();

    // 新建一个一级栏目：名称 + slug（必填，其余默认）
    const tag = Date.now().toString(36);
    const name = `E2E 新建栏目 ${tag}`;
    const slug = `e2e-new-${tag}`;
    await page.getByRole('button', { name: '+ 新建栏目' }).click();
    const dialog = page.locator('.modal-dialog');
    await expect(dialog).toBeVisible();
    // 表单输入按 modal-body 内 form-control 顺序：名称、slug、图标、排序、描述
    await dialog.locator('input.form-control').nth(0).fill(name);
    await dialog.locator('input.form-control').nth(1).fill(slug);
    await dialog.getByRole('button', { name: '保存' }).click();

    // 保存成功 → 模态收起，列表直出新建的行（router.refresh 重新拉服务端数据）
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.article-card__title', { hasText: name })).toBeVisible();

    // 行内徽标默认：无「不进全部」等标签 —— 断言 slug 展示即验证服务端已落库
    await expect(page.locator('.article-card code', { hasText: slug })).toBeVisible();

    // 清理：新建的栏目没有内容，删除按钮可用 —— 不留脏种子
    const row = page.locator('.article-card', { hasText: name });
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.article-card', { hasText: name })).toHaveCount(0);
  });
});
