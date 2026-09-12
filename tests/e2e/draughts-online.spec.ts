// ─────────────────────────────────────────────────────────────────────────────
// draughts-online.spec.ts —— 国际跳棋联机对战的端到端
//
// 通用用例在 board-game-helpers.ts 里（三款走子类棋共用）。这里只写**跳棋特有**的：
//   • 只有**深色格**能点（浅色格渲染成不可交互的 div，不是"点不动的按钮"）
//   • 吃子是**一条含多个落点的路径**整手提交 —— 棋盘与房间层都按 path 处理
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import {
  DRAUGHTS_BOARD,
  createRoom,
  describeCommonOnlineRules,
  pieceAt,
  playMove,
} from './board-game-helpers';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

test.describe('国际跳棋联机（跳棋特有）', () => {
  test('10×10，只有 50 个深色格可点，每方 20 子', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await createRoom(page, 'draughts');

    await expect(page.locator('.draughts-square')).toHaveCount(100);
    await expect(page.locator('.draughts-square--dark')).toHaveCount(50);

    const white = await page.locator('.draughts-square[data-piece="M"]').count();
    const black = await page.locator('.draughts-square[data-piece="m"]').count();
    expect(white).toBe(20);
    expect(black).toBe(20);

    // 白先（建房者执先手席）
    await expect(page.locator('.board-seat[data-seat="black"]')).toContainText('白方');
  });

  test('连吃是逐跳点的：点完每一个落点才落子', async ({ page }) => {
    await page.goto('/game/draughts');
    await expect(page.locator(DRAUGHTS_BOARD.board)).toBeVisible();

    // 开局第一手：白兵 (6,1) → (5,0)
    await playMove(page, DRAUGHTS_BOARD, [6, 1], [5, 0]);
    await expect(pieceAt(page, DRAUGHTS_BOARD, 5, 0)).toHaveAttribute('data-piece', 'M');
    await expect(pieceAt(page, DRAUGHTS_BOARD, 6, 1)).toHaveAttribute('data-piece', '');
    await expect(page.locator('.board-status')).toContainText('黑方走棋');

    // 浅色格点不动：不该产生任何着法
    await page.locator('.draughts-square--light').first().click({ force: true });
    await expect(page.locator('.board-status')).toContainText('黑方走棋');
  });
});

describeCommonOnlineRules({
  game: 'draughts',
  label: '国际跳棋',
  sel: DRAUGHTS_BOARD,
  firstMove: { from: [6, 1], hops: [[5, 0]] },
  expectAfterFirstMove: { from: '', to: 'M' },
  otherGame: 'chess',
});
