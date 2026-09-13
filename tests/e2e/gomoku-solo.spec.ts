// ─────────────────────────────────────────────────────────────────────────────
// gomoku-solo.spec.ts —— 五子棋单机「人机对战」端到端
//
// 【为什么必须 E2E】AI 跑在 Web Worker 里，这条链路有三处单测碰不到、坏了也不
// 报错的地方：
//   · **打包**：`new Worker(new URL('./gomoku-ai.worker.ts', import.meta.url))`
//     解析不出来时，构造函数照样成功，脚本却是 404 —— onmessage 永远不触发，
//     表现为「AI 永远在思考」。单测（node 环境）里根本没有 Worker 这个全局量。
//   · **消息协议**：主线程发着法历史、worker 重放成棋盘，字段名对不上就是
//     静默地走出一手错棋。
//   · **像素 → 棋盘格**的点击换算（canvas 上的东西，单测碰不到）。
//
// 判据用状态行：玩家落子后轮到白方，只有 AI 真的回了手才会变回「黑方落子」。
// 所以「等到黑方落子」这一条断言同时覆盖了模式切换、worker 往返与落子生效。
//
// 【为什么不用登录】单机是匿名可玩的（联机才要求 core+），这条用例必须守住
// 这个前提 —— 顺带也是「别给单机分支加 requireCoreUser」的回归网。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';

/** 落子：(row, col) 是棋盘交叉点。换算依据见 GomokuCanvas 文件头。 */
async function clickCell(page: Page, row: number, col: number) {
  const canvas = page.locator('.gomoku-canvas');
  const { cell, margin } = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return { cell: Number(c.dataset.cellSize), margin: Number(c.dataset.margin) };
  });
  await canvas.click({ position: { x: margin + col * cell, y: margin + row * cell } });
}

test.describe('五子棋单机', () => {
  test('匿名可玩，且人机对战里 AI 会通过 worker 回手', async ({ page }) => {
    await page.goto('/game/gomoku');
    await expect(page.locator('.gomoku-canvas')).toBeVisible();

    // 切到人机对战（单机默认是对战模式）
    await page.locator('input[name="gomoku-mode"][value="ai"]').check();

    const status = page.locator('.board-status');
    await expect(status).toHaveText('黑方落子');

    await clickCell(page, 7, 7);

    // 玩家落子后轮到白方（AI）。AI 没回手的话状态会停在「AI 思考中…」，
    // 永远等不到「黑方落子」—— 这就是 worker 链路的判据。
    await expect(status).toHaveText('黑方落子', { timeout: 20_000 });

    // 再走一手，确认不是一次性的巧合
    await clickCell(page, 7, 8);
    await expect(status).toHaveText('黑方落子', { timeout: 20_000 });
  });
});
