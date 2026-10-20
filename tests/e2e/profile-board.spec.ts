import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, publishBlog, registerFreshUser } from './helpers';

// 个人主页「积木墙」的端到端契约。
//
// 【2026-10 改版后的摆放模型】两端是**同一份坐标**：桌面 4 列自由网格是唯一真相，
// 手机 2 列由它投影（`projectMobile`）：宽 ≥2 通栏、宽 1 看左右半、按桌面阅读顺序
// (y, x) 紧排。手机上的拖动 / 左右移 / 上下移改的都是桌面坐标。所以这里必须同时
// 验证「4 列的落点」和「2 列的投影」，而且**别把实现细节（数组顺序、132px 行高、
// sort 列）当契约** —— 用户看得见的是：格子是不是方的、两列怎么对齐、拖完是不是
// 换位、保存后是不是立刻看到新版。
//
// 两遍都必须跑（本文件登记在 playwright.config.ts 的 RESPONSIVE_SPECS）：桌面量
// 4 列几何 / 吸顶工具条，手机量投影落位 / 拖动把手 / 左右移 / 固定工具条遮挡。
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

type SaveBody = {
  code?: number;
  message?: string;
  /** PUT 成功时顶层回传（apiOk 把 data 摊平，不是 data.blocks）。 */
  count?: number;
  blocks?: unknown[];
  isDefault?: boolean;
  data?: unknown;
};

function textBlock(text: string, x = 0, y = 0, w = 2, h = 1): BlockPayload {
  return { id: '', kind: 'text', x, y, w, h, config: { title: '', text } };
}

async function saveBlocks(page: Page, blocks: BlockPayload[]) {
  const res = await page.request.put('/api/profile/blocks', { data: { blocks } });
  const body = (await res.json().catch(() => ({}))) as SaveBody;
  return { status: res.status(), body };
}

/** 按正文定位一张文字卡（`.bento-card--text`）。 */
function textCard(page: Page, text: string) {
  return page.locator('.bento-card--text', { hasText: text });
}

async function boxOf(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  expect(box, '卡片应该有几何尺寸（可见且已布局）').not.toBeNull();
  return box!;
}

/** 桌面/手机的入场动画会让 boundingBox 量到中间帧；量几何前先关掉。 */
async function freezeMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

/**
 * 选中一张卡（手机上点卡片上部）：避开左上角把手，也避开贴底的固定工具条 ——
 * 直接点卡片中心时，第二行卡片的中心可能正好落在 dock 下面，Playwright 会一直
 * 重试「元素被遮挡」。这不改断言对象（选中的仍是同一张卡）。
 */
async function tapCard(card: ReturnType<Page['locator']>) {
  const box = await boxOf(card);
  await card.click({ position: { x: Math.min(box.width - 24, Math.max(60, box.width * 0.6)), y: 20 } });
}

test('新用户主页：全页唯一入口在身份条；空态与引导面板只剩文案；访客看到「还没有布置」', async ({ page }) => {
  const u = await registerFreshUser(page, { core: true });

  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-empty__title')).toHaveText('这里还没有东西');
  // 身份条那颗是**唯一**入口（空态 / 引导面板不再各放一颗）。
  await expect(page.getByRole('link', { name: '布置主页' })).toBeVisible();
  await expect(page.locator('.bento-guide__title')).toHaveText('这是你的名片');
  await expect(page.locator('.bento-guide').getByRole('button')).toHaveCount(0);
  await expect(page.locator('.bento-empty').getByRole('button')).toHaveCount(0);

  // 访客（匿名可达是主页的前提 —— 画报二维码就是这么来的）
  await page.context().clearCookies();
  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-empty__text')).toHaveText('这个人还没有布置主页。');
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '布置主页' })).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('点身份条「布置主页」编辑栏立刻出现；保存后不刷新就显示新版与入口', async ({ page, isMobile }) => {
  const u = await registerFreshUser(page, { core: true });

  // 从查看态**点入口**进入编辑（不是直接 goto ?edit=1）：组件早已挂载，能否把
  // startEditing 的 prop 变化同步进本地状态，正是这条要钉的。
  await page.goto(`/u/${u.id}`);
  await page.getByRole('link', { name: '布置主页' }).click();
  await expect(page).toHaveURL(/edit=1/);
  await expect(page.locator('.bento.is-editing')).toHaveCount(1);
  await expect(page.locator('.bento-toolbar')).toBeVisible();
  // 编辑态里同一页只留一个入口：身份条那颗先隐藏
  await expect(page.getByRole('link', { name: '布置主页' })).toHaveCount(0);

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
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);

  // ★ 不 reload：PUT 响应里的 blocks 已经写进本地状态，立刻就能看到新版。
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');
  // 入口回来了 —— 不再依赖「是否默认布局」。
  await expect(page.getByRole('link', { name: '布置主页' })).toBeVisible();
  await expect(page.locator('.bento-empty')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(`/u/${u.id}`);
  await expect(page.locator('.bento-card--text')).toContainText('主页上的第一句话');
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
});

