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

test('手工间合集：从测试合集进入，三件手工都能从卡片打开', async ({ page }) => {
  await page.goto('/game');
  // 手工间已挂到「测试」下面：玩具首页只陈列顶层合集，不再直接出现手工间；
  // 旧顶层地址在这里也不该被当成「还挂在顶层」的证据。
  await expect(page.locator('.game-collection[href="/game/collections/craft"]')).toHaveCount(0);
  await expect(page.locator('.game-collection[href="/game/collections/test"]')).toHaveCount(1);
  await page.locator('.game-collection[href="/game/collections/test"]').click();
  await expect(page).toHaveURL('/game/collections/test');
  await expect(page.locator('.game-collection[href="/game/collections/test/craft"]')).toHaveCount(1);
  await page.locator('.game-collection[href="/game/collections/test/craft"]').click();
  await expect(page).toHaveURL('/game/collections/test/craft');
  await expect(page.locator('.game-breadcrumb')).toContainText('测试');
  await expect(page.locator('.game-breadcrumb')).toContainText('手工间');
  await expect(page.locator('.game-card')).toHaveCount(3);
  const hrefs = await page.locator('.game-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')));
  expect(hrefs).toEqual(['/game/loom', '/game/papercut', '/game/marbling']);
  await expect(page.locator('.game-card[href="/game/loom"]')).toContainText('小小织布机');
  await expect(page.locator('.game-card[href="/game/papercut"]')).toContainText('剪纸窗花');
  await expect(page.locator('.game-card[href="/game/marbling"]')).toContainText('水面印花');

  // 旧地址（合集还在顶层时的收藏）永久跳到新路径 —— 别让书签 404。
  await page.goto('/game/collections/craft');
  await expect(page).toHaveURL('/game/collections/test/craft');
});

