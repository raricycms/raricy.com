// ─────────────────────────────────────────────────────────────────────────────
// admin-ui.spec.ts —— 管理面板改版的几何契约（窄屏为主）
//
// 【为什么必须走 e2e】这几条断言的都是**浏览器排版出来的事实**，读样式表看不出来：
//   · 页面有没有横向溢出（页级 overflow 不受局部 `overflow-x:auto` 影响，会静默
//     把整页顶宽）；
//   · 日志检索的六个筛选字段在首屏是否真的带可见标签、表格有没有在窄屏折成卡片；
//   · 文章行首的方形勾选点是否落在卡片内、心形图标与数字是否同一水平线。
//
// 用户报过三件事，正好是后三条：勾选点溢出卡片、点赞数与心形没对齐、日志检索
// 在手机端挤成一坨。这里把它们钉住，改版回退时会当场红。
//
// 视口在文件内显式钉死（与 page-gutter.spec.ts 同一手法），并登记在
// playwright.config.ts 的 RESPONSIVE_SPECS 里，两个 project 都跑同一份视口。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_CATEGORY, SEED_USERS } from './seed';

test.use({ viewport: { width: 390, height: 844 } });

/** 整页横向溢出量（px）。> 0 表示页面被某个元素顶宽了。 */
async function pageOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

test.describe('管理面板窄屏版式', () => {
  test('九个管理页均无整页横向溢出，侧栏是单行胶囊标签带', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    const routes = [
      '/admin',
      '/admin/blogs',
      '/admin/logs',
      '/admin/users',
      '/admin/categories',
      '/admin/appeals',
      '/admin/broadcast',
      '/admin/oauth',
      '/audit',
    ];

    for (const url of routes) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('h1').first(), `${url} 没有渲染出 h1`).toBeVisible();

      const overflow = await pageOverflow(page);
      expect(overflow, `${url} 出现整页横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);

      // 侧栏在窄屏折成一条横向滚动的胶囊带：一行高约 35–52px。
      // 旧版是 flex-wrap 的三行（104px），把首屏内容整体往下压。
      const nav = page.locator('.admin-sidebar__nav');
      const navBox = await nav.boundingBox();
      expect(navBox, `${url} 找不到管理侧栏`).not.toBeNull();
      expect(navBox!.height, `${url} 侧栏折成了多行`).toBeLessThanOrEqual(64);

      const scrollable = await nav.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(scrollable, `${url} 侧栏标签带应当可横向滚动`).toBe(true);
    }
  });

  test('日志检索：六个字段带可见标签，表格在窄屏折成卡片', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin/logs', { waitUntil: 'domcontentloaded' });

    // 首屏可见的四个检索入口（admin-logs.spec.ts 钉的是它们，这里顺带守住标签）。
    await expect(page.locator('form.audit-filter-bar #log-action')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="admin"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="target"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar #log-range')).toBeVisible();

    const labels = page.locator('.admin-filter__grid .admin-field__label');
    await expect(labels).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      await expect(labels.nth(i)).toBeVisible();
    }

    // 窄屏表格不再横向滚动：每行按 data-label 折成一张卡片。
    await expect(page.locator('.admin-table thead')).toBeHidden();
    const tableScroll = page.locator('.admin-table-scroll');
    const innerOverflow = await tableScroll.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(innerOverflow, '窄屏日志表仍在内部横向滚动').toBeLessThanOrEqual(1);

    const firstRow = page.locator('.admin-table tbody tr').first();
    await expect(firstRow).toBeVisible();
    // 折卡后每格是「标签 + 值」两列；标签由 td::before 提供，取计算值确认没被隐藏。
    const rowDisplay = await firstRow.evaluate((el) => getComputedStyle(el).display);
    expect(rowDisplay).toBe('block');
  });

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

  test('文章行：勾选点在卡片内、心形与数字居中、选中浮出批量底座', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto('/admin/blogs', { waitUntil: 'domcontentloaded' });

    const row = page.locator('.admin-row').first();
    await expect(row).toBeVisible();

    const rowBox = await row.boundingBox();
    const pickBox = await row.locator('.admin-pick__box').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(pickBox).not.toBeNull();
    // 勾选点必须完整落在卡片内（旧版用 margin-left:-1.5rem 把它推到卡片外 4px）。
    expect(pickBox!.x).toBeGreaterThanOrEqual(rowBox!.x);
    expect(pickBox!.x + pickBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    // 选择控件是 7px 圆角的方形勾选块，不是圆形亮起。
    expect(
      await row.locator('.admin-pick__box').evaluate((el) => parseFloat(getComputedStyle(el).borderRadius))
    ).toBeLessThanOrEqual(8);

    // 心形与紧跟的数字同一水平线（旧版中心线差 2.8px）。
    const heart = await row.locator('.admin-row__stat svg').first().boundingBox();
    const num = await row.locator('.admin-row__stat .numeric').first().boundingBox();
    expect(heart).not.toBeNull();
    expect(num).not.toBeNull();
    const heartCenter = heart!.y + heart!.height / 2;
    const numCenter = num!.y + num!.height / 2;
    expect(Math.abs(heartCenter - numCenter), '心形与点赞数没有垂直居中对齐').toBeLessThanOrEqual(1);

    // 选中后：行卡高亮 + 底部批量操作胶囊浮出。
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
