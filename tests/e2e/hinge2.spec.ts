import { test, expect, type Page } from '@playwright/test';
import { HINGE2_SOLUTIONS } from '../helpers/hinge2-solutions';
import type { Action } from '../../src/games/hinge2/engine';

test.use({ contextOptions: { reducedMotion: 'reduce' } });
async function play(page: Page, actions: Action[]) {
  for (const action of actions) {
    if (action.type === 'walk') {
      // The touch-friendly list also disambiguates coincident landings on two sheets.
      await page.getByRole('button', { name: '可达位置', exact: true }).click();
      const names: Record<string, string> = { d: '纸页出口', b: '倒影出口', f: '右页出口', r2: '倒影出口', e: '左页折痕接点', h: '右页出口', goal: '终点' };
      await page.getByLabel('可达位置列表', { exact: true }).getByRole('button', { name: new RegExp(`^${names[action.to]}`) }).click();
    } else if (action.type === 'turn') await page.getByRole('button', { name: action.amount === 1 ? '顺时针转动整页' : '逆时针转动整页', exact: true }).click();
    else if (action.type === 'mirror') await page.getByRole('button', { name: '转动镜面', exact: true }).click();
    else {
      const folded = await page.locator('.h2-workspace').getAttribute('data-folded');
      await page.getByRole('button', { name: folded === 'true' ? '展开右半页' : '对折右半页', exact: true }).click();
    }
  }
}

test('合集入口、四页通关、撤销重做与刷新续关', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /合页 Demo 2/ }).click();
  await expect(page.locator('.h2-game')).toHaveAttribute('data-ready', 'true');
  const ids = ['turn', 'mirror', 'fold', 'hinge'];
  for (const [i, id] of ids.entries()) {
    await page.getByRole('button', { name: new RegExp(`^0${i + 1} `) }).click();
    await play(page, HINGE2_SOLUTIONS[id]);
    await expect(page.locator('.h2-workspace')).toHaveAttribute('data-won', 'true');
  }
  await expect(page.locator('.h2-completion')).toContainText('4 / 4');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-player', 'h');
  await page.reload();
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-level', 'hinge');
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-player', 'h');
  await play(page, [{ type: 'walk', to: 'goal' }]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-player', 'start');
  expect(errors).toEqual([]);
});

test('纸景圆点、键盘机关与存储不可用', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await page.goto('/game/hinge2');
  await expect(page.locator('.h2-save-error')).toBeVisible();
  await page.locator('.h2-workspace').focus();
  await page.keyboard.press('e');
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-turn', '1');
  await page.getByRole('button', { name: '走到纸页出口', exact: true }).click();
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-player', 'd');
  await page.keyboard.press('q');
  // At the joined landing, an outside platform can cover the paper dot; keyboard activation
  // preserves access to every explicit landing without relying on paint order.
  await page.getByRole('button', { name: '走到终点', exact: true }).press('Enter');
  await expect(page.locator('.h2-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '提示', exact: true }).click();
  await expect(page.locator('.h2-hint')).toBeVisible();
  await page.getByRole('button', { name: /^04 / }).click();
});
