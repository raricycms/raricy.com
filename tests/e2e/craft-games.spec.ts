import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// 手工间三款游戏都是纯客户端状态机。减少动态效果让折叠 / 展开 / 翻纸直接到终态，
// 用例断的是「操作有没有落到草稿上」，不依赖动画时序。
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function expectPngDownload(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = readFileSync(path!);
  expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
  expect(bytes.length).toBeGreaterThan(1_000);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
}

/** 把 SVG viewBox 坐标换算成页面坐标（保持 meet 的留白与缩放）。 */
async function viewBoxPoint(page: Page, selector: string, width: number, height: number, x: number, y: number) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const scale = Math.min(box.width / width, box.height / height);
  return {
    x: box.x + (box.width - width * scale) / 2 + x * scale,
    y: box.y + (box.height - height * scale) / 2 + y * scale,
  };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('手工间合集：三件手工都能从卡片进入', async ({ page }) => {
  await page.goto('/game');
  await expect(page.locator('.game-collection[href="/game/collections/craft"]')).toHaveCount(1);
  await page.locator('.game-collection[href="/game/collections/craft"]').click();
  await expect(page).toHaveURL('/game/collections/craft');
  await expect(page.locator('.game-card')).toHaveCount(3);
  const hrefs = await page.locator('.game-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')));
  expect(hrefs).toEqual(['/game/loom', '/game/papercut', '/game/marbling']);
  await expect(page.locator('.game-card[href="/game/loom"]')).toContainText('小小织布机');
  await expect(page.locator('.game-card[href="/game/papercut"]')).toContainText('剪纸窗花');
  await expect(page.locator('.game-card[href="/game/marbling"]')).toContainText('水面印花');
});

