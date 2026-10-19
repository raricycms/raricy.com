import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';
import { parseSnapshot, type Snapshot } from '../../shared/wand2/protocol';
import { blocked } from '../../shared/wand2/world';

function observe(page: Page) {
  const state: { id: string; snapshot: Snapshot | null; attack: boolean; hurt: boolean } = { id: '', snapshot: null, attack: false, hurt: false };
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/realtime/wand2')) return;
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const packet = JSON.parse(payload); if (packet.type === 'realtime.ready') state.id = packet.connectionId;
      const s = parseSnapshot(packet); if (s) { state.snapshot = s; state.attack ||= s.players.some(p => p.attack > 0); state.hurt ||= s.players.some(p => p.hurt > 0); }
    });
  });
  return state;
}

test('Wand 2 入口和认证独立于第一版', async ({ page }) => {
  await page.goto('/game/collections/test'); await page.getByRole('link', { name: /Wand demo 2/ }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgame%2Fwand2/);
  expect((await page.request.post('/api/game/wand2/launch')).status()).toBe(401);
});

test('Wand 2 向下走实际绘制四帧步态，停步后恢复待机', async ({ page }, info) => {
  await page.addInitScript(() => {
    const frames: number[][] = [];
    (window as Window & { __wandDownFrames?: number[][] }).__wandDownFrames = frames;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...coords: number[]) {
      if (image instanceof HTMLImageElement && image.src.endsWith('/walk-down.webp')
        && !frames.some(frame => frame[2] === coords[0])) {
        frames.push([image.naturalWidth, image.naturalHeight, ...coords.slice(0, 4)]);
      }
      Reflect.apply(draw, this, [image, ...coords]);
    };
  });
  await registerFreshUser(page); const state = observe(page);
  await page.goto('/game/wand2'); await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand2-status')).toContainText('已连接');
  await page.locator('canvas').focus(); await page.keyboard.down('ArrowDown');
  const frames = () => page.evaluate(() => (window as Window & { __wandDownFrames?: number[][] }).__wandDownFrames ?? []);
  await expect.poll(async () => (await frames()).length).toBe(4);
  expect((await frames()).sort((a, b) => a[2] - b[2])).toEqual([0, 1, 2, 3].map(col => [1024, 256, col * 256, 0, 256, 256]));
  await page.locator('canvas').screenshot({ path: info.outputPath('wand2-walk-down.png') });
  await page.keyboard.up('ArrowDown');
  await expect.poll(() => state.snapshot?.players.find(p => p.id === state.id)?.moving).toBe(false);
  await page.getByRole('button', { name: '离开草地' }).click();
});

test('Wand 2：美术、双客户端同步、真实战斗奖励、同账号排行与移动端操作', async ({ page, context, isMobile }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await registerFreshUser(page); const first = observe(page);
  await page.goto('/game/wand2'); await expect(page.getByRole('button', { name: '开始联机' })).toBeEnabled();
  for (const name of ['character', 'attack', 'world', 'walk-down']) {
    const result = await page.request.get(`/static/games/wand2/${name}.webp`); expect(result.status()).toBe(200); expect(result.headers()['content-type']).toContain('image/webp');
  }
  await page.getByRole('button', { name: '开始联机' }).click(); await expect(page.locator('.wand2-status')).toContainText('已连接');
  const observer = await context.newPage(), second = observe(observer);
  await observer.goto('/game/wand2'); await observer.getByRole('button', { name: '开始联机' }).click();
  await expect.poll(() => second.snapshot?.players.length).toBe(2);
  await expect(observer.locator('.wand2-leaderboard li')).toHaveCount(1);
  await page.bringToFront();
  const before = first.snapshot!.players.find(p => p.id === first.id)!.x;
  if (isMobile) {
    const button = page.getByRole('button', { name: '移动摇杆', exact: true }), box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2);
    await expect.poll(() => second.snapshot?.players.find(p => p.id === first.id)?.x ?? 0).toBeGreaterThan(before + 20); await page.mouse.up();
    const attack = page.getByRole('button', { name: '挥剑', exact: true }); await attack.tap(); await expect(attack).toHaveCSS('touch-action', 'none');
  } else {
    await page.locator('canvas').focus(); await page.keyboard.down('ArrowRight');
    await expect.poll(() => second.snapshot?.players.find(p => p.id === first.id)?.x ?? 0).toBeGreaterThan(before + 20); await page.keyboard.up('ArrowRight');
  }
  await page.locator('canvas').focus(); await page.keyboard.down('Space');
  const held = new Set<string>();
  // 使用真实键盘接近附近目标，服务端负责 AI、碰撞、命中与奖励。
  for (let i = 0; i < 320; i++) {
    const s = first.snapshot, p = s?.players.find(p => p.id === first.id); if (!s || !p) continue;
    if (p.catnip > 0) break;
    const target = s.slimes.filter(m => m.mood !== 'dying').sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const desired = new Set<string>();
    if (target) {
      let dx = target.x - p.x, dy = target.y - p.y;
      // 碎石侧边走垂直绕行，避免测试角色顶墙。
      if (blocked(p.x + Math.sign(dx) * 18, p.y) && Math.abs(dx) > 15) { dx = 0; dy = p.y < 320 ? -80 : 80; }
      if (Math.abs(dx) > 9) desired.add(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
      if (Math.abs(dy) > 9) desired.add(dy > 0 ? 'ArrowDown' : 'ArrowUp');
    }
    for (const code of held) if (!desired.has(code)) { await page.keyboard.up(code); held.delete(code); }
    for (const code of desired) if (!held.has(code)) { await page.keyboard.down(code); held.add(code); }
    await page.waitForTimeout(100);
  }
  for (const code of held) await page.keyboard.up(code); await page.keyboard.up('Space');
  expect(first.attack).toBe(true); expect(second.attack).toBe(true);
  expect(first.snapshot!.players.find(p => p.id === first.id)!.catnip).toBeGreaterThan(0);
  await expect.poll(() => second.snapshot?.leaderboard[0]?.catnip ?? 0).toBeGreaterThan(0);
  expect(first.snapshot!.players.find(p => p.id === first.id)!.catnip).toBe(first.snapshot!.players.find(p => p.id === second.id)!.catnip);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(() => { window.scrollTo(0, 0); document.documentElement.dataset.theme = 'dark'; });
  await expect(page.locator('.wand2-panel')).toHaveCSS('background-color', 'rgb(24, 26, 29)');
  await expect(page.locator('.wand2-header h1')).toHaveCSS('color', 'rgb(241, 245, 249)');
  await expect(page.locator('.wand2-guide p').first()).toHaveCSS('color', 'rgb(148, 163, 184)');
  await page.screenshot({ path: info.outputPath('wand2-play.png'), fullPage: true });
  await observer.getByRole('button', { name: '离开草地' }).click(); await expect.poll(() => first.snapshot?.players.length).toBe(1); await observer.close();
  await page.getByRole('button', { name: '离开草地' }).click(); await expect(page.locator('.wand2-status')).toHaveText('未连接');
  expect(errors).toEqual([]);
});

test('Wand 2 专注模式拒发票据并关闭已有连接', async ({ page }) => {
  await registerFreshUser(page); await page.goto('/game/wand2'); await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand2-status')).toContainText('已连接');
  expect((await page.request.patch('/api/users/me', { data: { focusMode: true } })).status()).toBe(200);
  expect((await page.request.post('/api/game/wand2/launch')).status()).toBe(403);
  await expect(page.locator('.wand2-panel').getByRole('alert')).toHaveText('账号状态已变化，连接已关闭。', { timeout: 15000 });
});
