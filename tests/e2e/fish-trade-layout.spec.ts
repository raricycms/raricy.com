// 练手盘**持仓行**的几何：一行放不下时必须折行，而不是把首列压成几十像素。
//
// 【为什么要单独一个文件】这条缺陷在 2026-09 加三栏工作台时进来，**没有任何用例盯着**
// 所以活到了有人截图才被发现：`grid-template-columns: 1fr auto auto` 在一张 252px 宽的
// 卡里把首列压到 **47px**，于是「开仓 / 80,000.00 / 爆仓 / 72,000.00 / 09-26 / 13:16」
// 一个词占一行 —— 看着像样式根本没写。而且窗口越宽卡越窄（三栏的右栏是固定宽），
// 所以它在大屏上最严重。
//
// 【这个文件钉的是什么】折行判据住在 _fish-trade.scss 的 `@container (max-width: 380px)`，
// 这里钉的是那条判据的**后果**（首列够宽、开仓那一行不碎），不是它的实现 ——
// 换成别的写法只要后果还在，用例照旧绿。
//
// 【为什么不进 RESPONSIVE_SPECS】用例自己 setViewportSize 把三档都跑一遍
// （三栏 / 单列宽 / 手机），再挂到 mobile project 上是白跑一遍同样三条。
//
// 【依赖「展示价是冻住的」这一点吗】不依赖。量的是行宽，与价格无关；而 10× 那一笔
// 比 1× 多一枚角标和一段「爆仓 …」，是这一行**最宽**的形态，所以拿它量最坏情况。

import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

/**
 * 首列的**下限**。折行之后 main 独占一整行（单列档 ~660px、三栏档 ~220px），
 * 单行版式里它拿到的是「行宽 − 盈亏 − 按钮 − 间隙」（单列档 ~479px）。
 * 取 140 是留了余量的：实测过的那条缺陷是 **47px**，而健康状态最低也有 ~220px。
 */
const MIN_MAIN_WIDTH = 140;

/** 「开仓 80,000.00 · 爆仓 72,000.00 · 09-26 13:16」这条信息允许折的行数。 */
const MAX_ENTRY_LINES = 2;

/** 开一笔 10× 的仓（这一行最宽的形态），返回时可开始量。 */
async function openOneLeveragedPosition(page: Page) {
  await registerFreshUser(page, { core: true });
  await page.request.post('/api/checkin', { data: {} });
  await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  await page.request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=BTCUSDT&price=80000`);
  await page.goto('/fish/trade');

  await page.getByRole('button', { name: '10×', exact: true }).click();
  await page.locator('#trade-amount').fill('1');
  await page.locator('.trade-submit').click();
  await page.locator('.trade-confirm__ok').click();
  await expect(page.locator('.trade-position')).toHaveCount(1);
}

/** 量首列宽度与「开仓」那一行的实际行数。 */
async function measureRow(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('.trade-position__main')!;
    const entry = document.querySelector('.trade-position__entry')!;
    const cs = getComputedStyle(entry);
    // line-height 可能是 'normal'（没显式设过）—— 那时按字号的 1.4 倍估，够用
    const lh =
      cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.4 : parseFloat(cs.lineHeight);
    const box = document.querySelector('.trade-position')!;
    return {
      main: Math.round(main.getBoundingClientRect().width),
      entryLines: Math.round(entry.getBoundingClientRect().height / lh),
      // 整行的宽与高：报错时能一眼看出是卡多宽、折没折
      rowWidth: Math.round(box.getBoundingClientRect().width),
      rowHeight: Math.round(box.getBoundingClientRect().height),
    };
  });
}

// 三档各量一次。1280 = 三栏（右栏 300px，卡最窄）；700 = 单列宽（卡最宽）；
// 375 = 手机（单列窄，卡又缩回去）。中间那一档正是「卡宽不是视口单调函数」的证据 ——
// 单行版式（不折行）只在它这里出现，用例必须把它盖上，否则折行判据可能被写死成
// 「永远折」而没人发现。
for (const [name, width] of [
  ['三栏 1280（卡最窄）', 1280],
  ['单列 700（卡最宽）', 700],
  ['手机 375（卡又变窄）', 375],
] as const) {
  test(`持仓行的首列永远够宽：${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openOneLeveragedPosition(page);

    const m = await measureRow(page);
    const detail = `（行 ${m.rowWidth}px × ${m.rowHeight}px，首列 ${m.main}px）`;

    // ① 首列够宽 —— 这正是那条缺陷违反的东西
    expect(m.main, `首列只有 ${m.main}px ${detail}`).toBeGreaterThanOrEqual(MIN_MAIN_WIDTH);
    // ② 「开仓 / 爆仓 / 时间」那一行不碎
    expect(
      m.entryLines,
      `开仓那一行折了 ${m.entryLines} 行 ${detail}`
    ).toBeLessThanOrEqual(MAX_ENTRY_LINES);
  });
}

/**
 * 折没折行？判据是**盈亏在首列的右边还是下方**。
 * ⚠️ 别拿「两边顶边是否齐平」当判据：不折行时 `align-items: center` 会把较矮的盈亏块
 * 垂直居中，两者顶边本来就不齐（第一版就是这么写错的）。
 */
async function isFolded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const main = document.querySelector('.trade-position__main')!.getBoundingClientRect();
    const pnl = document.querySelector('.trade-position__pnl')!.getBoundingClientRect();
    // 折行时 main 跨满两列（`grid-column: 1 / -1`），盈亏落到它**下面**去了
    return pnl.top >= main.bottom - 4;
  });
}

test('★ 折行判据没有写成「永远折」：卡够宽时三样并排，卡窄时才折', async ({ page }) => {
  // 700px 视口 = 单列档，持仓卡拿到 ~660px —— 够宽，应当是三样并排的一行
  await page.setViewportSize({ width: 700, height: 900 });
  await openOneLeveragedPosition(page);
  expect(await isFolded(page), '单列宽档下这一行不该折（卡有 ~660px）').toBe(false);

  // 1280px 视口 = 三栏档，右栏把这张卡压到 300px —— 必须折
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await isFolded(page), '三栏档下这一行必须折（首列单行放不下）').toBe(true);

  // 折回去也一样（折行判据是容器宽，不是「曾经多宽」）
  await page.setViewportSize({ width: 700, height: 900 });
  expect(await isFolded(page), '视口变回去之后应当自己展开').toBe(false);
});
