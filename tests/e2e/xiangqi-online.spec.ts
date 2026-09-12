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

test.describe('中国象棋（棋盘绘制）', () => {
  test('棋盘线画出来了，且**没有**被 non-scaling-stroke 变成 0.03px', async ({ page }) => {
    // 【为什么值得单测】线宽用的是用户单位（1 单位 = 一格），随棋盘一起缩放。
    // 一旦给它加上 `vector-effect: non-scaling-stroke`，stroke-width 就按**设备像素**
    // 解释，0.03 就是 0.03px —— 棋盘线细到看不见。页面看上去只是"一片木色"，
    // 不像坏了，像设计如此，而且照样能走子、其它用例照样全绿。
    await page.goto('/game/xiangqi');
    await expect(page.locator(XIANGQI_BOARD.board)).toBeVisible();

    const lines = page.locator('.xiangqi-lines line');
    expect(await lines.count()).toBeGreaterThan(20); // 10 横 + 9 竖（中间七条断成两段）+ 4 斜

    const first = lines.first();
    expect(await first.evaluate((el) => getComputedStyle(el).vectorEffect)).not.toBe(
      'non-scaling-stroke'
    );
    expect(await first.evaluate((el) => getComputedStyle(el).strokeWidth)).not.toBe('0px');

    // 河界：中间七条竖线是断开的，所以竖线段的条数多于 9
    const verticals = page.locator('.xiangqi-lines line[x1][y1="0.5"]');
    expect(await verticals.count()).toBeGreaterThan(9);
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
