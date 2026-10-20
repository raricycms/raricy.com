import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, publishBlog, registerFreshUser } from './helpers';

// 个人主页「积木墙」的端到端契约。
//
// 【为什么要这一份】主页在 2026-10 从「文章 / 评论标签页」换成了可布置的积木墙，
// 而它有两套**完全不同**的摆放模型：
//   · 桌面：4 列自由网格，位置就是 (x, y)，拖动摆放；
//   · 手机：两列流式，忽略坐标、按保存时的数组顺序（profile_blocks.sort）排。
// 前者只能靠量几何验证（坐标 → CSS grid 落点），后者只能靠真触屏 + 真固定工具条
// 验证（顺序、遮挡、按钮触达）。两者在源码里都「看起来对」，出问题时也不报错，
// 所以两遍都必须跑（本文件登记在 playwright.config.ts 的 RESPONSIVE_SPECS）。
//
// 每个用例都用一次性 core 账号：主页保存有 30/分 的限频桶，种子号被 desktop /
// mobile 两轮共用时会互相消耗（helpers 里那条注释讲了同一件事）。

type BlockPayload = {
  id?: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
};

function textBlock(text: string, x = 0, y = 0, w = 2, h = 1): BlockPayload {
  return { id: '', kind: 'text', x, y, w, h, config: { title: '', text } };
}

async function saveBlocks(page: Page, blocks: BlockPayload[]) {
  const res = await page.request.put('/api/profile/blocks', { data: { blocks } });
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  return { status: res.status(), body };
}

/** 手机上两列流式；顺序就是 `.bento-card--text` 在 DOM 里的顺序。 */
async function textOrder(page: Page): Promise<string[]> {
  return page.locator('.bento-card--text .bento-text__body').allTextContents();
}

