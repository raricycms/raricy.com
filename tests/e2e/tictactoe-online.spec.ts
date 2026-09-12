// ─────────────────────────────────────────────────────────────────────────────
// tictactoe-online.spec.ts —— 井字棋联机对战端到端
//
// 【为什么要 E2E】与五子棋联机同理：两个浏览器 + 长连接 + 服务端权威，每一环都
// 可能在单测里完美通过而线上不可用（响应头少个 no-transform → 事件被攒到流结束才发；
// 「对方落子后我不刷新就能看到」只有真 EventSource 测得出）。
//
// 【与五子棋那份的分工】棋盘是 DOM（<button> 九宫格）而不是 canvas，所以这里
// **没有**「像素 → 交叉点」的换算测试，取而代之的是按 data-row/data-col 落子 ——
// 直接对应服务端收到的二维坐标。房间层的行为（幂等 join、判胜、回收）已由
// tests/service/{gomoku,tictactoe}-room.test.ts 覆盖，这里只测浏览器里的那条链路。
//
// 【跨游戏串号】两种棋共用一张房号表（board-room.ts 的注册表），所以额外钉一条
// 「井字棋的接口拿五子棋的房号必须 404」—— 共用注册表才可能出现这种串号。
//
// 【为什么用种子账号】联机要求 core+，而新注册用户是 plain。
// core / admin / owner 都是 core+，正好够「两人对局 + 一人观战」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

/** 落子。棋盘是 DOM 九宫格，直接按服务端要的二维坐标选格子。 */
async function clickCell(page: Page, row: number, col: number) {
  await page.locator(`.tictactoe-cell[data-row="${row}"][data-col="${col}"]`).click();
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
  await page.goto('/game/tictactoe');
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page.locator('.board-room-bar__code')).toBeVisible();

  const room = new URL(page.url()).searchParams.get('room');
  expect(room, '建房后 URL 里应带上房号（可分享链接的落点）').toBeTruthy();
  return room!;
}