test('非核心用户：能看自己的主页，但没有布置入口、进不了编辑、接口 403', async ({ page }) => {
  const u = await registerFreshUser(page); // 默认 role=user

  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  await expect(page.locator('.profile-tier-note')).toContainText('布置主页目前对核心用户开放');
  await expect(page.getByRole('link', { name: '布置主页' })).toHaveCount(0);

  const res = await saveBlocks(page, []);
  expect(res.status).toBe(403);
});

test('保存接口回传保存后的整页数据（顶层 count / blocks / isDefault）', async ({ page }) => {
  const u = await registerFreshUser(page, { core: true });
  const res = await saveBlocks(page, [textBlock('接口契约', 0, 0, 2, 1)]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.code).toBe(200);
  expect(res.body.count).toBe(1);
  expect(res.body.isDefault).toBe(false);
  expect(Array.isArray(res.body.blocks)).toBe(true);
  expect(res.body.blocks).toHaveLength(1);
  // apiOk 把 data 摊平在顶层：没有内层 data.blocks（客户端保存后立刻重画靠它）
  expect(res.body.data).toBeUndefined();
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

  // 档位只在读路径判，保存只校归属：不能因为这一条指针失效就把整页锁死。
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

test('桌面：4 列方格（宽≈高）、gap 16、连续网格线，吸顶工具条停在顶栏下方', async ({ page, isMobile }) => {
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

  await freezeMotion(page);
  await page.goto(`/u/${u.id}?edit=1`);
  const cards = page.locator('.bento-card--text');
  await expect(cards).toHaveCount(16);

  const first = await boxOf(cards.nth(0));
  const second = await boxOf(cards.nth(1));
  // 同一行的两块：顶边对齐；横向间隔就是网格 gap（16px）
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(Math.round(second.x - (first.x + first.width))).toBe(16);
  // 方格：行高 = 列宽（不再有写死的 132px 行高）
  expect(Math.abs(first.width - first.height)).toBeLessThanOrEqual(2);
  // 第 5 块（第二行第一个）与第一块同一列；竖直间隔也是 16
  const fifth = await boxOf(cards.nth(4));
  expect(Math.abs(fifth.x - first.x)).toBeLessThan(2);
  expect(Math.round(fifth.y - (first.y + first.height))).toBe(16);

  // 编辑态网格线：桌面 3 条竖线 + (行数-1) 条横线，画在 gap 中线上、整片连续细线。
  // 4 行卡片 + 一行空位 = 5 行 → 4 条横线。
  await expect(page.locator('.bento-guides')).toHaveCount(1);
  await expect(page.locator('.bento-guides__v')).toHaveCount(3);
  await expect(page.locator('.bento-guides__h')).toHaveCount(4);
  for (const w of await page
    .locator('.bento-guides__v')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))) {
    expect(w).toBeLessThanOrEqual(2); // 1px 细线，不是每格一圈边框
  }
  for (const h of await page
    .locator('.bento-guides__h')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
    expect(h).toBeLessThanOrEqual(2);
  }

  // 吸顶：toolbar 的 top 是 74px（与博客筛选条同一档），滚动后必须落在那里、
  // 且不能压住顶栏
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect
    .poll(async () => Math.round((await page.locator('.bento-toolbar').boundingBox())!.y))
    .toBe(74);
  const navbar = await boxOf(page.locator('.site-navbar'));
  expect(navbar.y + navbar.height).toBeLessThanOrEqual(74);

  // 加块面板在桌面是流内吸底（不是固定层）
  await expect(page.locator('.bento-palette')).toHaveCount(1);
  await expect(page.locator('.bento-dock')).toHaveCount(0);
});

