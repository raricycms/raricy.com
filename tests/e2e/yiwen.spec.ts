import { test, expect, type Page } from '@playwright/test';

async function add(page: Page, name: string) {
  await page.getByRole('button', { name: `加入${name}`, exact: true }).click();
}
async function frame(page: Page, value: boolean) {
  const button = page.getByRole('button', { name: '加框', exact: true });
  if ((await button.getAttribute('aria-pressed') === 'true') !== value) await button.click();
}

test('七张实验卡可自由切换、逐步检查、改写及续玩', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/collections/test');
  await page.getByRole('link', { name: /异文 Demo/ }).click();
  await expect(page.locator('.yw-game')).toHaveAttribute('data-ready', 'true');
  const programs = [['甲'], ['乙'], ['乙', '甲'], ['甲', '甲', '甲', '乙', '甲'], ['带框的甲'], ['带框的乙'], ['带框的乙', '甲', '带框的甲', '带框的甲', '带框的甲']];
  // 先跳到后面的卡，不需要先完成教学或获得工具。
  await page.getByRole('button', { name: /^实验 07/ }).click();
  await expect(page.locator('.yw-workbench')).toHaveAttribute('data-experiment', '07');
  for (const [index, program] of programs.entries()) {
    await page.getByRole('button', { name: new RegExp(`^实验 0${index + 1}`) }).click();
    for (const name of program) {
      await frame(page, name.startsWith('带框'));
      await add(page, name);
    }
    await page.getByRole('button', { name: '运行句子' }).click();
    await expect(page.locator('.yw-workbench')).toHaveAttribute('data-matched', 'true');
  }
  await expect(page.getByRole('heading', { name: '七张实验卡已完成' })).toBeVisible();
  await page.getByRole('button', { name: '查看第 1 步', exact: true }).click();
  await expect(page.getByRole('img', { name: /^当前输出/ })).toHaveAccessibleName(/1 行 4 列：上箭头、上箭头、圆点、圆点/);
  await page.getByRole('button', { name: '退一枚', exact: true }).click();
  await expect(page.getByRole('heading', { name: '上次拓印' })).toBeVisible();
  await expect(page.locator('.yw-workbench')).toHaveAttribute('data-matched', 'false');
  await page.reload();
  await expect(page.locator('.yw-workbench')).toHaveAttribute('data-experiment', '07');
  await expect(page.getByLabel('当前句子').getByRole('button')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '七张实验卡已完成' })).toBeVisible();
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(page.getByRole('button', { name: '运行句子' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('铭牌在新存档就能打开，且错误拓印不会通过', async ({ page }) => {
  await page.goto('/game/yiwen');
  await page.getByRole('button', { name: '取下底稿' }).click();
  await add(page, '甲');
  await page.getByRole('button', { name: '运行句子' }).click();
  await page.getByRole('button', { name: '放入当前拓印' }).click();
  await expect(page.locator('.yw-plate')).toHaveAttribute('data-opened', 'false');
  await expect(page.locator('.yw-feedback')).toContainText('没有让铭牌产生变化');
  await frame(page, true);
  await add(page, '带框的乙');
  await frame(page, false);
  await add(page, '甲');
  await page.getByRole('button', { name: '运行句子' }).click();
  await page.getByRole('button', { name: '放入当前拓印' }).click();
  await expect(page.getByRole('heading', { name: '你读懂了这句话。' })).toBeVisible();
  await expect(page.locator('.yw-progress')).toContainText('0 / 7');
  await page.reload();
  await expect(page.locator('.yw-plate')).toHaveAttribute('data-opened', 'true');
});

test('窄屏与主题可读、拒绝存储仍可操作、键盘运行及容量反馈', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await page.goto('/game/yiwen');
  await expect(page.locator('.yw-save-note')).toBeVisible();
  for (let i = 0; i < 4; i++) await add(page, '乙');
  await page.getByRole('button', { name: '运行句子' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.yw-feedback')).toContainText('超出了 8 × 8');
  await page.getByRole('button', { name: /^实验 05/ }).click();
  await page.getByRole('button', { name: '一点提示' }).click();
  await expect(page.locator('.yw-hint')).toContainText('圆点和空白的位置');
  await frame(page, true);
  await add(page, '带框的甲');
  await page.getByRole('button', { name: '运行句子' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await expect(page.locator('.yw-workbench')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(24, 26, 29)' : 'rgb(255, 255, 255)');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`yiwen-desktop-${theme}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`yiwen-mobile-${theme}.png`), fullPage: true });
  }
});
