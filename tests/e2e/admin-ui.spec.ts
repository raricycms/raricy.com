// ─────────────────────────────────────────────────────────────────────────────
// admin-ui.spec.ts —— 管理面板**操作行为**：文章筛选选中即提交、批量选择底座
//
// 管理面板改版的几何契约（整页横向溢出、窄屏侧栏单行、日志筛选标签、表格折卡、
// 勾选点与心形对齐）属于外观，按仓库纪律不再由 e2e 钉住 —— 由受影响页面与视口的
// 实际检查负责（见 reports/round4/parts/e2e-visual.md 的页面验收清单）。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_CATEGORY, SEED_USERS } from './seed';

test.describe('管理面板操作', () => {
  test('文章管理：栏目筛选选中后立即提交，值随 URL 回填', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto('/admin/blogs', { waitUntil: 'domcontentloaded' });

    const host = page.locator('.expand-select', {
      has: page.locator('#article-category-filter'),
    });
    await host.locator('.expand-select__toggle').click();
    await host.getByRole('option', { name: SEED_CATEGORY.name, exact: true }).click();

    // 这是「选中即提交」的筛选：值靠隐藏 input 同步写入，再 requestSubmit。
    await expect(page).toHaveURL(/[?&]category=\d+(?:&|$)/);
    await expect(page.locator('#article-category-filter')).toContainText(SEED_CATEGORY.name);
  });

  test('文章行：可勾选，选中浮出批量底座，取消后底座收起', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto('/admin/blogs', { waitUntil: 'domcontentloaded' });

    const row = page.locator('.admin-row').first();
    await expect(row).toBeVisible();

    await row.locator('.admin-pick').click();
    await expect(row).toHaveClass(/is-selected/);
    const dock = page.locator('.admin-dock');
    await expect(dock).toBeVisible();
    await expect(dock).toContainText('已选');
    await expect(dock.locator('.admin-dock__count .numeric')).toHaveText('1');

    // 取消后底座收起，不留下固定定位的空壳挡住列表。
    await dock.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dock).toHaveCount(0);
  });
});