test('小小织布机：选经线、穿梭、压紧、撤销、刷新续织与导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/loom');
  const game = page.locator('.loom-game');
  await expect(game).toHaveAttribute('data-ready', 'true');

  await page.getByRole('button', { name: '靛青' }).click();
  await page.getByRole('button', { name: '开始织布' }).click();
  await expect(game).toHaveAttribute('data-started', 'true');
  await expect(game).toHaveAttribute('data-rows', '0');

  await page.getByRole('button', { name: '穿完这一行' }).click();
  await expect(page.getByRole('button', { name: '压紧这一行' })).toBeEnabled();
  await page.getByRole('button', { name: '压紧这一行' }).click();
  await expect(game).toHaveAttribute('data-rows', '1');

  await page.getByRole('button', { name: '靛蓝', exact: true }).click();
  await page.getByRole('button', { name: '穿完这一行' }).click();
  await page.getByRole('button', { name: '压紧这一行' }).click();
  await expect(game).toHaveAttribute('data-rows', '2');

  await page.getByRole('button', { name: '撤销' }).click();
  await expect(game).toHaveAttribute('data-rows', '1');
  // 草稿写入有 220ms 防抖；刷新前等到盘上确实是这一行。
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-loom-v1') ?? '{}');
    return Array.isArray(draft.rows) ? draft.rows.length : -1;
  })).toBe(1);

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-rows', '1');
  await expect(game).toHaveAttribute('data-started', 'true');

  await page.getByRole('button', { name: '收边完成' }).click();
  await expect(game).toHaveAttribute('data-finished', 'true');
  await expect(page.locator('.loom-artifact')).toBeVisible();
  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('成品已导出。')).toBeVisible();
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test('剪纸窗花：剪一刀、撤销、补一刀、展开与透明底导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/papercut');
  const game = page.locator('.paper-game');
  await expect(game).toHaveAttribute('data-ready', 'true');

  await page.getByRole('button', { name: '姜黄' }).click();
  await page.getByRole('button', { name: '开始剪' }).click();
  await expect(game).toHaveAttribute('data-started', 'true');
  await expect(game).toHaveAttribute('data-cuts', '0');

  const cutStart = await viewBoxPoint(page, '.paper-stage', 720, 640, 360, 466 - 160 * 0.78);
  const cutEnd = await viewBoxPoint(page, '.paper-stage', 720, 640, 360, 466 - 320 * 0.78);
  await drag(page, cutStart, cutEnd);
  await expect(game).toHaveAttribute('data-cuts', '1');

  await page.getByRole('button', { name: '撤销这一刀' }).click();
  await expect(game).toHaveAttribute('data-cuts', '0');

  const hole = [
    { x: 360, y: 466 - 200 * 0.78 },
    { x: 360 + 50 * 0.78, y: 466 - 200 * 0.78 },
    { x: 360 + 50 * 0.78, y: 466 - 250 * 0.78 },
    { x: 360, y: 466 - 250 * 0.78 },
    { x: 360, y: 466 - 200 * 0.78 },
  ];
  const starts = await Promise.all(hole.map((point) => viewBoxPoint(page, '.paper-stage', 720, 640, point.x, point.y)));
  await page.mouse.move(starts[0].x, starts[0].y);
  await page.mouse.down();
  for (const point of starts.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
  await expect(game).toHaveAttribute('data-cuts', '1');

  await page.getByRole('button', { name: '展开看看' }).click();
  await expect(game).toHaveAttribute('data-view', 'unfolded');
  await expect(page.locator('.paper-stage--result')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-papercut-v1') ?? '{}');
    return draft.view === 'unfolded' && Array.isArray(draft.cuts) ? draft.cuts.length : -1;
  })).toBe(1);

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-view', 'unfolded');
  await expect(game).toHaveAttribute('data-cuts', '1');

  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('透明背景的窗花已导出。')).toBeVisible();
  await page.getByRole('button', { name: '返回修剪' }).click();
  await expect(game).toHaveAttribute('data-view', 'trim');
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test('水面印花：滴颜料、拖针、撤销、铺纸、揭起、刷新与导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/marbling');
  const game = page.locator('.marbling-game');
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-stage', 'water');
  await expect(game).toHaveAttribute('data-painted', 'false');

  const canvas = page.locator('.marbling-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.46, y: box.height * 0.5 } });
  await expect(game).toHaveAttribute('data-painted', 'true');

  await page.getByRole('button', { name: '针', exact: true }).click();
  await expect(game).toHaveAttribute('data-tool', 'needle');
  await canvas.scrollIntoViewIfNeeded();
  const dragBox = (await canvas.boundingBox())!;
  const before = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  await drag(page,
    { x: dragBox.x + dragBox.width * 0.3, y: dragBox.y + dragBox.height * 0.45 },
    { x: dragBox.x + dragBox.width * 0.7, y: dragBox.y + dragBox.height * 0.55 });
  const after = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  expect(after).not.toBe(before);

  await page.getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('button', { name: '撤销' })).toBeEnabled();
  await page.getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('button', { name: '撤销' })).toBeDisabled();

  await page.getByRole('button', { name: '滴管', exact: true }).click();
  await canvas.click({ position: { x: box.width * 0.54, y: box.height * 0.42 } });
  await expect(game).toHaveAttribute('data-painted', 'true');
  await page.getByRole('button', { name: '铺纸' }).click();
  await expect(game).toHaveAttribute('data-stage', 'paper');
  await page.getByRole('button', { name: '揭起纸' }).click();
  await expect(game).toHaveAttribute('data-stage', 'print');
  await expect(page.locator('.marbling-print__canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-marbling-v1') ?? '{}');
    return draft.stage === 'print' && draft.print ? 'print' : draft.stage;
  })).toBe('print');

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-stage', 'print');
  await expect(page.locator('.marbling-print__canvas')).toBeVisible();

  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('印张已导出。')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.marbling-result').getByRole('button', { name: '再印一张' }).click();
  await expect(game).toHaveAttribute('data-stage', 'water');
  await expect(game).toHaveAttribute('data-painted', 'false');
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});
