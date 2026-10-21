// 双影（/game/twinshade）的端到端用例。
//
// 单测已经把规则内核与存档逻辑钉死了，这里只验「真浏览器里用户能不能用」：
// 引导层 → 键盘通关 → 三星结算 → 撤销 / 重来 / 提示 / 音效 → 关卡选择 → 刷新后进度还在。
// 选择器一律取自 src/games/twinshade/ui-types.ts 的 class / data-* 契约，
// **不在用例里发明选择器** —— 那是给渲染层留的第二份真相。
//
// 这个文件登记在 playwright.config.ts 的 RESPONSIVE_SPECS 里：移动端要验方向键与
// 横向溢出。代价是整个文件 desktop + mobile 各跑一遍（testMatch 只能到文件粒度）。

import { test, expect, type Page } from '@playwright/test';

/** 步数读数。棋盘自身只暴露 data-level-id / data-solved，步数走 HUD 的契约节点。 */
const movesValue = (page: Page) => page.locator('.tw-stat--moves .tw-stat__value');

/** 每次操作后要等的那个「已经提交」的信号：引导层关掉 + 棋盘可见。 */
async function dismissOnboard(page: Page): Promise<void> {
  const onboard = page.locator('.tw-onboard');
  await expect(onboard).toBeVisible();
  await onboard.getByRole('button', { name: '开始', exact: true }).click();
  await expect(onboard).toHaveCount(0);
}

/** 进游戏 → 跳过引导 → 等棋盘可操作。 */
async function openGame(page: Page): Promise<void> {
  await page.goto('/game/twinshade');
  await dismissOnboard(page);
  await expect(page.locator('.tw-board')).toBeVisible();
}

