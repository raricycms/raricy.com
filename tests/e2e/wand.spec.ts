import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';
import { parseWandSnapshot, type WandSnapshot } from '../../shared/wand/protocol';

function observeGame(page: Page) {
  const state: { id: string; snapshot: WandSnapshot | null; binarySent: boolean } = { id: '', snapshot: null, binarySent: false };
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/realtime/wand')) return;
    socket.on('framesent', ({ payload }) => { if (Buffer.isBuffer(payload)) state.binarySent = true; });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const message = JSON.parse(payload);
      if (message.type === 'realtime.ready') state.id = message.connectionId;
      const snapshot = parseWandSnapshot(message);
      if (snapshot) state.snapshot = snapshot;
    });
  });
  return state;
}

test('测试合集有 Wand，匿名玩家需登录，未知合集返回 404', async ({ page }) => {
  await page.goto('/game');
  await page.getByRole('link', { name: /测试.*查看合集/ }).click();
  await expect(page).toHaveURL('/game/collections/test');
  await expect(page.locator('.game-card')).toHaveCount(2);
  await page.getByRole('link', { name: /Wand demo/ }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgame%2Fwand/);
  expect((await page.request.post('/api/game/wand/launch')).status()).toBe(401);
  expect((await page.goto('/game/collections/unknown'))!.status()).toBe(404);
});

test('Wand：真实票据、多玩家移动同步、移动端方向按钮与断开清理', async ({ page, context, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await registerFreshUser(page);
  const first = observeGame(page);
  await page.goto('/game/wand');
  await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand-status')).toContainText('已连接');
  const observer = await context.newPage();
  const second = observeGame(observer);
  await observer.goto('/game/wand');
  await observer.getByRole('button', { name: '开始联机' }).click();
  await expect(observer.locator('.wand-status')).toContainText('已连接');
  await expect.poll(() => second.snapshot?.players.some((player) => player.id === first.id)).toBe(true);
  await page.bringToFront();
  const before = first.snapshot!.players.find((player) => player.id === first.id)!.x;
  if (isMobile) {
    const button = page.getByRole('button', { name: '向右', exact: true });
    await button.tap();
    await expect(button).toHaveCSS('touch-action', 'none');
    const box = (await button.boundingBox())!;
    // WebKit 没有 CDP 的长按接口，用真实指针按住同一方向按钮验证持续输入。
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  } else await page.keyboard.down('ArrowRight');
  await expect.poll(() => second.snapshot?.players.find((player) => player.id === first.id)?.x ?? 0).toBeGreaterThan(before + 15);
  if (isMobile) {
    await page.mouse.up();
  } else await page.keyboard.up('ArrowRight');
  expect(first.binarySent).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(() => { window.scrollTo(0, 0); document.documentElement.dataset.theme = 'dark'; });
  await expect(page.locator('.wand-panel')).toHaveCSS('background-color', 'rgb(24, 26, 29)');
  await expect(page.locator('.wand-panel h1')).toHaveCSS('color', 'rgb(241, 245, 249)');
  await page.screenshot({ path: testInfo.outputPath('wand-dark.png'), fullPage: true });
  await observer.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect.poll(() => first.snapshot?.players.some((player) => player.id === second.id)).toBe(false);
  await observer.close();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(page.locator('.wand-status')).toHaveText('未连接');
  expect(errors).toEqual([]);
});

test('开启专注模式后不能申请票据，已建联机也会关闭', async ({ page }) => {
  await registerFreshUser(page);
  await page.goto('/game/wand');
  await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand-status')).toContainText('已连接');
  expect((await page.request.patch('/api/users/me', { data: { focusMode: true } })).status()).toBe(200);
  expect((await page.request.post('/api/game/wand/launch')).status()).toBe(403);
  await expect(page.locator('.wand-panel').getByRole('alert')).toHaveText('账号状态已变化，连接已关闭。', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
});
