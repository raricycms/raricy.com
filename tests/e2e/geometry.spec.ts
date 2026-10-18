// geometry.spec.ts —— 几何计算器（/tool/geometry + public/static/geometry）
//
// 这个工具是第三方静态页面（原作 xcxGeometry）的本地化副本，本站只提供入口与索引。
// 三个最容易「静默坏掉」的点，各钉一条：
//   1. 工具箱里没有入口 / 入口指错 —— 与 tools.spec.ts 的「工具必须点得进去」同源；
//   2. 静态页面的相对资源（document/*.js）断了 —— 页面 200 但计算不工作；
//   3. 上游把 math-page.css 误命名成 mathpath.css，导致 5 页没有样式 —— 用计算样式断言。
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

test('求导页有 math-page.css（页面骨架 + 编辑器样式）且能求导', async ({ page }) => {
  await page.goto('/static/geometry/derivative.html');

  // 这条断言专门抓「上游 CSS 文件名对不上」：没有 math-page.css 时 #calculator
  // 没有圆角、没有卡片底色，页面看着能用但样式全塌。
  const style = await page.locator('#calculator').evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, bg: s.backgroundColor };
  });
  expect(style.radius).toBe('16px');
  expect(style.bg).toBe('rgb(255, 255, 255)');

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
