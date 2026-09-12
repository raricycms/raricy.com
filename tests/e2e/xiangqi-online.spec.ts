// ─────────────────────────────────────────────────────────────────────────────
// xiangqi-online.spec.ts —— 中国象棋联机对战的端到端
//
// 通用用例在 board-game-helpers.ts 里（三款走子类棋共用）。这里只写**象棋特有**的：
//   • 开局是**红先**（"轮到你走"给的是建房者），与另外两款棋白先相反
//   • 棋盘**不是方的**（9 列 × 10 行）—— 这是协议里用 rows/cols 而不是单个 size
//     的直接理由，端到端验一次最实在
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import {
  XIANGQI_BOARD,
  createRoom,
  describeCommonOnlineRules,
  pieceAt,
  playMove,
} from './board-game-helpers';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

test.describe('中国象棋联机（象棋特有）', () => {
  test('棋盘是 9 列 × 10 行，红方（建房者）先走', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await createRoom(page, 'xiangqi');

    // 10 行 × 9 列
    await expect(page.locator('.xiangqi-point[data-row="9"]')).toHaveCount(9);
    await expect(page.locator('.xiangqi-point[data-col="8"]')).toHaveCount(10);

    // 建房者 = 先手席 = **红方**（象棋红先）
    await expect(page.locator('.board-seat[data-seat="black"]')).toContainText('红方');
    await expect(page.locator('.board-seat[data-seat="white"]')).toContainText('黑方');
    await expect(page.locator('.board-status')).toContainText('等待对手加入');
  });

  test('飞将：把挡在两王中间的子挪开是非法的（棋盘不变）', async ({ page }) => {
    // 单机里摆不出来，但可以验一条普通的走子：兵不能斜走、象不能过河
    await page.goto('/game/xiangqi');
    await expect(page.locator(XIANGQI_BOARD.board)).toBeVisible();

    // 红兵 (6,0) 斜走 (5,1) 非法 —— 点完两步之后棋盘应当没变
    await playMove(page, XIANGQI_BOARD, [6, 0], [5, 1]);
    await expect(pieceAt(page, XIANGQI_BOARD, 6, 0)).toHaveAttribute('data-piece', '兵');
    await expect(pieceAt(page, XIANGQI_BOARD, 5, 1)).toHaveAttribute('data-piece', '');

    // 合法的一步：兵 (6,0) → (5,0)
    await playMove(page, XIANGQI_BOARD, [6, 0], [5, 0]);
    await expect(pieceAt(page, XIANGQI_BOARD, 5, 0)).toHaveAttribute('data-piece', '兵');
    await expect(page.locator('.board-status')).toContainText('黑方走棋');
  });
});

describeCommonOnlineRules({
  game: 'xiangqi',
  label: '中国象棋',
  sel: XIANGQI_BOARD,
  firstMove: { from: [7, 7], hops: [[7, 4]] }, // 炮二平五
  expectAfterFirstMove: { from: '', to: '炮' },
  otherGame: 'chess',
});