test.describe('井字棋联机', () => {
  test('响应头必须带 no-transform（否则 next start 的压缩会攒帧）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const room = await createRoom(page);

    const headers = await page.evaluate(async (code) => {
      const ac = new AbortController();
      const res = await fetch(`/api/game/tictactoe/rooms/${code}/stream`, { signal: ac.signal });
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

  test('对方落子 → 本端不刷新就轮到自己（能秒到就是 SSE）', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);

      // B 打开 A 给的链接 → 自动入座执 O
      await b.page.goto(`/game/tictactoe?room=${room}`);
      await expect(b.page.locator('.board-status')).toHaveText('等对手落子…');
      await expect(a.page.locator('.board-status')).toHaveText('轮到你走');

      // A 落中心
      await clickCell(a.page, 1, 1);

      // B 端：状态变化 + DOM 上真的出现了 X，全程没有刷新
      await expect(b.page.locator('.board-status')).toHaveText('轮到你走');
      await expect(
        b.page.locator('.tictactoe-cell[data-row="1"][data-col="1"]')
      ).toHaveAttribute('data-mark', 'X');

      // 轮到 B：B 落子后 A 端也应立刻可见
      await clickCell(b.page, 0, 0);
      await expect(a.page.locator('.board-status')).toHaveText('轮到你走');
      await expect(
        a.page.locator('.tictactoe-cell[data-row="0"][data-col="0"]')
      ).toHaveAttribute('data-mark', 'O');
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('三连判胜：两端都看到结果，胜方与负方文案不同，胜线被标出', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);
      await b.page.goto(`/game/tictactoe?room=${room}`);
      await expect(b.page.locator('.board-status')).toHaveText('等对手落子…');

      // X（A）走第一行；O（B）在第二行应着，两格不成三连
      await clickCell(a.page, 0, 0);
      await clickCell(b.page, 1, 0);
      await clickCell(a.page, 0, 1);
      await clickCell(b.page, 1, 1);
      await clickCell(a.page, 0, 2);

      await expect(a.page.locator('.board-status')).toHaveText('你赢了！');
      await expect(b.page.locator('.board-status')).toHaveText('你输了');

      // 成三的三格被标记（服务端下发的 winningLine）
      for (const col of [0, 1, 2]) {
        await expect(
          a.page.locator(`.tictactoe-cell[data-row="0"][data-col="${col}"]`)
        ).toHaveClass(/tictactoe-cell--win/);
      }
      // 终局后不能再落子：九格全部点不动（已落的 5 格天然不可点，剩下 4 格
      // 因为轮次判定不再成立也一并禁用），且出现「再来一局」
      await expect(a.page.locator('.tictactoe-cell[disabled]')).toHaveCount(9);
      await expect(a.page.locator('.board-controls')).toContainText('再来一局');
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('满盘无三连 → 平局，双方文案一致', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page);
      await b.page.goto(`/game/tictactoe?room=${room}`);
      await expect(b.page.locator('.board-status')).toHaveText('等对手落子…');

      // 井字棋最经典的结局：九手走满，谁也连不成三子
      // X: (0,0) (0,2) (1,0) (2,1) (2,2)   O: (0,1) (1,1) (1,2) (2,0)
      const seq: Array<[Page, number, number]> = [
        [a.page, 0, 0],
        [b.page, 0, 1],
        [a.page, 0, 2],
        [b.page, 1, 1],
        [a.page, 1, 0],
        [b.page, 1, 2],
        [a.page, 2, 1],
        [b.page, 2, 0],
        [a.page, 2, 2],
      ];
      for (const [page, row, col] of seq) await clickCell(page, row, col);

      await expect(a.page.locator('.board-status')).toHaveText('平局！');
      await expect(b.page.locator('.board-status')).toHaveText('平局！');
      // 平局没有胜线
      await expect(a.page.locator('.tictactoe-cell--win')).toHaveCount(0);
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
      await b.page.goto(`/game/tictactoe?room=${room}`);
      await expect(b.page.locator('.board-status')).toHaveText('等对手落子…');

      await c.page.goto(`/game/tictactoe?room=${room}`);
      await expect(c.page.locator('.board-status')).toHaveText('观战中');
      await expect(c.page.locator('.board-hint')).toContainText('观战');
      await expect(c.page.locator('.board-seat--spec')).toContainText('围观 1');
      // 观众的九宫格全部禁用 —— 与棋手的不同，这里连「轮到我」都不会出现
      await expect(c.page.locator('.tictactoe-cell[disabled]')).toHaveCount(9);

      // 观众点击不产生任何落子。**必须 force** —— disabled 的按钮 Playwright 会
      // 一直等它变成可点，普通 click 只会挂到超时。force 之后这个用例反而更强：
      // 就算有人绕过禁用状态把点击事件塞进去，服务端也不认（观众 → notASeat）。
      await c.page
        .locator('.tictactoe-cell[data-row="0"][data-col="0"]')
        .click({ force: true });
      await a.page.waitForTimeout(500);
      await expect(a.page.locator('.board-status')).toHaveText('轮到你走');
      await expect(
        c.page.locator('.tictactoe-cell[data-row="0"][data-col="0"]')
      ).toHaveAttribute('data-mark', '');
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
      await b.page.goto(`/game/tictactoe?room=${room}`);
      await expect(b.page.locator('.board-status')).toHaveText('等对手落子…');

      await b.page.reload();

      // 还是后手席（data-seat="white" 里带「· 你」），没被挤成观众
      await expect(b.page.locator('.board-seat[data-seat="white"]')).toContainText('你');
      await expect(b.page.locator('.board-hint')).toHaveCount(0);
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('两种棋共用一张房号表：五子棋的房号在井字棋这边必须 404', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    // 用五子棋的接口开一间房
    const created = await page.request.post('/api/game/gomoku/rooms');
    expect(created.status()).toBe(200);
    const { room } = (await created.json()) as { room: { view: { code: string } } };
    const code = room.view.code;

    // 拿它去井字棋的接口：不是本游戏的房号，按不存在处理（不泄露房号是否存在）
    for (const verb of ['/join', '/claim', '/rematch', '/resign']) {
      const res = await page.request.post(`/api/game/tictactoe/rooms/${code}${verb}`);
      expect(res.status(), `POST ${verb} 应回 404`).toBe(404);
    }
    // 快照接口（GET）走的是同一条归属校验
    const snapshot = await page.request.get(`/api/game/tictactoe/rooms/${code}`);
    expect(snapshot.status()).toBe(404);

    // 直接带这个房号进井字棋页面：停在面板上并给出「房间不存在」
    await page.goto(`/game/tictactoe?room=${code}`);
    await expect(page.locator('.board-room-panel__error')).toContainText('房间不存在');
    await expect(page.locator('.tictactoe-board')).toHaveCount(0);
  });

  test('专注模式下联机不可用（服务端 403 + 页面给关闭入口）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.focus.username);

    const res = await page.request.post('/api/game/tictactoe/rooms');
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toContain('专注模式');

    await page.goto('/game/tictactoe');
    await expect(page.locator('.game-card--focus-lock')).toContainText('已开启专注模式');
    await expect(page.locator('a[href="/settings#focus-mode"]')).toBeVisible();
    await expect(page.locator('.tictactoe-board')).toHaveCount(0);
  });

  test('非核心用户进不去联机（403），也不渲染棋盘', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.request.post('/api/game/tictactoe/rooms');
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toContain('核心用户');

    // 井字棋没有单机分支，非核心用户整页进不去（与五子棋不同：那边单机匿名可玩）
    await page.goto('/game/tictactoe');
    await expect(page.locator('.tictactoe-board')).toHaveCount(0);
  });
});
