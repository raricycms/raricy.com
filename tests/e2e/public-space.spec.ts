import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

test('公共空间入口需要登录，专注模式不能获取票据', async ({ page }) => {
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /公共空间/ }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgame%2Fpublic-space/);
  expect((await page.request.post('/api/game/public-space/launch')).status()).toBe(401);
  await registerFreshUser(page);
  await page.request.patch('/api/users/me', { data: { focusMode: true } });
  expect((await page.request.post('/api/game/public-space/launch')).status()).toBe(403);
});

test('公共空间：多人头像、占位、换位、观众席、多标签与离线清理', async ({ page, browser, context }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const first = await registerFreshUser(page);
  await page.goto('/game/public-space');
  await expect(page.locator('.public-space-status')).toContainText('已连接');
  await expect(page.locator('.public-space-cell')).toHaveCount(25);
  await expect(page.locator('.public-space-spectators .avatar')).toHaveCount(1);
  const otherContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL,
    viewport: page.viewportSize(), isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
  try {
    const other = await otherContext.newPage();
    let dropTraffic = false;
    await other.routeWebSocket('**/realtime/public-space', (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((data) => { if (!dropTraffic) server.send(data); });
      server.onMessage((data) => { if (!dropTraffic) socket.send(data); });
    });
    const second = await registerFreshUser(other);
    await other.goto('/game/public-space');
    await expect(other.locator('.public-space-status')).toContainText('2 人在线');
    const cell = page.locator('.public-space-cell').nth(0);
    await cell.click();
    await expect(cell.locator('.avatar__img')).toHaveAttribute('alt', first.username);
    await expect(other.locator('.public-space-cell').nth(0)).toBeDisabled();
    await other.locator('.public-space-cell').nth(1).click();
    await expect(page.locator('.public-space-cell').nth(1).locator('.avatar__img')).toHaveAttribute('alt', second.username);
    await expect(page.locator('.public-space-spectators')).toHaveCount(0);
    await page.locator('.public-space-cell').nth(12).click();
    await expect(other.locator('.public-space-cell').nth(0)).toBeEnabled();
    await expect(other.locator('.public-space-cell').nth(12).locator('.avatar__img')).toHaveAttribute('alt', first.username);
    await page.getByRole('button', { name: '回到观众席', exact: true }).click();
    await expect(other.locator('.public-space-spectators .avatar__img')).toHaveAttribute('alt', first.username);
    const duplicate = await context.newPage();
    await duplicate.goto('/game/public-space');
    await expect(duplicate.locator('.public-space-status')).toContainText('2 人在线');
    await page.locator('.public-space-cell').nth(24).click();
    await expect(duplicate.locator('.public-space-cell--mine')).toHaveCount(1);
    await duplicate.close();
    await expect(page.locator('.public-space-status')).toContainText('2 人在线');
    await expect(page.locator('.public-space-cell--mine')).toHaveCount(1);
    await page.locator('.public-space-cell--mine').click();
    await expect(page.locator('.public-space-cell--mine')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    const box = (await page.locator('.public-space-cell').first().boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath('public-space-light.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await expect(page.locator('.public-space-panel')).toHaveCSS('background-color', 'rgb(24, 26, 29)');
    await expect(page.locator('.public-space-spectators .public-space-name')).toHaveCSS('color', 'rgb(241, 245, 249)');
    await page.screenshot({ path: testInfo.outputPath('public-space-dark.png'), fullPage: true });
    // 模拟链路静默：不发送关闭帧，双向丢包；服务端应在超时后释放座位。
    dropTraffic = true;
    await expect(page.locator('.public-space-status')).toContainText('1 人在线', { timeout: 25_000 });
    await expect(page.locator('.public-space-cell').nth(1)).toBeEnabled();
    await page.getByRole('button', { name: '离开空间', exact: true }).click();
    await expect(page.locator('.public-space-status')).toHaveText('已离开');
    await expect(page.locator('.public-space-avatar')).toHaveCount(0);
    await page.getByRole('button', { name: '重新连接' }).click();
    await expect(page.locator('.public-space-status')).toContainText('已连接');
    await page.goto('/game');
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});
