// 练手盘图表的**交互**（几何/版式/配色已按仓库约定交给页面验收，不在这里量）。
//
// 留下的三条都需要真浏览器 + 真 canvas：缩放后画出来的蜡烛根数与渲染宽度、
// 滚轮在非被动监听里真的 preventDefault 掉页面滚动、拖动平移真的换了时间轴窗口。
// 这些在 service/route 层都碰不到 —— 它们只看得到接口返回的数据。
//
// 【为什么不进 RESPONSIVE_SPECS】原来那几条「三栏是不是一行 / 自选是否摊平 / 有没有横向
// 滚动」是纯视口几何，已按仓库约定删除（交给页面验收）；剩下的交互与视口无关，
// desktop 一遍覆盖即可。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

/** 新号 + 定价 + 进页面，等图真的画出来（交互需要初始视野已渲染）。 */
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
  await expect
    .poll(() => bodyWidth(page), { message: '滚轮该把蜡烛放大', timeout: 10_000 })
    .toBeGreaterThan(w0);

  expect(await page.evaluate(() => window.scrollY), '滚轮被页面吃掉了 = 监听是 passive 的').toBe(scrolled);
});

test('拖动平移：往右拖看更早的行情', async ({ page, request }) => {
  await openChart(page, request);

  // ⚠️ 先把绘图区**滚进视口**再量坐标。手机上这一页是单列，图被推到视口下沿之外，
  // 而 `boundingBox()` 给的是视口坐标 —— 直接拿它去 `page.mouse.move()`，点会落在
  // 视口外（WebKit 那条**可视**视口还比 layout viewport 更矮），**一个 pointer 事件
  // 都收不到**（实测：box.y 535 + 图高 240 → 拖拽点 y=655，而视口只有 ~633 高）。
  // `locator.click()/dblclick()` 会自己滚进视口，**裸的 `page.mouse.*` 不会** ——
  // 同一个文件里「双击复位」在手机上没事、这条却挂过，差别就在这里。
  const plotLoc = page.locator('.trade-chart__plot');
  await plotLoc.scrollIntoViewIfNeeded();
  const plot = (await plotLoc.boundingBox())!;
  const firstTime = () => page.locator('.trade-chart__axis-label--time').first().innerText();

  const before = await firstTime();
  await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.75, plot.y + plot.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(firstTime, { message: '拖了但时间轴没动', timeout: 10_000 })
    .not.toBe(before);

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
