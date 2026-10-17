import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

function observe(page: Page) {
  const state = { id: '', players: new Map<string, { x?: number; y?: number }>(), inputs: 0 };
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/realtime/quandi')) return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string' && JSON.parse(payload).type === 'C2S_PLAYER_INPUT') state.inputs++;
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const packet = JSON.parse(payload);
      if (packet.type === 'realtime.ready') state.id = packet.connectionId;
      if (packet.type === 'S2C_GAME_STATE') for (const player of packet.data.players) {
        state.players.set(player.id, { ...state.players.get(player.id), ...player });
      }
    });
  });
  return state;
}

test('圈地运动：匿名不可进入、游戏文档独立鉴权、专注模式拦住静态文档和票据', async ({ page }) => {
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /圈地运动/ }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgame%2Fquandi/);
  expect((await page.request.get('/game/quandi/play')).status()).toBe(401);
  expect((await page.request.post('/api/game/quandi/launch')).status()).toBe(401);
  await registerFreshUser(page);
  const response = await page.request.get('/game/quandi/play');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts;');
  expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(response.headers()['content-security-policy']).not.toContain('frame-ancestors');
  expect((await page.request.patch('/api/users/me', { data: { focusMode: true } })).status()).toBe(200);
  expect((await page.request.get('/game/quandi/play')).status()).toBe(403);
  expect((await page.request.post('/api/game/quandi/launch')).status()).toBe(403);
  await page.goto('/game/quandi');
  await expect(page.getByRole('heading', { name: '已开启专注模式' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('圈地运动：隔离账号 Cookie/父页/直接联网，六种本地模式均可开始，ESC 返回', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await registerFreshUser(page);
  await page.goto('/game/quandi');
  await expect(page.locator('.quandi-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  const game = page.frameLocator('.quandi-frame');
  await expect(game.getByRole('button', { name: '本地双人' })).toBeVisible();
  const frame = page.frames().find((entry) => entry.url().endsWith('/game/quandi/play'))!;
  expect(await frame.evaluate(() => {
    let blocked = 0;
    try { void document.cookie; } catch { blocked++; }
    try { void parent.document.body; } catch { blocked++; }
    return blocked;
  })).toBe(2);
  expect(await frame.evaluate(async () => { try { await fetch('/api/users/me'); return false; } catch { return true; } })).toBe(true);
  for (const mode of ['explore', 'fight', 'infinite', 'survival', 'capture', 'daynight']) {
    await game.locator('#gamemodeSelect').selectOption(mode);
    await game.getByRole('button', { name: '本地双人' }).click();
    await expect.poll(() => frame.evaluate(() => (window as any).gameEngine.gameState)).toBe('playing');
    await expect(game.locator('#gameCanvas')).toBeVisible();
    await game.locator('#gameCanvas').click();
    await page.keyboard.press('Escape');
    await expect(game.getByRole('button', { name: '本地双人' })).toBeVisible();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('quandi-menu.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

for (const mode of ['explore', 'fight', 'infinite', 'survival', 'capture', 'daynight']) {
test(`圈地运动 ${mode}：真实账号双人联机、移动同步、断线清理`, async ({ page, browser }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const firstUser = await registerFreshUser(page);
  const first = observe(page);
  await page.goto('/game/quandi');
  const a = page.frameLocator('.quandi-frame');
  await a.getByRole('button', { name: '联机对战', exact: true }).click();
  await expect(page.locator('.quandi-status')).toHaveText('已连接');
  await expect(a.locator('#playerNameInput')).toHaveText(firstUser.username);
  await a.locator('#onlineModeSelect').selectOption(mode);
  await a.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(a.locator('#roomWaiting')).toBeVisible();
  const code = await a.locator('#displayRoomCode').textContent();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    other.on('pageerror', (error) => errors.push(error.message));
    const secondUser = await registerFreshUser(other);
    const second = observe(other);
    await other.goto('/game/quandi');
    const b = other.frameLocator('.quandi-frame');
    await b.getByRole('button', { name: '联机对战', exact: true }).click();
    await expect(other.locator('.quandi-status')).toHaveText('已连接');
    await b.locator('#roomCodeInput').fill(code!);
    await b.getByRole('button', { name: '加入房间', exact: true }).click();
    await expect(a.locator('#playerSlots')).toContainText(secondUser.username);
    await a.getByRole('button', { name: '准备', exact: true }).click();
    await b.getByRole('button', { name: '准备', exact: true }).click();
    await a.getByRole('button', { name: '开始游戏', exact: true }).click();
    const frame = page.frames().find((entry) => entry.url().endsWith('/game/quandi/play'))!;
    await expect.poll(() => frame.evaluate(() => (window as any).gameEngine.gameState)).toBe('playing');
    await expect.poll(() => second.players.get(first.id)?.x).toBe(180);
    await page.bringToFront();
    await a.locator('#gameCanvas').click();
    await page.keyboard.down('d');
    await expect.poll(() => second.players.get(first.id)?.x ?? 0).toBeGreaterThan(200);
    await page.keyboard.up('d');
    expect(first.inputs).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('quandi-online.png'), fullPage: true, animations: 'disabled' });
    await other.close();
    await expect(a.locator('#gameOverTitle')).toHaveText('你赢了! 🏆');
    if (mode === 'fight') {
      expect((await page.request.patch('/api/users/me', { data: { focusMode: true } })).status()).toBe(200);
      await expect(page.locator('.quandi-error')).toHaveText('账号状态已变化，连接已关闭。', { timeout: 15_000 });
      expect((await page.request.post('/api/game/quandi/launch')).status()).toBe(403);
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
}

test('圈地运动：真实连接拒绝畸形消息和伪造昵称，服务继续可用', async ({ page }) => {
  await registerFreshUser(page);
  await page.goto('/game/quandi');
  for (const payload of ['null', '{"type":"C2S_CREATE_ROOM","data":{"mode":"fight","difficulty":"medium","playerName":"forged"}}']) {
    const result = await page.evaluate(async (message) => {
      const launch = await (await fetch('/api/game/quandi/launch', { method: 'POST' })).json();
      return new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(launch.wsUrl);
        const timer = setTimeout(() => { socket.close(); reject(new Error('socket timeout')); }, 5000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: launch.ticket }));
        socket.onmessage = (event) => { if (JSON.parse(event.data).type === 'realtime.ready') socket.send(message); };
        socket.onclose = (event) => { clearTimeout(timer); resolve(event.code); };
        socket.onerror = () => reject(new Error('socket error'));
      });
    }, payload);
    expect(result).toBe(1000);
  }
  const game = page.frameLocator('.quandi-frame');
  await game.getByRole('button', { name: '联机对战', exact: true }).click();
  await expect(page.locator('.quandi-status')).toHaveText('已连接');
  await game.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(game.locator('#roomWaiting')).toBeVisible();
  const frame = page.frames().find((entry) => entry.url().endsWith('/game/quandi/play'))!;
  await frame.evaluate(() => {
    (window as any).updateRoomWaitingUI({ hostPlayerId: 'probe', gameConfig: { mode: 'fight', difficulty: 'medium' }, roomCode: 'ABCDEF',
      players: [{ slotIndex: 0, playerId: 'probe', name: '<img src=x onerror="document.body.dataset.injected=1">' }] });
  });
  await expect(game.locator('#playerSlots')).toContainText('<img src=x');
  await expect(game.locator('#playerSlots img')).toHaveCount(0);
});
