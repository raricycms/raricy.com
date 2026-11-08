// geometry.spec.ts —— 几何计算器（/tool/geometry + public/static/geometry）
//
// 这个工具是第三方静态页面（原作 xcxGeometry）的本地化副本，本站只提供入口与索引。
// 钉住「打开得了、算得出、回得去」：入口可达、相对资源没断（点「化简」真出结果）、
// 十个页面都能打开且返回链接指回站内索引。
// 样式是否完好（math-page.css 在不在）属于外观，按仓库纪律不在测试里固定 ——
// 由受影响页面的实际检查负责。
import { test, expect } from '@playwright/test';

const PAGES = [
  'monomial',
  'derivative',
  'lagrange',
  'distance2',
  'distance3',
  'linedistance2',
  'ellipseline',
  'paraline',
  'hyperline',
  'tetrahedron',
] as const;

test('工具箱「数学 / 几何」区有几何计算器入口，点进去是索引页', async ({ page }) => {
  await page.goto('/tool');

  const entry = page.locator('a.tool-new-card[href="/tool/geometry"]');
  await expect(entry).toBeVisible();
  await entry.click();

  await page.waitForURL(/\/tool\/geometry$/);
  await expect(page.locator('h1')).toContainText('几何计算器');
});

test('索引页列出 10 个计算器，普通计算器能算出精确结果', async ({ page }) => {
  await page.goto('/tool/geometry');

  await expect(page.locator('a.tool-new-card')).toHaveCount(PAGES.length);

  await page.locator('a.tool-new-card[href="/static/geometry/monomial.html"]').click();
  await page.waitForURL(/\/static\/geometry\/monomial\.html$/);

  const slot = page.locator('#formula-editor .slot').first();
  await slot.fill('1+2*3');
  await page.getByRole('button', { name: '化简' }).click();
  await expect(page.locator('#result')).toContainText('7');

  // 普通计算器原先用页面内联的旧渲染器，会把 5*a 这类结果原样吐出 `5*a`。
  // 现在改走公共 FormulaRender（拆乘除、渲染上标），钉住这个本地化修复。
  await slot.fill('2*a+3*a');
  await page.getByRole('button', { name: '化简' }).click();
  await expect(page.locator('#result')).toContainText('5 · a');
});

test('求导页的相对资源没断，能真的求导', async ({ page }) => {
  await page.goto('/static/geometry/derivative.html');

  const slot = page.locator('#formula-editor .slot').first();
  await slot.fill('x^2');
  await page.getByRole('button', { name: '求导' }).click();
  await expect(page.locator('#result')).toContainText('2');
});

test('10 个计算器页面都能打开，且返回链接指向站内索引', async ({ page }) => {
  for (const slug of PAGES) {
    const res = await page.goto(`/static/geometry/${slug}.html`);
    expect(res?.status(), slug).toBe(200);
    await expect(page.locator('#calculator'), slug).toHaveCount(1);
    await expect(page.locator('.back-link'), slug).toHaveAttribute('href', '/tool/geometry');
  }
});