test('新用户主页：本人看到布置引导，访客看到的是「还没有布置」', async ({ page }) => {
  const u = await registerFreshUser(page, { core: true });

  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-empty__title')).toHaveText('这里还没有东西');
  await expect(page.getByRole('button', { name: '开始布置' })).toBeVisible();

  // 访客（匿名可达是主页的前提 —— 画报二维码就是这么来的）
  await page.context().clearCookies();
  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-empty__text')).toHaveText('这个人还没有布置主页。');
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('核心用户能布置并保存；?edit=1 在保存后清掉，刷新与访客看到同一份', async ({ page, isMobile }) => {
  const u = await registerFreshUser(page, { core: true });

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento.is-editing')).toHaveCount(1);
  await expect(page.locator('.bento-toolbar')).toBeVisible();

  // 走真 UI 加一块文字（桌面在流内面板，手机在底部固定工具条）
  const palette = isMobile ? page.locator('.bento-dock .bento-palette') : page.locator('.bento-palette');
  await palette.getByRole('button', { name: '文字', exact: true }).click();
  const dialog = page.locator('.bento-modal');
  await expect(dialog).toBeVisible();
  await dialog.locator('textarea').fill('主页上的第一句话');
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.bento-notice')).toHaveText('已保存');
  await expect(page).not.toHaveURL(/edit=1/);

  await page.reload();
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');
  // 有内容之后，身份条上出现「布置主页」入口（默认布局时不重复摆第二颗）
  await expect(page.getByRole('link', { name: '布置主页' })).toHaveCount(1);

  await page.context().clearCookies();
  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
});

test('非核心用户：能看自己的主页，但进不了编辑、接口 403', async ({ page }) => {
  const u = await registerFreshUser(page); // 默认 role=user

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  await expect(page.locator('.profile-tier-note')).toContainText('布置主页目前对核心用户开放');

  const res = await saveBlocks(page, []);
  expect(res.status).toBe(403);
});

test('目标降档后：本人看到「已不可用 + 换一个」，访客看不到这一块，整页仍能保存', async ({ page }) => {
  const u = await registerFreshUser(page, { core: true });
  // internal 档：指针本身合法（是本人的文章），但对外不可读 —— 正是「降档」后的状态
  const hidden = await publishBlog(page, 'internal');

  const saved = await saveBlocks(page, [
    { id: '', kind: 'blog', x: 0, y: 0, w: 2, h: 1, config: { blogId: hidden } },
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-card--blog .bento-card__missing')).toContainText('这块内容已不可用');
  await expect(page.getByRole('button', { name: '换一个' })).toBeVisible();

  // 以前这里会 400（「有一篇文章不可见」），整页都存不进去 —— 连修都修不了。
  // 现在档位只在读路径判，保存只校归属。
  const again = await saveBlocks(page, [
    { id: '', kind: 'blog', x: 0, y: 0, w: 2, h: 1, config: { blogId: hidden } },
    textBlock('另一块能存的', 2, 0),
  ]);
  expect(again.status, JSON.stringify(again.body)).toBe(200);

  // 访客：这块连 DOM 都不出现，但同一页上仍可读的那块照常
  await page.context().clearCookies();
  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-card--blog')).toHaveCount(0);
  await expect(page.locator('.bento-card--text')).toContainText('另一块能存的');
});

test('桌面：4 列网格按坐标落位，吸顶工具条停在顶栏下方', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面网格与吸顶工具条只在宽屏分支存在');

  const u = await registerFreshUser(page, { core: true });
  // 四行满格（16 块 = 上限），把页面撑到可滚动（吸顶才有东西可验）
  const blocks: BlockPayload[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      blocks.push(textBlock(`格 ${x}-${y}`, x, y, 1, 1));
    }
  }
  expect((await saveBlocks(page, blocks)).status).toBe(200);

  // 卡片入场有 0.38s 的动画（且按 --i 错开 45ms）。量几何前先关掉它，
  // 否则量到的是 translateY 中间帧 —— 同一行两块会差几像素，看起来像网格错位。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/u/${u.id}?edit=1`);
  const cards = page.locator('.bento-card--text');
  await expect(cards).toHaveCount(16);

  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  // 同一行的两块：顶边对齐；横向间隔就是网格 gap（16px）
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(Math.round(second.x - (first.x + first.width))).toBe(16);
  // 行高 132
  expect(Math.round(first.height)).toBe(132);
  // 第 5 块（第二行第一个）与第一块同一列
  const fifth = (await cards.nth(4).boundingBox())!;
  expect(Math.abs(fifth.x - first.x)).toBeLessThan(2);
  expect(Math.round(fifth.y - (first.y + first.height))).toBe(16);

  // 吸顶：toolbar 的 top 是 74px（与博客筛选条同一档），滚动后必须落在那里、
  // 且不能压住顶栏
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect
    .poll(async () => Math.round((await page.locator('.bento-toolbar').boundingBox())!.y))
    .toBe(74);
  const navbar = (await page.locator('.site-navbar').boundingBox())!;
  expect(navbar.y + navbar.height).toBeLessThanOrEqual(74);

  // 加块面板在桌面是流内吸底（不是固定层）
  await expect(page.locator('.bento-palette')).toHaveCount(1);
  await expect(page.locator('.bento-dock')).toHaveCount(0);
});

test('手机：底部工具条随选中切换，上移 / 下移改顺序并持久化', async ({ page, isMobile }) => {
  test.skip(!isMobile, '顺序即数组顺序，是手机流式布局独有的操作');

  const u = await registerFreshUser(page, { core: true });
  const saved = await saveBlocks(page, [
    textBlock('第一块', 0, 0, 1, 1),
    textBlock('第二块', 1, 0, 1, 1),
    textBlock('第三块', 0, 1, 1, 1),
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toBeVisible();
  // 手机不画背景格（坐标与流式格位对不上，画出来是误导）
  await expect(page.locator('.bento-guides')).toHaveCount(0);
  // 没选中时工具条是「加一块」
  await expect(page.locator('.bento-dock .bento-palette')).toBeVisible();
  await expect(page.locator('.bento-palette:not(.bento-palette--compact)')).toHaveCount(0);

  // 固定工具条贴底：`bottom: calc(12px + env(safe-area-inset-bottom))`。
  // Chromium 的 iPhone 模拟会给出非零安全区（实测 9px），所以只钉「贴近底部」，
  // 不写死 12 —— 否则这条会在不同模拟档 / 系统安全区下随机变红。
  const dock = (await page.locator('.bento-dock').boundingBox())!;
  const vp = page.viewportSize()!;
  const gap = Math.round(vp.height - (dock.y + dock.height));
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThanOrEqual(40);

  // 选中第三块 → 工具条换成那一块的操作；按钮是能点到的尺寸（≥40px）
  await page.locator('.bento-card--text', { hasText: '第三块' }).click();
  await expect(page.locator('.bento-card--text.is-selected')).toContainText('第三块');
  await expect(page.locator('.bento-dock .bento-palette')).toHaveCount(0);
  const sizes = page.locator('.bento-dock .bento-size--lg');
  expect(await sizes.count()).toBeGreaterThanOrEqual(6);
  for (const h of await sizes.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
    expect(h).toBeGreaterThanOrEqual(40);
  }

  await page.getByRole('button', { name: '上移一块' }).click();
  await page.getByRole('button', { name: '上移一块' }).click();
  await expect.poll(() => textOrder(page)).toEqual(['第三块', '第一块', '第二块']);

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.bento-notice')).toHaveText('已保存');
  await page.reload();
  await expect.poll(() => textOrder(page)).toEqual(['第三块', '第一块', '第二块']);

  // 手机上不能横向溢出
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('手机：滚到底时最后一块不被固定工具条盖住', async ({ page, isMobile }) => {
  test.skip(!isMobile, '固定工具条只在手机存在');

  const u = await registerFreshUser(page, { core: true });
  const blocks: BlockPayload[] = [];
  for (let i = 0; i < 6; i++) blocks.push(textBlock(`块 ${i}`, i % 2 === 0 ? 0 : 1, Math.floor(i / 2), 1, 1));
  expect((await saveBlocks(page, blocks)).status).toBe(200);

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(async () => {
      const last = (await page.locator('.bento-card').last().boundingBox())!;
      const dock = (await page.locator('.bento-dock').boundingBox())!;
      return Math.round(dock.y - (last.y + last.height));
    })
    .toBeGreaterThanOrEqual(0);
});
