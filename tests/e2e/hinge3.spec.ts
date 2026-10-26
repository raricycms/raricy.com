import { test, expect, type Page } from '@playwright/test';
import type { Action } from '../../src/games/hinge3/engine';
import { HINGE3_SOLUTIONS } from '../helpers/hinge3-solutions';

test.use({ contextOptions: { reducedMotion: 'reduce' } });
async function play(page: Page, actions: Action[]) {
  for (const action of actions) {
    if (action.type === 'fold') {
      await page.locator('.h3-crease-options').getByRole('button', { name: `选择折痕 ${action.crease}`, exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`^沿 ${action.crease} 折起$`) }).click();
    } else if (action.type === 'press') await page.getByRole('button', { name: '压印', exact: true }).click();
    else if (action.type === 'unfold') await page.getByRole('button', { name: '展开纸页', exact: true }).click();
    else {
      const face = await page.locator('.h3-workspace').getAttribute('data-face');
      await page.getByRole('button', { name: face === 'front' ? '翻到背面' : '翻到正面', exact: true }).click();
    }
  }
}

test('五张纸的真实转印、双面目标、撤销重做和存档回放', async ({ page }, testInfo) => {
  test.setTimeout(75_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /合页 Demo 3/ }).click();
  await expect(page.locator('.h3-game')).toHaveAttribute('data-ready', 'true');
  await page.screenshot({ path: testInfo.outputPath('hinge3-initial.png'), fullPage: true });
  for (const [i, id] of ['first', 'twice', 'window', 'reverse', 'register'].entries()) {
    await page.getByRole('button', { name: new RegExp(`^0${i + 1}`) }).click();
    await play(page, HINGE3_SOLUTIONS[id]);
    await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'true');
  }
  await expect(page.locator('.h3-progress')).toContainText('5 / 5');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-fold', 'A');
  await page.reload();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-level', 'register');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-face', 'back');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-pressed', 'true');
  await page.getByRole('button', { name: '展开纸页', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'false');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-face', 'front');
  expect(errors).toEqual([]);
});

test('洞会阻止转印，压印前后可以逐步撤销，键盘可完成一页', async ({ page }) => {
  await page.goto('/game/hinge3');
  await page.getByRole('button', { name: /^03/ }).click();
  await play(page, [{ type: 'fold', crease: 'A' }, { type: 'press' }]);
  await expect(page.getByRole('status')).toContainText('没有墨接触');
  await expect(page.locator('.h3-target[data-status="matched"]')).toHaveCount(0);
  await play(page, [{ type: 'unfold' }]);
  await expect(page.locator('.h3-mark.is-wet')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-pressed', 'false');
  await page.getByRole('button', { name: /^01/ }).click();
  await page.locator('.h3-workspace').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-fold', 'A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '沿 A 折起', exact: true }).focus();
  await page.keyboard.press('f');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-face', 'back');
});

test('纸上拖动、取消手势、存储禁用及窄屏明暗主题', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await page.goto('/game/hinge3');
  await expect(page.locator('.h3-save-note.is-error')).toBeVisible();
  const grip = page.getByRole('button', { name: '拖动折起纸页', exact: true });
  await grip.scrollIntoViewIfNeeded();
  const svg = await page.locator('.h3-paper-art').boundingBox();
  const box = await grip.boundingBox();
  expect(svg && box).toBeTruthy();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + svg!.width * .08, y, { steps: 3 }); await page.mouse.up();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-fold', '');
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-dragging', 'false');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + svg!.width * .72, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-fold', 'A');
  await page.getByRole('button', { name: '点击折页压印', exact: true }).click();
  await page.getByRole('button', { name: '展开纸页', exact: true }).click();
  await expect(page.locator('.h3-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: /^05/ }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; window.scrollTo(0, 0); }, theme);
      await expect.poll(() => page.locator('body').evaluate((element) => getComputedStyle(element).color)).toBe(theme === 'dark' ? 'rgb(241, 245, 249)' : 'rgb(15, 23, 42)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const controls = await page.locator('.h3-press-controls').boundingBox();
      expect(controls!.x).toBeGreaterThanOrEqual(15);
      expect(controls!.x + controls!.width).toBeLessThanOrEqual(width - 15);
      await page.screenshot({ path: testInfo.outputPath(`hinge3-${width}-${theme}.png`), fullPage: true });
    }
  }
});
