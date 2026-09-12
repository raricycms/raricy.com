// ─────────────────────────────────────────────────────────────────────────────
// chess-online.spec.ts —— 国际象棋联机对战的端到端
//
// 通用用例（no-transform 响应头 / SSE 实时 / 观战 / 刷新回原座 / 认输 / 跨游戏
// 404 / 专注模式 / 非 core+ / 单机匿名可玩）在 board-game-helpers.ts 里，
// 三款走子类棋共用同一份。这里只写**国际象棋特有**的那条：真的把一盘将死下出来。
//
// 【为什么值得单独写】"将死算谁赢"是走子类棋接进房间层时最容易接反的一环
// （Outcome.winner 并不总是"刚走完的那一方"），而它只有把棋真下到将死才验得到。
// 傻瓜杀（f3 e5 g4 Qh4#）只要 4 手，是能在 e2e 里跑完的最短将死。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import {
  CHESS_BOARD,
  asUser,
  createRoom,
  describeCommonOnlineRules,
  pieceAt,
  playMove,
} from './board-game-helpers';
import { SEED_USERS } from './seed';

test.describe('国际象棋联机（将死）', () => {
  test('傻瓜杀：两端都看到结果，胜方与负方文案不同，被将死的王被标出', async ({ browser }) => {
    const a = await asUser(browser, SEED_USERS.core.username);
    const b = await asUser(browser, SEED_USERS.admin.username);
    try {
      const room = await createRoom(a.page, 'chess');
      await b.page.goto(`/game/chess?mode=online&room=${room}`);
      await expect(b.page.locator(CHESS_BOARD.board)).toBeVisible();

      // 1. f3 e5 2. g4 Qh4#
      await playMove(a.page, CHESS_BOARD, [6, 5], [5, 5]); // f2-f3
      await playMove(b.page, CHESS_BOARD, [1, 4], [3, 4]); // e7-e5
      await playMove(a.page, CHESS_BOARD, [6, 6], [4, 6]); // g2-g4
      await playMove(b.page, CHESS_BOARD, [0, 3], [4, 7]); // Qd8-h4#

      // 黑方（B）赢 —— 先手席是白方（A）
      await expect(b.page.locator('.board-status')).toHaveText('你赢了！');
      await expect(a.page.locator('.board-status')).toHaveText('你输了');

      // 被将死的白王 e1 被标出（服务端下发的 highlight）
      await expect(
        a.page.locator('.chess-square[data-row="7"][data-col="4"]')
      ).toHaveClass(/chess-square--win/);

      // 终局后点不动，且出现「再来一局」
      await expect(a.page.locator('.board-controls')).toContainText('再来一局');
      await expect(pieceAt(a.page, CHESS_BOARD, 4, 7)).toHaveAttribute('data-piece', 'q');
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  });

  test('格色符合国际象棋惯例：a1 深、h1 浅（右下角是浅色格）', async ({ page }) => {
    // 这条不是洁癖：整个棋盘就是黑白相间的，"哪种格子在左下"看错一眼就会发现，
    // 但写反了页面照样能走子、e2e 照样全绿 —— 只有肉眼或这条断言看得见。
    await page.goto('/game/chess');
    await expect(page.locator(CHESS_BOARD.board)).toBeVisible();

    const lum = (r: number, c: number) =>
      page
        .locator(`.chess-square[data-row="${r}"][data-col="${c}"]`)
        .evaluate((el) => {
          const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(getComputedStyle(el).backgroundColor);
          return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : -1;
        });

    const a1 = await lum(7, 0);
    const h1 = await lum(7, 7);
    const a8 = await lum(0, 0);
    const h8 = await lum(0, 7);
    expect(a1, 'a1 应当是深色格').toBeLessThan(h1);
    expect(a8, 'a8 应当是浅色格').toBeGreaterThan(h8);
    // 同色的两个角：a8 与 h1 都浅、a1 与 h8 都深
    // （a1 与 a8 同列相隔 7 格，颜色**相反** —— 拿它们比会得出反的结论）
    expect(Math.abs(a8 - h1)).toBeLessThan(50);
    expect(Math.abs(a1 - h8)).toBeLessThan(50);
  });

  test('易位：王横走两格，车跟着挪过来', async ({ page }) => {
    // 单机里走一遍即可 —— 联机那条链路已经由通用用例覆盖
    await page.goto('/game/chess');
    await expect(page.locator(CHESS_BOARD.board)).toBeVisible();

    // 先把 f1 的象与 g1 的马挪开，才能短易位
    await playMove(page, CHESS_BOARD, [6, 4], [4, 4]); // e2-e4
    await playMove(page, CHESS_BOARD, [1, 4], [3, 4]); // e7-e5
    await playMove(page, CHESS_BOARD, [7, 6], [5, 5]); // Ng1-f3
    await playMove(page, CHESS_BOARD, [0, 1], [2, 2]); // Nb8-c6
    await playMove(page, CHESS_BOARD, [7, 5], [4, 2]); // Bf1-c4
    await playMove(page, CHESS_BOARD, [0, 6], [2, 5]); // Ng8-f6
    await playMove(page, CHESS_BOARD, [7, 4], [7, 6]); // O-O

    await expect(pieceAt(page, CHESS_BOARD, 7, 6)).toHaveAttribute('data-piece', 'K');
    await expect(pieceAt(page, CHESS_BOARD, 7, 5)).toHaveAttribute('data-piece', 'R');
    await expect(pieceAt(page, CHESS_BOARD, 7, 7)).toHaveAttribute('data-piece', '');
  });
});

// 三款走子类棋共用的那一套（响应头 / SSE / 观战 / 刷新 / 认输 / 隔离 / 闸门 / 单机）
describeCommonOnlineRules({
  game: 'chess',
  label: '国际象棋',
  sel: CHESS_BOARD,
  firstMove: { from: [6, 4], hops: [[4, 4]] }, // e2-e4
  expectAfterFirstMove: { from: '', to: 'P' },
  otherGame: 'xiangqi',
});
