import { test, expect, type Page } from '@playwright/test';
import type { Action } from '../../src/games/hinge/engine';
import { HINGE_SOLUTIONS } from '../helpers/hinge-solutions';

const names = ['上', '右', '下', '左'];
async function play(page: Page, actions: Action[]) {
  for (const action of actions) {
    if (action.type === 'walk') await page.getByRole('button', { name: `向${names[action.direction]}走`, exact: true }).click();
    else {
      await page.locator(`.hy-room[data-room="${action.room}"]`).click();
      await page.getByRole('button', { name: action.type === 'slide' ? `纸片向${names[action.direction]}滑动` : action.amount === 1 ? '顺时针旋转纸片' : '逆时针旋转纸片', exact: true }).click();
    }
  }
}
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test('五张练习可通过；切题、撤销重做与刷新续玩保留局面', async ({ page }) => {
  // 一条用例串联五次通关、切题和刷新；手机在棋盘与控件之间滚动更多。
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /合页 Demo(?! 2)/ }).click();
  await expect(page.locator('.hy-game')).toHaveAttribute('data-ready', 'true');
  for (const id of ['01', '02', '03', '04', '05']) {
    await page.getByRole('button', { name: new RegExp(`^${id} `) }).click();
    await play(page, HINGE_SOLUTIONS[id]);
    await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'true');
  }
  await expect(page.locator('.hy-progress')).toContainText('5 / 5');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'wait:0');
  await page.reload();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-level', '05');
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'wait:0');
  await page.getByRole('button', { name: '向右走', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: '重置本题', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'split:1');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'wait:0');
  expect(errors).toEqual([]);
});

test('新存档可直接解主谜题，载人和空载搬运保持各自的半间', async ({ page }) => {
  await page.goto('/game/hinge');
  await page.getByRole('button', { name: '主谜题', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-level', 'main');
  await play(page, HINGE_SOLUTIONS.main.slice(0, 2));
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'split:1');
  await expect(page.locator('.hy-room[data-room="split"]')).toHaveAttribute('data-x', '1');
  await expect(page.locator('.hy-room[data-room="split"]')).toHaveAttribute('data-y', '1');
  await play(page, HINGE_SOLUTIONS.main.slice(2, 8));
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'wait:0');
  await page.getByRole('button', { name: /^01 / }).click();
  await page.getByRole('button', { name: '主谜题：回到另一边', exact: true }).click();
  await expect(page.locator('.hy-room[data-room="split"]')).toHaveAttribute('data-x', '3');
  await play(page, HINGE_SOLUTIONS.main.slice(8));
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'true');
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'split:0');
  await expect(page.locator('.hy-progress')).toContainText('0 / 5');
  await page.reload();
  await expect(page.locator('.hy-progress')).toContainText('主谜题已完成');
});

test('键盘、拖动、提示、存储不可用和窄屏主题均可操作', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await page.goto('/game/hinge');
  await expect(page.locator('.hy-save-note')).toBeVisible();
  await page.getByRole('button', { name: /^02 / }).click();
  await page.locator('.hy-room[data-room="bridge"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'bridge:0');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.hy-feedback')).toContainText('没有地板');
  const room = page.locator('.hy-room[data-room="bridge"]');
  const box = (await room.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 1.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(room).toHaveAttribute('data-x', '2');
  await page.getByRole('button', { name: '向右走', exact: true }).click();
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'true');
  await page.getByRole('button', { name: /^04 / }).click();
  await page.getByRole('button', { name: '一点提示', exact: true }).click();
  await expect(page.locator('.hy-hints')).toContainText('地毯');
  await page.locator('.hy-room[data-room="split"]').focus();
  await page.keyboard.press('e');
  await page.keyboard.press('e');
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-player', 'split:0');
  await expect(page.locator('.hy-workspace')).toHaveAttribute('data-won', 'false');
  await page.keyboard.press('z');
  await expect(page.locator('.hy-room[data-room="split"]')).toHaveAttribute('data-turn', '1');
  await page.getByRole('button', { name: '主谜题：回到另一边', exact: true }).click();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole('button', { name: '向右走', exact: true })).toBeVisible();
    const size = (await page.getByRole('button', { name: '向右走', exact: true }).boundingBox())!;
    expect(size.width).toBeGreaterThanOrEqual(44); expect(size.height).toBeGreaterThanOrEqual(44);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.screenshot({ path: testInfo.outputPath(`hinge-${theme}.png`), fullPage: true });
  }
});
