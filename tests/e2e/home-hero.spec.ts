// 首页山景的**行为**回归：主题切换（html data-theme / 明暗按钮）、无 JavaScript 时的
// 静态回退。视差位移、倾斜授权流程、构图与几何属于外观/动效，按仓库纪律不在测试里
// 固定 —— 由受影响页面与视口的实际检查负责（见 reports/round4/parts/e2e-visual.md）。
import { test, expect } from '@playwright/test';

test('首页主题切换：明暗按钮改 html 的 data-theme，移动端从折叠导航里点', async ({ page, isMobile }) => {
  // 关掉动效，只验状态（减少动态效果偏好下主题照样切换）。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  if (isMobile) await page.getByRole('button', { name: '切换导航', exact: true }).click();
  const toggle = page.getByRole('button', { name: '切换明暗主题', exact: true });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('禁用 JavaScript 时山景和探索链接仍可使用', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.locator('.hero-scene')).toBeVisible();
    await expect(page.getByRole('heading', { name: '聪明山', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '开始探索' }).click();
    await expect(page).toHaveURL(/#features$/);
  } finally {
    await context.close();
  }
});