/** 把 pageerror 收集起来，用例末尾统一断言为空（控制台报错不能带噪声进 e2e）。 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('双影：首次进入有玩法引导，点「开始」后棋盘可见', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/game/twinshade');

  const onboard = page.locator('.tw-onboard');
  await expect(onboard).toBeVisible();
  // 三条规则的示意图必须都在：少一条说明渲染层把 .tw-rule 列表写残了。
  await expect(onboard.locator('.tw-rule')).toHaveCount(3);

  await onboard.getByRole('button', { name: '开始', exact: true }).click();
  await expect(onboard).toHaveCount(0);
  await expect(page.locator('.tw-board')).toBeVisible();
  expect(errors).toEqual([]);
});

test('双影：第一关一步通关（键盘），棋盘标记 solved，结算面板三星且全程无 pageerror', async ({ page }) => {
  const errors = watchErrors(page);
  await openGame(page);

  const board = page.locator('.tw-board');
  // 首次进入从第一关开始（没有存档）。
  await expect(board).toHaveAttribute('data-level-id', 'a1');
  await expect(board).toHaveAttribute('data-solved', 'false');
  await expect(movesValue(page)).toHaveText('0');

  // a1 的解法就是往上一步。按键盘（window 上的 keydown 监听）而不是点方向键：
  // 这条同时验了「点过页面任意位置就能用键盘玩」这条体验承诺。
  await page.keyboard.press('ArrowUp');

  await expect(board).toHaveAttribute('data-solved', 'true');
  await expect(movesValue(page)).toHaveText('1');

  // 结算面板：par = 1、实际 1 步 ⇒ 三星。
  const result = page.locator('.tw-result');
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute('data-stars', '3');
  expect(errors).toEqual([]);
});

test('双影：撤销 / 重来 / 提示 / 音效按钮都可用，提示后棋盘出现方向箭头', async ({ page }) => {
  const errors = watchErrors(page);
  await openGame(page);

  const undo = page.getByRole('button', { name: /撤销/ });
  // 一步都没走时撤销必须是禁用的：否则玩家会以为「撤销坏了」。
  await expect(undo).toBeDisabled();

  // 先往右走一步（a1 的这一侧是通的，且不会通关），给撤销栈造一条历史。
  await page.keyboard.press('ArrowRight');
  await expect(movesValue(page)).toHaveText('1');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(movesValue(page)).toHaveText('0');
  await expect(undo).toBeDisabled();

  // 重来：无论走了几步都回到起点。
  await page.keyboard.press('ArrowRight');
  await expect(movesValue(page)).toHaveText('1');
  await page.getByRole('button', { name: /重来|重新挑战/ }).click();
  await expect(movesValue(page)).toHaveText('0');

  // 提示：状态行给出作者写的那句话（这里只验非空与收起行为，不绑死具体文案），
  // 棋盘上两个身体各挂一个方向箭头，1.8 秒后自动收回。
  await page.getByRole('button', { name: '显示提示' }).click();
  await expect(page.locator('.tw-status')).not.toHaveText('');
  await expect(page.locator('.tw-aim')).toHaveCount(2);
  await expect(page.locator('.tw-aim')).toHaveCount(0);

  // 音效按钮：静音 / 恢复各点一次。WebAudio 在部分环境里会抛，音效是「锦上添花」，
  // 任何异常都不该冒成 pageerror（这里就是那条纪律的回归测试）。
  const sound = page.getByRole('button', { name: /音效/ });
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await sound.click();
  await expect(page.getByRole('button', { name: '开启音效' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '开启音效' }).click();
  await expect(page.getByRole('button', { name: '关闭音效' })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('双影：关卡选择能打开、换关后棋盘的 data-level-id 跟着变', async ({ page }) => {
  const errors = watchErrors(page);
  await openGame(page);

  const board = page.locator('.tw-board');
  await expect(board).toHaveAttribute('data-level-id', 'a1');

  await page.getByRole('button', { name: '选择关卡' }).click();
  const levels = page.locator('.tw-levels');
  await expect(levels).toBeVisible();
  const items = levels.locator('[data-level-id]');
  // 章节分组后条目一定不止一个；具体关数由关卡表决定，这里不写死。
  expect(await items.count()).toBeGreaterThanOrEqual(4);
  // 当前关要带 current 标记（读屏与视觉都靠它）。
  await expect(levels.locator('[data-level-id="a1"]')).toHaveClass(/tw-level-item--current/);

  await levels.locator('[data-level-id="a2"]').click();
  await expect(levels).toHaveCount(0);
  await expect(board).toHaveAttribute('data-level-id', 'a2');
  expect(errors).toEqual([]);
});

test('双影：刷新后进度还在（localStorage），并且续上次关卡', async ({ page }) => {
  const errors = watchErrors(page);
  await openGame(page);

  const board = page.locator('.tw-board');

  // 通关第一关（1 步），等结算面板出来再走「关卡选择 → 第二关」——
  // 这条路径会写 recordClear（best.a1 = 1）与 rememberLevel（lastLevelId = a2）。
  await page.keyboard.press('ArrowUp');
  const result = page.locator('.tw-result');
  await expect(result).toHaveAttribute('data-stars', '3');
  await result.getByRole('button', { name: '关卡选择' }).click();
  await expect(page.locator('.tw-levels')).toBeVisible();
  await page.locator('.tw-levels [data-level-id="a2"]').click();
  await expect(board).toHaveAttribute('data-level-id', 'a2');

  // 存档形状：只存步数（星数是规则算出来的，不落盘）。
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('twinshade_progress_v1') ?? 'null')?.best?.a1))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('twinshade_progress_v1') ?? 'null')?.lastLevelId))
    .toBe('a2');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('twinshade_progress_v1') ?? 'null'));
  expect(saved).toMatchObject({ version: 1, seenIntro: true });

  // 刷新：引导层不再出现（seenIntro 已落盘），并续上次玩的 a2（不是「第一个没通关的关」）。
  await page.reload();
  await expect(page.locator('.tw-onboard')).toHaveCount(0);
  const reloaded = page.locator('.tw-board');
  await expect(reloaded).toHaveAttribute('data-level-id', 'a2');

  // 关卡选择里：a1 显示已通关（tw-level-item--done），a2 是当前关。
  await page.getByRole('button', { name: '选择关卡' }).click();
  await expect(page.locator('.tw-levels [data-level-id="a1"]')).toHaveClass(/tw-level-item--done/);
  await expect(page.locator('.tw-levels [data-level-id="a2"]')).toHaveClass(/tw-level-item--current/);
  expect(errors).toEqual([]);
});

// 只有移动端才说得清的两件事：方向键可点、页面没有横向溢出。
// test.skip 放在用例里（而不是 RESPONSIVE_SPECS 里排除）是因为本文件另外四条
// 在两种布局下都该跑 —— testMatch 只能到文件粒度，见 playwright.config.ts 的注释。
test('双影（移动端）：方向键可见可点、无横向溢出，棋盘不塌', async ({ page, isMobile }) => {
  test.skip(!isMobile, '只在 mobile project 跑：方向键与横向溢出是真视口才说得清的事实');
  const errors = watchErrors(page);
  await openGame(page);

  const board = page.locator('.tw-board');
  await expect(board).toBeVisible();

  const dpad = page.locator('.tw-dpad');
  await expect(dpad).toBeVisible();
  await expect(movesValue(page)).toHaveText('0');

  // 点「右」：a1 的右侧是通的，步数读数从 0 变 1 是「方向键真的接到了引擎」的证据。
  // 只断言按钮可见不够 —— disabled 或事件没绑上时按钮照样可见。
  await dpad.getByRole('button', { name: '向右' }).click();
  await expect(movesValue(page)).toHaveText('1');

  // 无横向溢出：棋盘是 SVG，按 viewBox 缩放；下面那些绝对定位的浮层 / 方向键都不该撑宽文档。
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors).toEqual([]);
});
