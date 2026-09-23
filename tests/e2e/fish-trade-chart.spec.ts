// 练手盘图表的几何与交互。
//
// 【为什么按真视口量】「三栏是不是真的一行」「绘图区有没有塌成 0」「有没有横向滚动条」
// 全是**浏览器排版之后**才成立的事实，读样式表看不出来 —— grid 列被内容撑破、网格里的
// SVG 高度塌成 0，这两件事在源码里都完全正常，只有量出来才看得见。
//
// 【为什么登记进 RESPONSIVE_SPECS】四段阶梯里有两段只在窄视口走得到（自选变横向条、
// 落成单列）。desktop 那一遍同样要跑 —— 三栏那一档正是最常见的场景。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

/** 新号 + 定价 + 进页面，等图真的画出来（轮询落一次，几何才稳）。 */
async function openChart(page: Page, request: APIRequestContext) {
  await registerFreshUser(page, { core: true });
  await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=BTCUSDT&price=80000`);
  await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=ETHUSDT&price=3000`);
  await page.goto('/fish/trade');
  await expect(page.locator('.trade-chart__candle').first()).toBeVisible();
  await page.waitForTimeout(600);
}

const boxOf = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, `${sel} 量不到盒子`).not.toBeNull();
  return b!;
};

/** 画出来的图元个数（放大 → 可见根数变少 → 画出来的也变少）。 */
const drawnCount = (page: Page) => page.locator('.trade-chart__candle').count();
/** 第一根蜡烛的**渲染宽度**（px）。缩放最直接的后果，且不依赖根数怎么取整。 */
const bodyWidth = async (page: Page) => (await boxOf(page, '.trade-chart__candle')).width;

test('图表不把页面撑宽，绘图区也不塌成 0', async ({ page, request }) => {
  await openChart(page, request);

  const plot = await boxOf(page, '.trade-chart__plot');
  // 网格里的 SVG 给 `height: 100%` 会塌成 0（父格高度由内容决定）—— 那条在源码里看不出来
  expect(plot.height, '绘图区高度塌了').toBeGreaterThan(200);
  expect(plot.width).toBeGreaterThan(200);

  const { scrollW, innerW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(scrollW, '图里的轴 / SVG 把 grid 的列撑破了').toBeLessThanOrEqual(innerW + 1);

  // 轴标签必须落在图表卡里面（两端的日期最容易溢出，它们靠 --first/--last 贴边）
  const card = await boxOf(page, '.trade-card--chart');
  const labels = page.locator('.trade-chart__axis-label');
  const n = await labels.count();
  expect(n).toBeGreaterThan(4);
  for (let i = 0; i < n; i++) {
    const b = (await labels.nth(i).boundingBox())!;
    expect(b.x, `第 ${i} 个轴标签溢出了卡片左边缘`).toBeGreaterThanOrEqual(card.x - 1);
    expect(b.x + b.width, `第 ${i} 个轴标签溢出了卡片右边缘`).toBeLessThanOrEqual(
      card.x + card.width + 1
    );
  }
});

test('版式：宽屏三栏一行，窄屏自选变横条后依次落下', async ({ page, request }) => {
  await openChart(page, request);
  const vw = page.viewportSize()!.width;

  const watch = await boxOf(page, '.trade-watch');
  const chart = await boxOf(page, '.trade-card--chart');
  const side = await boxOf(page, '.trade-side');

  if (vw >= 992) {
    // 三栏：自选 | 图表 | 下单 + 持仓，且在同一行（纵向区间相交）
    expect(watch.x, '自选该在最左').toBeLessThan(chart.x);
    expect(chart.x, '图表该在中间').toBeLessThan(side.x);
    expect(watch.y, '自选与图表该在同一行').toBeLessThan(chart.y + chart.height - 2);
    expect(chart.y, '图表与右栏该在同一行').toBeLessThan(side.y + side.height - 2);
    expect(chart.width, '中间那列拿不到宽度就等于没改成三栏').toBeGreaterThan(400);
  } else {
    // 自选横跨整行 → 图表落在它下面
    expect(chart.y, '窄屏图表该在自选条下面').toBeGreaterThanOrEqual(watch.y + watch.height - 2);
    if (vw < 768) {
      expect(side.y, '单列时右栏该在图下面').toBeGreaterThanOrEqual(chart.y + chart.height - 2);
    }
  }
});

test('自选列表：宽屏竖排、窄屏摊成一行（同一份 DOM）', async ({ page, request }) => {
  await openChart(page, request);
  const vw = page.viewportSize()!.width;

  const rows = page.locator('.trade-watch__row');
  const a = (await rows.nth(0).boundingBox())!;
  const b = (await rows.nth(1).boundingBox())!;

  if (vw <= 991) {
    expect(Math.abs(a.y - b.y), '这两格该并排').toBeLessThan(2);
    expect(a.x).toBeLessThan(b.x);
  } else {
    expect(b.y, '宽屏是竖排').toBeGreaterThanOrEqual(a.y + a.height - 2);
  }
});

test('缩放：放大更少更粗、缩小回来、双击复位', async ({ page, request }) => {
  await openChart(page, request);

  const before = await drawnCount(page);
  const w0 = await bodyWidth(page);

  await page.getByRole('button', { name: '放大' }).click();
  await page.getByRole('button', { name: '放大' }).click();
  const zoomedIn = await drawnCount(page);
  expect(zoomedIn, '放大 = 可见根数变少').toBeLessThan(before);
  expect(await bodyWidth(page), '每根蜡烛该变粗').toBeGreaterThan(w0);

  await page.getByRole('button', { name: '缩小' }).click();
  await page.getByRole('button', { name: '缩小' }).click();
  // 缩回来（根数按整数取整，会差一两根，不断言精确相等）
  expect(await drawnCount(page)).toBeGreaterThanOrEqual(before - 2);

  // 双击复位：放大之后双击，回到默认视野
  await page.getByRole('button', { name: '放大' }).click();
  expect(await drawnCount(page)).toBeLessThan(before);
  await page.locator('.trade-chart__plot').dblclick();
  await expect.poll(() => drawnCount(page)).toBeGreaterThanOrEqual(before - 2);
});

test('滚轮缩放，且页面不跟着滚（非被动监听里 preventDefault 真的生效了）', async ({
  page,
  request,
  isMobile,
}) => {
  // 手机压根没有滚轮（mobile project 跑的是 WebKit，`mouse.wheel` 直接报
  // 「not supported in mobile WebKit」）。触屏那条路是拖动 + 缩放钮，已另有覆盖
  test.skip(isMobile, '滚轮是桌面端的交互');
  await openChart(page, request);

  await page.evaluate(() => window.scrollTo(0, 200));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled, '这张页该是能滚的（否则下面那条断言等于没测）').toBeGreaterThan(0);

  // ⚠️ 盒子必须**滚完之后**再量：boundingBox 是视口坐标，先量后滚的话指针会落在
  // 绘图区外面（实测差 171px，正好落进下面的成交量带），那条「页面不跟着滚」
  // 就变成在测别的地方了。
  const plot = await boxOf(page, '.trade-chart__plot');
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
  const w0 = await bodyWidth(page);
  await page.mouse.wheel(0, -200); // 往上滚 = 放大
  await expect.poll(() => bodyWidth(page), { message: '滚轮该把蜡烛放大' }).toBeGreaterThan(w0);

  expect(await page.evaluate(() => window.scrollY), '滚轮被页面吃掉了 = 监听是 passive 的').toBe(scrolled);
});

