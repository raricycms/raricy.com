import { test, expect, type Page } from '@playwright/test';
import { LEVELS } from '../../src/games/lumen/levels';
import { initialRotations, isRotatable, solutions } from '../../src/games/lumen/engine';

async function open(page: Page) {
  await page.goto('/game/lumen');
  await expect(page.getByRole('button', { name: '关卡', exact: true })).toBeEnabled();
}
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: '关卡', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`第 ${id} 关`) }).click();
  await expect(page.locator('.lm-board')).toHaveAttribute('data-level', id);
}

test('首次引导直接可玩，键盘通关并保存，下一关与存档续玩', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const optic = page.locator('.lm-optic').first();
  await expect(optic).toHaveClass(/lm-optic--hint/);
  await optic.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.lm-result')).toHaveAttribute('data-stars', '3');
  await expect(page.getByTestId('lumen-moves')).toHaveText('1');
  await page.getByRole('button', { name: '下一关', exact: true }).click();
  await page.locator('.lm-optic').first().click();
  await expect(page.getByTestId('lumen-moves')).toHaveText('1');
  const name = await page.locator('.lm-optic').first().getAttribute('aria-label');
  await page.reload();
  await expect(page.locator('.lm-board')).toHaveAttribute('data-level', '02');
  await expect(page.locator('.lm-optic').first()).toHaveAttribute('aria-label', name!);
  await expect(page.getByTestId('lumen-moves')).toHaveText('1');
  await page.locator('.lm-optic').last().click();
  await expect(page.locator('.lm-result')).toHaveAttribute('data-stars', '3');
  await page.getByRole('button', { name: '撤销', exact: false }).click();
  await expect(page.locator('.lm-board')).toHaveAttribute('data-solved', 'false');
  await page.getByRole('button', { name: '重来', exact: false }).click();
  await expect(page.getByTestId('lumen-moves')).toHaveText('0');
  await page.getByRole('button', { name: '给点提示' }).click();
  await expect(page.locator('.lm-hint')).toContainText(LEVELS[1].hint);
  await page.getByRole('button', { name: '指出下一步' }).click();
  await expect(page.locator('.lm-optic--hint')).toHaveCount(1);
  await page.getByRole('button', { name: '开启音效' }).click();
  await page.locator('.lm-optic--hint').click();
  await page.getByRole('button', { name: '关闭音效' }).click();
  expect(errors).toEqual([]);
});

test('每一关都能通过实际点击完成，通关星图与最终完成状态一致', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  for (const level of LEVELS) {
    await expect(page.locator('.lm-board')).toHaveAttribute('data-level', level.id);
    const start = initialRotations(level);
    const solution = [...solutions(level)].sort((a, b) =>
      a.filter((r, i) => r !== start[i]).length - b.filter((r, i) => r !== start[i]).length)[0];
    for (const [i, p] of level.pieces.entries()) {
      if (isRotatable(p) && solution[i] !== start[i]) await page.locator(`.lm-optic[data-piece="${i}"]`).click();
    }
    await expect(page.locator('.lm-result')).toHaveAttribute('data-stars', '3');
    await expect(page.locator('.lm-board')).toHaveAttribute('data-solved', 'true');
    if (level !== LEVELS[LEVELS.length - 1]) await page.locator('.lm-result button').click();
  }
  await expect(page.getByRole('heading', { name: '全部实验完成！' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(LEVELS.length));
  await page.reload();
  await expect(page.getByRole('heading', { name: '全部实验完成！' })).toBeVisible();
});

test('窄屏、深色、减少动态效果，关卡与帮助弹窗可操作', async ({ page }, testInfo) => {
  await open(page);
  await select(page, '22');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.lm-ray-flow').first()).toHaveCSS('animation-name', 'none');
  await expect.poll(() => page.locator('.lm-workbench').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(24, 26, 29)');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: '给点提示' }).click();
    await page.getByRole('button', { name: '指出下一步' }).click();
    await page.locator('.lm-optic--hint').click();
  }
  await page.screenshot({ path: testInfo.outputPath('lumen-desktop-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('lumen-mobile-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await expect.poll(() => page.locator('body').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(248, 250, 252)');
  await expect.poll(() => page.locator('.lm-bench-heading h2').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(15, 23, 42)');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('lumen-mobile-light.png'), fullPage: true });
  await page.getByRole('button', { name: '玩法说明' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '明白了，继续实验' }).click();
  await expect(page.getByRole('button', { name: '玩法说明' })).toBeFocused();
  await page.getByRole('button', { name: '关卡', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '关卡', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '玩法说明' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '玩法说明' })).toBeFocused();
});

test('浏览器拒绝存储时照样能玩', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
    Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
  });
  await open(page);
  await expect(page.locator('.lm-save-note')).toContainText('未允许存档');
  await page.locator('.lm-optic').click();
  await expect(page.locator('.lm-board')).toHaveAttribute('data-solved', 'true');
});