test('手机：卡片按桌面坐标投影落位（方格 / gap 12 / 宽块通栏），网格线照画', async ({ page, isMobile }) => {
  test.skip(!isMobile, '两列投影只在窄屏生效');

  const u = await registerFreshUser(page, { core: true });
  // 数组顺序故意与桌面阅读顺序相反：手机上的位置来自 (x, y) 投影，不是数组顺序。
  const saved = await saveBlocks(page, [
    textBlock('右半块', 3, 0, 1, 1), // 桌面右半 → 手机右列
    textBlock('左半块', 0, 0, 1, 1), // 桌面左半 → 手机左列
    textBlock('通栏块', 1, 1, 2, 1), // 桌面第 2–3 列（跨中线）→ 手机通栏
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await freezeMotion(page);
  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-card')).toHaveCount(3);

  const left = await boxOf(textCard(page, '左半块'));
  const right = await boxOf(textCard(page, '右半块'));
  // 同一行左右并排；手机 gap 是 12
  expect(Math.abs(left.y - right.y)).toBeLessThan(2);
  expect(Math.round(right.x - (left.x + left.width))).toBe(12);
  expect(left.x).toBeLessThan(right.x);
  // 手机也是方格（行高 = 列宽）
  expect(Math.abs(left.width - left.height)).toBeLessThanOrEqual(2);

  // 宽块（含跨中线的 2×1）在手机上通栏：从最左到最右、宽度 = 两列 + gap
  const wide = await boxOf(textCard(page, '通栏块'));
  expect(Math.abs(wide.x - left.x)).toBeLessThan(2);
  expect(Math.abs(wide.x + wide.width - (right.x + right.width))).toBeLessThan(2);
  expect(Math.round(wide.y - (left.y + left.height))).toBe(12);

  // 手机编辑态也画网格线：1 竖 + (行数-1) 横。这里投影出 2 行卡片 + 1 行空位 = 3 行。
  await expect(page.locator('.bento-guides')).toHaveCount(1);
  await expect(page.locator('.bento-guides__v')).toHaveCount(1);
  await expect(page.locator('.bento-guides__h')).toHaveCount(2);

  // 不能横向溢出
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});

test('手机：dock 左移 / 右移 / 同列上下移，改的是桌面坐标并在保存后保持', async ({ page, isMobile }) => {
  test.skip(!isMobile, '底部固定工具条只在窄屏存在');

  const u = await registerFreshUser(page, { core: true });
  const saved = await saveBlocks(page, [
    textBlock('甲', 0, 0, 1, 1), // 左列第 0 行
    textBlock('乙', 0, 1, 1, 1), // 左列第 1 行
    textBlock('丙', 3, 0, 1, 1), // 右列第 0 行（同列没有邻居）
    textBlock('宽块', 1, 2, 2, 1), // 通栏：没有左右可言
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await freezeMotion(page);
  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toBeVisible();

  // 没选中时底部工具条是「加一块」
  await expect(page.locator('.bento-dock .bento-palette')).toBeVisible();

  // 丙独占右列：上移 / 下移都没有同列邻居 → 两颗都置灰（不是按「行优先序」硬排）
  await tapCard(textCard(page, '丙'));
  await expect(page.getByRole('button', { name: '上移一块' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下移一块' })).toBeDisabled();

  // 乙的上方同列是甲：上移 = 与甲换位（丙那一列不动）
  await tapCard(textCard(page, '乙'));
  const jiaBefore = await boxOf(textCard(page, '甲'));
  const bingBefore = await boxOf(textCard(page, '丙'));
  await expect(page.getByRole('button', { name: '上移一块' })).toBeEnabled();
  await page.getByRole('button', { name: '上移一块' }).click();

  await expect.poll(async () => {
    const yi = await boxOf(textCard(page, '乙'));
    const jia = await boxOf(textCard(page, '甲'));
    return yi.y < jia.y;
  }).toBe(true);
  // 隔壁列的丙没被连带换位
  const bingAfter = await boxOf(textCard(page, '丙'));
  expect(Math.abs(bingAfter.y - bingBefore.y)).toBeLessThan(2);
  expect(Math.abs(bingAfter.x - bingBefore.x)).toBeLessThan(2);

  // 乙现在在左列：右移换到右半（目标格被丙占着时先换位）
  const yiBeforeMove = await boxOf(textCard(page, '乙'));
  await page.getByRole('button', { name: '移到右边一半' }).click();
  await expect.poll(async () => (await boxOf(textCard(page, '乙'))).x > yiBeforeMove.x + 40).toBe(true);

  // 宽块通栏：左右两颗置灰（按了也没方向）
  await tapCard(textCard(page, '宽块'));
  await expect(page.getByRole('button', { name: '移到左边一半' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '移到右边一半' })).toBeDisabled();

  // 保存后（不刷新）位置就变了，刷新后仍是同一份 —— 手机改的就是桌面坐标
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.bento-notice')).toHaveText('已保存');
  // 等 router.replace 把 ?edit=1 拿掉再刷新，否则刷新会重新进编辑态
  await expect(page).not.toHaveURL(/edit=1/);
  await page.reload();
  await expect(page.locator('.bento-toolbar')).toHaveCount(0);
  const yiFinal = await boxOf(textCard(page, '乙'));
  const jiaFinal = await boxOf(textCard(page, '甲'));
  expect(yiFinal.x).toBeGreaterThan(jiaFinal.x); // 乙在右列
  expect(Math.abs(yiFinal.y - jiaFinal.y)).toBeLessThan(2); // 同一行
  // 与桌面阅读顺序一致：甲（左半 / y0）仍是第一块
  expect(jiaFinal.x).toBeLessThan(yiFinal.x);
});

test('手机：按住左上角把手拖到另一张卡上即与它换位', async ({ page, isMobile }) => {
  test.skip(!isMobile, '把手拖动只在窄屏存在（整卡拖会和页面滚动抢手势）');

  const u = await registerFreshUser(page, { core: true });
  const saved = await saveBlocks(page, [
    textBlock('甲', 0, 0, 1, 1), // 左列第 0 行
    textBlock('乙', 0, 1, 1, 1), // 左列第 1 行
    textBlock('丙', 3, 0, 1, 1), // 右列第 0 行
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await freezeMotion(page);
  await page.goto(`/u/${u.id}?edit=1`);
  // page.mouse 不会像 click 那样自动滚动：先把网格滚到吸顶工具条下方，再量几何 /
  // 发 pointer 事件。否则鼠标按在视口外的坐标上，pointerdown 根本落不到把手上。
  await page.evaluate(() => {
    const stage = document.querySelector('.bento-stage');
    if (!stage) return;
    const y = stage.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, y - 220));
  });
  const jia = textCard(page, '甲');
  const yi = textCard(page, '乙');
  const bing = textCard(page, '丙');

  const jiaBefore = await boxOf(jia);
  const yiBefore = await boxOf(yi);
  const bingBefore = await boxOf(bing);
  expect(jiaBefore.x).toBeLessThan(bingBefore.x); // 甲在左列、丙在右列
  // 两块都在视口内（否则下面的 mouse 事件没有落点）
  expect(jiaBefore.y).toBeGreaterThan(0);
  expect(jiaBefore.y + jiaBefore.height).toBeLessThan(page.viewportSize()!.height);

  const grip = jia.locator('.bento-card__grip--drag');
  const gb = await boxOf(grip);
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bingBefore.x + bingBefore.width / 2, bingBefore.y + bingBefore.height / 2, {
    steps: 12,
  });
  await page.mouse.up();

  // 换位：甲跑到右列（丙原来的位置），丙落到甲原来的位置
  await expect.poll(async () => {
    const jiaNow = await boxOf(jia);
    const bingNow = await boxOf(bing);
    return jiaNow.x > bingNow.x;
  }).toBe(true);
  await expect.poll(async () => {
    const jiaNow = await boxOf(jia);
    const bingNow = await boxOf(bing);
    return Math.abs(jiaNow.x - bingBefore.x) < 2 && Math.abs(bingNow.x - jiaBefore.x) < 2;
  }).toBe(true);
  // 乙没有被卷进来（它还在左列第 1 行）
  const yiNow = await boxOf(yi);
  expect(Math.abs(yiNow.x - yiBefore.x)).toBeLessThan(2);
  expect(Math.abs(yiNow.y - yiBefore.y)).toBeLessThan(2);

  // 拖完是未保存改动，工具条会说出来；保存后刷新仍是换过的位置
  await expect(page.locator('.bento-toolbar__dirty')).toHaveText('有未保存的修改');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.bento-notice')).toHaveText('已保存');
  await expect(page).not.toHaveURL(/edit=1/);
  await page.reload();
  await expect.poll(async () => (await boxOf(jia)).x > (await boxOf(bing)).x).toBe(true);
});

test('手机：滚到底时最后一块不被固定工具条盖住', async ({ page, isMobile }) => {
  test.skip(!isMobile, '固定工具条只在手机存在');

  const u = await registerFreshUser(page, { core: true });
  const blocks: BlockPayload[] = [];
  for (let i = 0; i < 6; i++) {
    blocks.push(textBlock(`块 ${i}`, i % 2 === 0 ? 0 : 2, Math.floor(i / 2), 1, 1));
  }
  expect((await saveBlocks(page, blocks)).status).toBe(200);

  await freezeMotion(page);
  await page.goto(`/u/${u.id}?edit=1`);
  await expect(page.locator('.bento-toolbar')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(async () => {
      const last = await boxOf(page.locator('.bento-card').last());
      const dock = await boxOf(page.locator('.bento-dock'));
      return Math.round(dock.y - (last.y + last.height));
    })
    .toBeGreaterThanOrEqual(0);
});

test('文章高卡片显示正文摘要；查看态点文字块弹出详情，Esc / 点背景关闭', async ({ page }) => {
  const u = await registerFreshUser(page, { core: true });
  const blog = await publishBlog(page, 'public'); // 正文：# e2e / 发布过文章才能签到。

  const saved = await saveBlocks(page, [
    { id: '', kind: 'blog', x: 0, y: 0, w: 2, h: 2, config: { blogId: blog } },
    textBlock('点开这块会看到完整的详情层', 0, 2, 2, 1),
  ]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  await page.goto(`/u/${u.id}`);
  // h≥2 的文章块有第二行空间 → 显示正文纯文本摘要（不是 description 的复制品）
  const tall = page.locator('.bento-card--blog.is-tall');
  await expect(tall).toHaveCount(1);
  await expect(tall.locator('.bento-blog__excerpt')).toContainText('发布过文章才能签到');

  // 查看态点文字块：详情层是带 dialog 语义的模态，从卡片位置放大过来
  const text = page.locator('.bento-card--text .bento-text.is-tappable');
  await text.click();
  const detail = page.locator('.bento-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute('role', 'dialog');
  await expect(detail.locator('.bento-detail__text')).toHaveText('点开这块会看到完整的详情层');

  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // 再打开一次，点背景关闭
  await text.click();
  await expect(detail).toBeVisible();
  await page.mouse.click(5, 5); // 左上角属于背景，面板居中
  await expect(detail).toHaveCount(0);
});
