import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

test('玩具入口：四张首页卡按故事、玩具、博客、工具排列，清单只有 ATÅMAS', async ({ page }) => {
  await page.goto('/');
  expect(await page.locator('.home-grid .feature-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href'))))
    .toEqual(['/story', '/game', '/explore', '/tool']);
  // 四张卡的图标必须同尺寸（3rem = 48px）。玩具卡是 lucide 内联 SVG，而
  // `svg.lucide { width/height: 1em }` 的权重（0-1-1）高过单类名选择器（0-1-0）——
  // 尺寸那条规则漏了升权重，这颗图标就静默退回 16px，与另外三张并排时只是「看着不对」。
  expect(await page.locator('.home-grid .feature-card').evaluateAll((cards) => cards.map((card) => {
    const icon = card.querySelector('.feature-icon, .feature-game-icon')!;
    const { width, height } = icon.getBoundingClientRect();
    return `${width}x${height}`;
  }))).toEqual(['48x48', '48x48', '48x48', '48x48']);
  await expect(page.locator('.site-nav a[href="/game"]')).toHaveCount(1);
  await expect(page.locator('.site-nav a[href="/chat"]')).toHaveCount(1);
  await page.locator('.home-grid a[href="/game"]').click();
  await expect(page.locator('.game-card')).toHaveCount(1);
  await expect(page.locator('.game-card h2')).toHaveText('ATÅMAS');
  await expect(page.locator('.game-card__tags')).toHaveText('益智单人');
});

test('ATÅMAS：鼠标或触屏落子、撤销、重置、语言和深色主题', async ({ page, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/atamas');
  const canvas = page.getByLabel('ATÅMAS 游戏棋盘');
  await expect(canvas).toBeVisible();
  if (isMobile) {
    const board = (await canvas.boundingBox())!;
    const preview = (await page.locator('.atamas-pending-preview').boundingBox())!;
    expect(preview.y).toBeGreaterThanOrEqual(board.y + board.height);
  }
  const undo = page.getByRole('button', { name: '0', exact: true });
  await expect(undo).toBeDisabled();
  const box = (await canvas.boundingBox())!;
  const position = { x: box.width * .675, y: box.height * .197 };
  if (isMobile) await canvas.tap({ position });
  else await canvas.click({ position });
  const recall = page.getByRole('button', { name: '撤销', exact: true });
  await expect(recall).toBeEnabled();
  await recall.click();
  await expect(page.locator('.atamas-info-panel button').nth(1)).toBeDisabled();
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.locator('.atamas-bottom-bar__value').nth(1)).toHaveText('0');

  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('atamas_lang'))).toBe('en');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await expect.poll(() => page.locator('.atamas-container').evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(24, 26, 29)');
  await expect.poll(() => page.locator('.atamas-top-bar__title').evaluate((element) => getComputedStyle(element).color))
    .toBe('rgb(241, 245, 249)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath('atamas-dark.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('专注模式隐藏玩具入口，并拦住菜单及游戏直达', async ({ page }) => {
  await registerFreshUser(page);
  const result = await page.request.patch('/api/users/me', { data: { focusMode: true } });
  expect(result.status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('.home-grid .feature-card')).toHaveCount(3);
  await expect(page.locator('.site-nav a[href="/game"]')).toHaveCount(0);
  for (const route of ['/game', '/game/atamas', '/game/collections/test', '/game/wand', '/game/wand2', '/game/public-space', '/game/quandi']) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: '已开启专注模式' })).toBeVisible();
    await expect(page.locator('canvas, .game-card')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '前往设置' })).toHaveAttribute('href', '/settings#focus-mode');
  }
});
