// ─────────────────────────────────────────────────────────────────────────────
// board-game-helpers.ts —— 三款走子类棋的 e2e 共用工具
//
// 【为什么抽出来】国际象棋 / 中国象棋 / 国际跳棋的联机用例除了"棋盘选择器"和
// "走哪几步"之外完全一样（建房、入座、SSE 实时、观战、刷新回原座、跨游戏 404、
// 专注模式、非 core+）。各写一份的话，改一处断言要改三处，漏掉的那款不会有
// 任何提示 —— 与 board-room.ts 抽房间层是同一个理由。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

/** 走子类棋的棋盘选择器。各棋的格子类名与"可点的格子"筛选条件不同。 */
export interface BoardSelectors {
  /** 棋盘容器（用来断言"棋盘渲染出来了"）。 */
  board: string;
  /** 可点的格子。跳棋只有深色格可点，所以这里会带上修饰类。 */
  square: string;
}

export const CHESS_BOARD: BoardSelectors = { board: '.chess-board', square: '.chess-square' };
export const XIANGQI_BOARD: BoardSelectors = { board: '.xiangqi-board', square: '.xiangqi-point' };
export const DRAUGHTS_BOARD: BoardSelectors = {
  board: '.draughts-board',
  square: '.draughts-square--dark',
};

/** 起一个独立登录态（独立 cookie jar = 另一个用户）。 */
export async function asUser(browser: Browser, username: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaApi(page, username);
  return { ctx, page };
}

/** A 建房并返回房号（从 URL 里取，与真实用户复制链接的路径一致）。 */
export async function createRoom(page: Page, game: string): Promise<string> {
  await page.goto(`/game/${game}?mode=online`);
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page.locator('.board-room-bar__code')).toBeVisible();

  const room = new URL(page.url()).searchParams.get('room');
  expect(room, '建房后 URL 里应带上房号（可分享链接的落点）').toBeTruthy();
  return room!;
}

/** 点一个格子。坐标是**服务端坐标**（row, col），与棋盘的 data-row/data-col 一致。 */
export async function clickSquare(
  page: Page,
  sel: BoardSelectors,
  row: number,
  col: number
): Promise<void> {
  await page.locator(`${sel.square}[data-row="${row}"][data-col="${col}"]`).click();
}

/**
 * 走一手：先点起点，再点终点。
 * 跳棋的连吃是一条含多个落点的路径 —— 用 `hops` 传全部落点（不含起点）。
 */
export async function playMove(
  page: Page,
  sel: BoardSelectors,
  from: [number, number],
  ...hops: Array<[number, number]>
): Promise<void> {
  await clickSquare(page, sel, from[0], from[1]);
  for (const [r, c] of hops) await clickSquare(page, sel, r, c);
}

/** 某格上是什么（`data-piece`，取值来自各棋规则模块的 glyphOf）。 */
export function pieceAt(page: Page, sel: BoardSelectors, row: number, col: number) {
  return page.locator(`${sel.square}[data-row="${row}"][data-col="${col}"]`);
}