test('小小织布机：拖一趟就是一行、换色只影响之后的行、撤销、刷新续织与导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/loom');
  const game = page.locator('.loom-game');
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-rows', '0');

  // 布面在 viewBox 里的横向跨度是 168..552（左端到右端）。拖动要比这更宽一点：
  // 进度是按指针的绝对位置算的，没走到对岸就不成行。
  //
  // ⚠️ 每趟都**现算**落点：点侧栏的梭线按钮会触发自动滚动，页面一滚旧坐标就偏了。
  const pass = async (fromX: number, toX: number) => {
    const from = await viewBoxPoint(page, '.loom-stage', 720, 600, fromX, 200);
    const to = await viewBoxPoint(page, '.loom-stage', 720, 600, toX, 200);
    await drag(page, from, to);
  };

  // 一来一回两趟 = 两行，中间不需要点任何按钮 —— 这正是"连贯"的那个要求。
  await pass(120, 630);
  await expect(game).toHaveAttribute('data-rows', '1');
  await pass(630, 120);
  await expect(game).toHaveAttribute('data-rows', '2');

  // 换梭线之后再织两行：前两行的颜色不该被改掉。
  await page.getByRole('button', { name: '茜红' }).click();
  await pass(120, 630);
  await expect(game).toHaveAttribute('data-rows', '3');
  await pass(630, 120);
  await expect(game).toHaveAttribute('data-rows', '4');
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-loom-v2') ?? '{}');
    return Array.isArray(draft.rows) ? draft.rows.map((row: { color: number }) => row.color) : [];
  })).toEqual([0, 0, 2, 2]);

  await page.getByRole('button', { name: '退回一趟' }).click();
  await expect(game).toHaveAttribute('data-rows', '3');
  // 草稿写入有 220ms 防抖；刷新前等到盘上确实是这一行。
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-loom-v2') ?? '{}');
    return Array.isArray(draft.rows) ? draft.rows.length : -1;
  })).toBe(3);

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-rows', '3');

  await page.getByRole('button', { name: '收边完成' }).click();
  await expect(game).toHaveAttribute('data-finished', 'true');
  await expect(page.locator('.loom-artifact')).toBeVisible();
  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('成品已导出。')).toBeVisible();
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test('剪纸窗花：折好的纸上一刀剪穿四层，展开是镜像对称的窗花', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/papercut');
  const game = page.locator('.paper-game');
  await expect(game).toHaveAttribute('data-ready', 'true');
  // 两折 = 四层，这是默认折法。
  await expect(game).toHaveAttribute('data-folds', '2');
  await expect(game).toHaveAttribute('data-cuts', '0');

  /**
   * 剪口的落点要落在**折好的楔形**里。
   *
   * 楔形在展开坐标里跨 `[0, θ]`（θ = 2π/4 = 90°），屏幕上按 `displayRotation`
   * 立成朝上的一片，所以竖直向上（x = CENTER_X，y 比圆心小）一定在楔形内。
   */
  const cut = async (fromY: number, toY: number) => {
    const start = await viewBoxPoint(page, '.paper-stage', 720, 640, 360, fromY);
    const end = await viewBoxPoint(page, '.paper-stage', 720, 640, 360, toY);
    await drag(page, start, end);
  };

  await cut(320 - 120, 320 - 210);
  await expect(game).toHaveAttribute('data-cuts', '1');

  await page.getByRole('button', { name: '撤销一刀' }).click();
  await expect(game).toHaveAttribute('data-cuts', '0');

  // 一个闭合的小方孔：一笔画圈，走完回到起点才算闭合。
  const square = [
    { x: 360, y: 320 - 200 },
    { x: 360 + 34, y: 320 - 200 },
    { x: 360 + 34, y: 320 - 250 },
    { x: 360, y: 320 - 250 },
    { x: 360, y: 320 - 200 },
  ];
  const points = await Promise.all(square.map((point) => viewBoxPoint(page, '.paper-stage', 720, 640, point.x, point.y)));
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
  await expect(game).toHaveAttribute('data-cuts', '1');

  /**
   * 纸默认是**折好**的（`unfold` 从 0 开始）—— 这正是"沉浸"的要求：先在折好的
   * 一叠上剪，剪完再决定摊开多少。所以展开是滑杆，不是"展开看看"按钮。
   */
  await expect(game).toHaveAttribute('data-unfold', '0.000');
  await expect(page.locator('.paper-unfold')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-papercut-v2') ?? '{}');
    return Array.isArray(draft.cuts) ? draft.cuts.length : -1;
  })).toBe(1);

  // 拖滑杆把纸摊平 —— 摊平之后看到的就是镜像对称的整朵窗花。
  await page.locator('.paper-unfold').fill('100');
  await expect(game).toHaveAttribute('data-unfold', '1.000');

  // 折过、剪过了就不能再换折法 —— 会改变已经剪下的层数关系。
  await expect(page.getByRole('button', { name: /三折/ })).toBeDisabled();

  await page.getByRole('button', { name: '放到窗前' }).click();
  await expect(game).toHaveAttribute('data-view', 'window');
  await expect(page.locator('.paper-window')).toBeVisible();

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-view', 'window');
  await expect(game).toHaveAttribute('data-cuts', '1');

  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('透明背景的窗花已导出。')).toBeVisible();
  await page.getByRole('button', { name: '回到案上' }).click();
  await expect(game).toHaveAttribute('data-view', 'trim');
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test('水面印花：滴颜料、梳出纹理、铺纸、揭起、刷新与导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game/marbling');
  const game = page.locator('.marbling-game');
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-stage', 'water');
  await expect(game).toHaveAttribute('data-painted', 'false');

  /**
   * 水面是 SVG（不是 canvas），颜料画在 `<image>` 里。
   * 落点用 viewBox 坐标换算，别用 boundingBox 的百分比 —— 留白会让后者偏。
   */
  const POOL = { x: 88, y: 76, w: 544, h: 380 };
  const poolPoint = (fx: number, fy: number) =>
    viewBoxPoint(page, '.marbling-drag', 720, 560, POOL.x + POOL.w * fx, POOL.y + POOL.h * fy);

  // 同一处连滴，颜色交替 —— 每滴把上一圈往外推，于是长出一圈套一圈的花纹。
  /**
   * ⚠️ 每次都**现算**落点：点侧栏按钮会让 Playwright 自动滚到按钮，页面一滚，
   * 之前算好的屏幕坐标就全偏了（1280×720 下实测滚出 458px，滴不到水面上）。
   */
  const tapPool = async (fx: number, fy: number) => {
    const point = await poolPoint(fx, fy);
    await page.mouse.click(point.x, point.y);
  };
  for (const name of ['深青', '朱砂', '姜黄']) {
    await page.getByRole('button', { name }).click();
    await tapPool(0.5, 0.5);
  }
  await expect(game).toHaveAttribute('data-painted', 'true');

  // 梳子横扫：把同心环搓成波纹。
  await page.getByRole('button', { name: '梳子' }).click();
  await expect(game).toHaveAttribute('data-tool', 'comb');
  await drag(page, await poolPoint(0.1, 0.5), await poolPoint(0.9, 0.5));

  await page.getByRole('button', { name: '撤销一步' }).click();
  await expect(page.getByRole('button', { name: '撤销一步' })).toBeEnabled();

  // 铺纸：抓住纸沿往下拖到底（绝对映射，拖到哪铺到哪）。
  await drag(page, await poolPoint(0.5, 0), await poolPoint(0.5, 1));
  await expect(game).toHaveAttribute('data-lay', '1.000');
  await expect(game).toHaveAttribute('data-stage', 'paper');

  // 揭起来才是成品。
  await drag(page, await poolPoint(0.5, 1), await poolPoint(0.5, 0));
  await expect(game).toHaveAttribute('data-print', 'true');
  await expect(game).toHaveAttribute('data-stage', 'print');
  await expect(page.locator('.marbling-paper')).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem('craft-marbling-v2') ?? '{}');
    return draft.stage === 'print' && draft.print ? 'print' : draft.stage;
  })).toBe('print');

  await page.reload();
  await expect(game).toHaveAttribute('data-ready', 'true');
  await expect(game).toHaveAttribute('data-stage', 'print');
  await expect(game).toHaveAttribute('data-print', 'true');

  await expectPngDownload(page, () => page.getByRole('button', { name: '导出 PNG' }).click());
  await expect(page.getByText('成品已导出。')).toBeVisible();

  // 再印一张：水面留着，纸收起来 —— 没有确认弹窗。
  await page.getByRole('button', { name: '再印一张' }).click();
  await expect(game).toHaveAttribute('data-stage', 'water');
  await expect(game).toHaveAttribute('data-painted', 'true');
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});