test('拖动平移：往右拖看更早的行情', async ({ page, request }) => {
  await openChart(page, request);
  const plot = await boxOf(page, '.trade-chart__plot');
  const firstTime = () => page.locator('.trade-chart__axis-label--time').first().innerText();

  const before = await firstTime();
  await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.75, plot.y + plot.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(firstTime, { message: '拖了但时间轴没动' }).not.toBe(before);

  // 一直往左拖（看更晚的行情）到头也不越界：页面不许出横向滚动条
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(plot.x + plot.width * 0.8, plot.y + plot.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * 0.1, plot.y + plot.height * 0.5, { steps: 5 });
    await page.mouse.up();
  }
  const { scrollW, innerW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(scrollW).toBeLessThanOrEqual(innerW + 1);
});

test('蜡烛配色跟着主题令牌走（涨绿跌红）', async ({ page, request }) => {
  await openChart(page, request);

  const { up, down, upToken, downToken } = await page.evaluate(() => {
    // 令牌是 hex，先借一个探针元素换成浏览器算好的 rgb 形态再比
    const resolve = (v: string) => {
      const el = document.createElement('span');
      el.style.color = v;
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const fillOf = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fill : '';
    };
    const cs = getComputedStyle(document.documentElement);
    return {
      up: fillOf('.trade-chart__candle--up'),
      down: fillOf('.trade-chart__candle--down'),
      upToken: resolve(cs.getPropertyValue('--color-success-primary').trim()),
      downToken: resolve(cs.getPropertyValue('--color-warning-primary').trim()),
    };
  });

  expect(up, '阴线画不出来时这条会拿到空串').toMatch(/^rgb/);
  expect(up).toBe(upToken);
  expect(down).toBe(downToken);
});