/** 一套对所有走子类棋都成立的用例 —— 三款棋各自调一次。 */
export function describeCommonOnlineRules(opts: {
  game: string;
  label: string;
  sel: BoardSelectors;
  /** 一组合法的开局着法（白/红先）：从 → 到。 */
  firstMove: { from: [number, number]; hops: Array<[number, number]> };
  /** 走完 firstMove 之后，起点与终点上分别应该是什么（data-piece）。 */
  expectAfterFirstMove: { from: string; to: string };
  /** 该棋的房号在**另一款**走子类棋的接口上必须 404（跨游戏隔离）。 */
  otherGame: string;
}): void {
  const { game, label, sel, firstMove, expectAfterFirstMove, otherGame } = opts;

  test.describe(`${label}联机`, () => {
    test('响应头必须带 no-transform（否则 next start 的压缩会攒帧）', async ({ page }) => {
      await loginViaApi(page, SEED_USERS.core.username);
      const room = await createRoom(page, game);

      // 【参数要显式传】page.evaluate 的回调在**浏览器**里执行，闭包抓不到 Node 侧的
      // 变量 —— 直接引用 `game` 会是 ReferenceError: game is not defined。
      const headers = await page.evaluate(
        async ({ game: g, code }) => {
          const ac = new AbortController();
          const res = await fetch(`/api/game/${g}/rooms/${code}/stream`, { signal: ac.signal });
          const h = {
            contentType: res.headers.get('content-type'),
            cacheControl: res.headers.get('cache-control'),
          };
          ac.abort(); // 只看响应头，立刻断掉，别留一条空连接
          return h;
        },
        { game, code: room }
      );

      expect(headers.contentType).toContain('text/event-stream');
      expect(headers.cacheControl).toContain('no-transform');
    });

    test('对方走子 → 本端不刷新就看到（能秒到就是 SSE）', async ({ browser }) => {
      const a = await asUser(browser, SEED_USERS.core.username);
      const b = await asUser(browser, SEED_USERS.admin.username);
      try {
        const room = await createRoom(a.page, game);
        await b.page.goto(`/game/${game}?mode=online&room=${room}`);
        await expect(b.page.locator(sel.board)).toBeVisible();

        await playMove(a.page, sel, firstMove.from, ...firstMove.hops);

        // B 端：B 是后手，A 走完之后轮到 B
        await expect(b.page.locator('.board-status')).toContainText('轮到你走');
        await expect(pieceAt(b.page, sel, ...firstMove.hops[firstMove.hops.length - 1])).toHaveAttribute(
          'data-piece',
          expectAfterFirstMove.to
        );
        await expect(pieceAt(b.page, sel, ...firstMove.from)).toHaveAttribute(
          'data-piece',
          expectAfterFirstMove.from
        );
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
        const room = await createRoom(a.page, game);
        await b.page.goto(`/game/${game}?mode=online&room=${room}`);
        await expect(b.page.locator(sel.board)).toBeVisible();

        await c.page.goto(`/game/${game}?mode=online&room=${room}`);
        await expect(c.page.locator('.board-status')).toHaveText('观战中');
        await expect(c.page.locator('.board-hint')).toContainText('观战');
        await expect(c.page.locator('.board-seat--spec')).toContainText('围观 1');

        // 观众点击不产生任何着法。**必须 force** —— disabled 的元素 Playwright
        // 会一直等它变成可点，普通 click 只会挂到超时。force 之后用例反而更强：
        // 就算有人绕过禁用状态把点击塞进去，服务端也不认（观众 → notASeat）。
        // 只做 force 点击：普通 click 在 disabled 元素上会一直等到用例超时
        await c.page
          .locator(`${sel.square}[data-row="${firstMove.from[0]}"][data-col="${firstMove.from[1]}"]`)
          .click({ force: true });
        await a.page.waitForTimeout(400);
        await expect(a.page.locator('.board-status')).toContainText('轮到你走');
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
        const room = await createRoom(a.page, game);
        await b.page.goto(`/game/${game}?mode=online&room=${room}`);
        await expect(b.page.locator(sel.board)).toBeVisible();

        await b.page.reload();

        await expect(b.page.locator('.board-seat[data-seat="white"]')).toContainText('你');
        await expect(b.page.locator('.board-hint')).toHaveCount(0);
      } finally {
        await a.ctx.close();
        await b.ctx.close();
      }
    });

    test('认输：两端文案不同，赢家是对手', async ({ browser }) => {
      const a = await asUser(browser, SEED_USERS.core.username);
      const b = await asUser(browser, SEED_USERS.admin.username);
      try {
        const room = await createRoom(a.page, game);
        await b.page.goto(`/game/${game}?mode=online&room=${room}`);
        await expect(b.page.locator(sel.board)).toBeVisible();

        await b.page.getByRole('button', { name: '认输' }).click();

        await expect(a.page.locator('.board-status')).toContainText('你赢了！');
        await expect(a.page.locator('.board-status')).toContainText('对手认输');
        await expect(b.page.locator('.board-status')).toContainText('你输了');
        await expect(b.page.locator('.board-status')).toContainText('你已认输');
        // 终局后出现「再来一局」
        await expect(a.page.locator('.board-controls')).toContainText('再来一局');
      } finally {
        await a.ctx.close();
        await b.ctx.close();
      }
    });

    test('共用一张房号表：另一款棋的接口拿到本房号必须 404', async ({ page }) => {
      await loginViaApi(page, SEED_USERS.owner.username);

      const created = await page.request.post(`/api/game/${game}/rooms`);
      expect(created.status()).toBe(200);
      const { room } = (await created.json()) as { room: { view: { code: string } } };
      const code = room.view.code;

      for (const verb of ['/join', '/claim', '/rematch', '/resign']) {
        const res = await page.request.post(`/api/game/${otherGame}/rooms/${code}${verb}`);
        expect(res.status(), `POST ${verb} 应回 404`).toBe(404);
      }
      const snapshot = await page.request.get(`/api/game/${otherGame}/rooms/${code}`);
      expect(snapshot.status()).toBe(404);

      // 直接带这个房号进另一款棋的页面：停在面板上并给出「房间不存在」
      await page.goto(`/game/${otherGame}?mode=online&room=${code}`);
      await expect(page.locator('.board-room-panel__error')).toContainText('房间不存在');
    });

    test('专注模式下联机不可用（服务端 403 + 页面给关闭入口）', async ({ page }) => {
      await loginViaApi(page, SEED_USERS.focus.username);

      const res = await page.request.post(`/api/game/${game}/rooms`);
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toContain('专注模式');

      await page.goto(`/game/${game}?mode=online`);
      await expect(page.locator('.game-card--focus-lock')).toContainText('已开启专注模式');
      await expect(page.locator('a[href="/settings#focus-mode"]')).toBeVisible();
      await expect(page.locator(sel.board)).toHaveCount(0);
    });

    test('非核心用户进不去联机（403）', async ({ page }) => {
      await loginViaApi(page, SEED_USERS.plain.username);

      const res = await page.request.post(`/api/game/${game}/rooms`);
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toContain('核心用户');
    });

    test('单机匿名可玩：不登录也能直达，能走子', async ({ page }) => {
      await page.goto(`/game/${game}`);
      await expect(page.locator(sel.board)).toBeVisible();
      await expect(page.locator('.board-room-panel')).toHaveCount(0); // 单机没有进房面板

      await playMove(page, sel, firstMove.from, ...firstMove.hops);
      await expect(pieceAt(page, sel, ...firstMove.hops[firstMove.hops.length - 1])).toHaveAttribute(
        'data-piece',
        expectAfterFirstMove.to
      );
    });
  });
}
