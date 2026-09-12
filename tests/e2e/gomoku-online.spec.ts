// ─────────────────────────────────────────────────────────────────────────────
// gomoku-online.spec.ts —— 五子棋联机对战端到端
//
// 【为什么要 E2E】联机是「两个浏览器 + 长连接 + 服务端权威」的组合，每一个都可能
// 在单测里完美通过而线上不可用：
//   · 响应头少一个 no-transform → next start 的压缩中间件把事件攒到流结束才发，
//     单测完全看不见（chat-sse.spec.ts 的头注释记着实测数据）；
//   · 「对方落子后我不刷新就能看到」只有真浏览器 + 真 EventSource 才测得出；
//   · 点击落子依赖「像素 → 棋盘格」的换算与画布尺寸，那是 canvas 上的东西，
//     单测碰不到。算错的表现是「点这儿落在隔壁」，不报错。
//
// 【为什么用种子账号而不是 registerFreshUser】联机要求 core+，而新注册用户是
// plain。core / admin / owner 都是 core+，正好够「两人对局 + 一人观战」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

/** 落子：(row, col) 是棋盘交叉点。换算依据见 GomokuCanvas 文件头。 */
async function clickCell(page: Page, row: number, col: number) {
  const canvas = page.locator('.gomoku-canvas');
  const { cell, margin } = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return { cell: Number(c.dataset.cellSize), margin: Number(c.dataset.margin) };
  });
  await canvas.click({ position: { x: margin + col * cell, y: margin + row * cell } });
}

/** 起一个独立登录态（独立 cookie jar = 另一个用户）。 */
async function asUser(browser: Browser, username: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaApi(page, username);
  return { ctx, page };
}

/** A 建房并返回房号（从 URL 里取，与真实用户复制链接的路径一致）。 */
async function createRoom(page: Page): Promise<string> {
  await page.goto('/game/gomoku?mode=online');
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page.locator('.gomoku-room-bar__code')).toBeVisible();

  const room = new URL(page.url()).searchParams.get('room');
  expect(room, '建房后 URL 里应带上房号（可分享链接的落点）').toBeTruthy();
  return room!;
}

test.describe('五子棋联机', () => {
  test('响应头必须带 no-transform（否则 next start 的压缩会攒帧）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const room = await createRoom(page);

    const headers = await page.evaluate(async (code) => {
      const ac = new AbortController();
      const res = await fetch(`/api/game/gomoku/rooms/${code}/stream`, { signal: ac.signal });
      const h = {
        contentType: res.headers.get('content-type'),
        cacheControl: res.headers.get('cache-control'),
      };
      ac.abort(); // 只看响应头，立刻断掉，别留一条空连接
      return h;
    }, room);

    expect(headers.contentType).toContain('text/event-stream');
    expect(headers.cacheControl).toContain('no-transform');
  });

  test('对方落子 → 本端不刷新就轮到自己（对账只有重连，能秒到就是 SSE）', async ({
    browser,
  }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);

      // B 打开 A 给的链接 → 自动入座执白
      await b.page.goto(`/game/gomoku?mode=online&room=${room}`);
      await expect(b.page.locator('.gomoku-status')).toHaveText('等对手落子…');
      await expect(a.page.locator('.gomoku-status')).toHaveText('轮到你走');

      // A 在中心落一子
      const beforePaint = await b.page.locator('.gomoku-canvas').evaluate((c) => (c as HTMLCanvasElement).toDataURL());
      await clickCell(a.page, 7, 7);

      // B 端：状态变化 + 画布真的重绘了（棋子出现），全程没有刷新
      await expect(b.page.locator('.gomoku-status')).toHaveText('轮到你走');
      const afterPaint = await b.page.locator('.gomoku-canvas').evaluate((c) => (c as HTMLCanvasElement).toDataURL());
      expect(afterPaint, 'B 的棋盘应已重绘出新落的子').not.toBe(beforePaint);

      // 轮到 B：B 落子后 A 端也应立刻可见
      await clickCell(b.page, 8, 8);
      await expect(a.page.locator('.gomoku-status')).toHaveText('轮到你走');
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('五连判胜：两端都看到结果，胜方与负方文案不同', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);
      await b.page.goto(`/game/gomoku?mode=online&room=${room}`);
      await expect(b.page.locator('.gomoku-status')).toHaveText('等对手落子…');

      // 黑（A）连成 (7,3)~(7,7)；白（B）在别处应着，四子不成五
      for (let i = 0; i < 5; i++) {
        await clickCell(a.page, 7, 3 + i);
        if (i < 4) await clickCell(b.page, 9, 3 + i);
      }

      await expect(a.page.locator('.gomoku-status')).toHaveText('你赢了！');
      await expect(b.page.locator('.gomoku-status')).toHaveText('你输了');
      // 终局后不能再落子
      await expect(b.page.locator('.gomoku-controls')).toContainText('再来一局');
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('第三人进入即观战：看得到棋盘，点不动', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    const c = await asUser(browser, SEED_USERS.owner.username);
    try {
      const room = await createRoom(a.page);
      await b.page.goto(`/game/gomoku?mode=online&room=${room}`);
      await expect(b.page.locator('.gomoku-status')).toHaveText('等对手落子…');

      await c.page.goto(`/game/gomoku?mode=online&room=${room}`);
      await expect(c.page.locator('.gomoku-status')).toHaveText('观战中');
      await expect(c.page.locator('.gomoku-hint')).toContainText('观战');
      await expect(c.page.locator('.gomoku-seat--spec')).toContainText('围观 1');

      // 观众点击不产生任何落子：甲端状态不变
      const before = await c.page.locator('.gomoku-canvas').evaluate((x) => (x as HTMLCanvasElement).toDataURL());
      await clickCell(c.page, 7, 7);
      await a.page.waitForTimeout(500);
      await expect(a.page.locator('.gomoku-status')).toHaveText('轮到你走');
      const after = await c.page.locator('.gomoku-canvas').evaluate((x) => (x as HTMLCanvasElement).toDataURL());
      expect(after, '观众的点击不该改变棋盘').toBe(before);
    } finally {
      await a.ctx.close();
      await b.ctx.close();
      await c.ctx.close();
    }
  });

  test('刷新页面回到原座（join 幂等），不是变成观众', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);
      await b.page.goto(`/game/gomoku?mode=online&room=${room}`);
      await expect(b.page.locator('.gomoku-status')).toHaveText('等对手落子…');

      await b.page.reload();

      // 还是白方（.gomoku-seat--white 里带「· 你」），没被挤成观众
      await expect(b.page.locator('.gomoku-seat--white')).toContainText('你');
      await expect(b.page.locator('.gomoku-hint')).toHaveCount(0);
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('专注模式下联机不可用（服务端 403 + 页面给关闭入口）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.focus.username);

    const res = await page.request.post('/api/game/gomoku/rooms');
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toContain('专注模式');

    await page.goto('/game/gomoku?mode=online');
    await expect(page.locator('.game-card--focus-lock')).toContainText('已开启专注模式');
    await expect(page.locator('a[href="/settings#focus-mode"]')).toBeVisible();
    await expect(page.locator('.gomoku-canvas')).toHaveCount(0);
  });

  test('非核心用户进不去联机（403），单机仍然匿名可玩', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.request.post('/api/game/gomoku/rooms');
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toContain('核心用户');

    // 单机不受影响：仍然是棋盘，不是权限页
    await page.goto('/game/gomoku');
    await expect(page.locator('.gomoku-canvas')).toBeVisible();
  });
});
