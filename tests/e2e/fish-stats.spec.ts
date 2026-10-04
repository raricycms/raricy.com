// 练手盘统计页（/fish/trade/stats）—— 数与入口的端到端链路。
//
// 【为什么必须有 e2e】这里是**第二次**把一笔交易的钱算出来（第一次是平仓那一刻）。
//   统计页与结算走的是同一批库列，但中间隔着一次查询、一次聚合、一次单位换算 ——
//   任何一处理解错（拿鱼干当存储单位、把 `status !== 'open'` 写成 `=== 'closed'`、
//   把拆解表按白名单硬遍历），屏幕上那几个数**看起来都完全合理**。所以这里从真链路
//   走一遍：签到拿鱼 → 定价 → 买入 → 改价 → 卖出 → 进统计页对账。
//
// 【价格必须是可控的】成交价是下单那一刻现取的 `fetchQuote()`，用例用替身定价
//   （`__e2e__/set-price`），所以「涨 10% 该到手多少」写得出来。
//
// ⚠️ **展示缓存是冻住的，别断言浮动盈亏的绝对值**：全部 spec 共用一个 `next start`，
//    而轮询器在 e2e 里被 `MARKET_POLL_MS=0` 关掉、缓存只在空的时候才刷一次 ——
//    于是那个价是「本轮第一个渲染页面的 spec 当时设的价」。断言精确的浮动盈亏 =
//    顺序相关的 flaky。DB 派生的数（KPI / 拆解表）看的是**成交价**，那是现取的，可控。
//    浮动那一块只比**跨页相等**（见最后一条用例），那与价格无关。
//
// ⚠️ 造不出爆仓：强平循环在 e2e 被置成 1 小时（置 0 会连杠杆开仓一起关掉，见
//    CLAUDE.md），所以「爆仓」那一格在这里只能是 0 —— 真的爆仓行由
//    tests/service/market-stats-service.test.ts 用强平引擎那套夹具造。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser, publishBlog } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

/** 给行情替身定价 —— 用例据此让「涨」和「跌」成为确定的事实。 */
async function setPrice(request: APIRequestContext, symbol: string, price: number) {
  const res = await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=${symbol}&price=${price}`);
  expect(res.status(), `定价 ${symbol}=${price} 失败`).toBe(200);
}

/**
 * 新号 + 签到拿鱼（e2e 里唯一不绕开业务的造鱼方式）。
 *
 * 【为什么只有一次 POST】签到现在是**一步式**：`POST /api/checkin` 建当日记录 +
 * 发 `CHECKIN_REWARD_FISH`（3）条鱼干 + 写流水，全在一个事务里（抽卡那套已在 2026-09
 * 下线，`/api/checkin/claim` 这个端点不存在了）。钉住那个发鱼数，与
 * `fish-trade.spec.ts` 的 `fundByCheckin` 同一口径 —— 它变了这两处一起红。
 */
async function fundByCheckin(page: Page) {
  await publishBlog(page); // 签到的前置条件：名下至少一篇未软删的文章（2026-10 起）
  const res = await page.request.post('/api/checkin', { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  expect(Number((await res.json()).dried_fish), '签到固定发 3 条鱼干').toBe(3);
}

/** 走 UI 买一笔（投 1 条）：填金额 → 二次确认 → 等它真的回来。 */
async function buyViaUI(page: Page, amount: string) {
  await page.locator('#trade-amount').fill(amount);
  await page.locator('.trade-submit').click();
  const confirm = page.locator('.trade-confirm');
  await expect(confirm).toBeVisible();
  await confirm.locator('.trade-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('#toast-container .toast__body').last()).toContainText('已买入');
}

/** 走 UI 卖掉第一笔持仓。 */
async function sellViaUI(page: Page) {
  await page.locator('.trade-position').first().locator('.trade-position__sell').click();
  const confirm = page.locator('.trade-confirm');
  await expect(confirm).toBeVisible();
  await confirm.locator('.trade-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
}

/** 一个 KPI 格里的数字。`data-kpi` 是稳定的钩子（不随文案变）。 */
const kpi = (page: Page, name: string) =>
  page.locator(`.tstats-kpi[data-kpi="${name}"] .tstats-kpi__value`);

/** 一张拆解表（按标题那一栏定位 —— 页面上有两张，顺序不该被用例依赖）。 */
const breakdown = (page: Page, title: string) =>
  page.locator('.tstats-card').filter({ has: page.getByRole('heading', { name: title }) });

test('新号：KPI 全是 0、胜率是「—」、不渲染拆解表', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  await page.goto('/fish/trade/stats');

  await expect(kpi(page, 'pnl')).toHaveText('0.0000');
  // ★ 0 笔时是「—」不是 0%：「一场没赢」与「还没打过」不是一回事
  await expect(kpi(page, 'winrate')).toHaveText('—');
  await expect(kpi(page, 'count')).toHaveText('0');
  await expect(kpi(page, 'liquidated')).toHaveText('0');
  await expect(kpi(page, 'stake')).toHaveText('0.0000');
  await expect(kpi(page, 'payout')).toHaveText('0.0000');
  // 一笔没有时不给两张各两行 0 的表 —— 那是噪音
  await expect(page.locator('.tstats-table')).toHaveCount(0);
  await expect(page.locator('.tstats-empty').first()).toContainText('还没有已结清的战绩');
});

test('买卖一轮：笔数 / 胜率 / 盈亏 / 拆解表与那一笔的结算数对得上', async ({ page, request }) => {
  await registerFreshUser(page, { core: true });
  await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');

  // 涨 10% 再卖：floor(10000 × 1.1 × 0.9998) = 10997 个单位 = 1.0997 条
  await setPrice(request, 'BTCUSDT', 88000);
  await sellViaUI(page);

  await page.goto('/fish/trade/stats');

  await expect(kpi(page, 'count')).toHaveText('1');
  await expect(kpi(page, 'winrate')).toHaveText('100.0%');
  await expect(kpi(page, 'pnl')).toHaveText('+0.0997');
  await expect(kpi(page, 'stake')).toHaveText('1.0000');
  await expect(kpi(page, 'payout')).toHaveText('1.0997');
  await expect(kpi(page, 'liquidated')).toHaveText('0');

  const bySymbol = breakdown(page, '按标的');
  const btc = bySymbol.locator('tbody tr').filter({ hasText: 'BTC' });
  await expect(btc.locator('td').nth(1)).toHaveText('1');
  await expect(btc.locator('td').nth(2)).toHaveText('100.0%');
  await expect(btc.locator('td').nth(3)).toHaveText('+0.0997');
  await expect(btc.locator('td').nth(4)).toHaveText('0');
  // ★ 没碰过的标的照样占一行 0（那是「还没交易过」，有信息量）—— 但胜率是「—」
  const eth = bySymbol.locator('tbody tr').filter({ hasText: 'ETH' });
  await expect(eth.locator('td').nth(1)).toHaveText('0');
  await expect(eth.locator('td').nth(2)).toHaveText('—');
  await expect(eth.locator('td').nth(3)).toHaveText('0.0000');

  const byLeverage = breakdown(page, '按杠杆');
  // 白名单有几档就有几行（没碰过的也占一行 0）：阶梯 1/2/3/5/10/20 + 彩票档 100
  await expect(byLeverage.locator('tbody tr')).toHaveCount(7);
  const one = byLeverage.locator('tbody tr').filter({ hasText: '1×' });
  await expect(one.locator('td').nth(1)).toHaveText('1');
  await expect(one.locator('td').nth(3)).toHaveText('+0.0997');
});

test('★ 持仓浮动盈亏与 /fish/trade 持仓行上那个数逐字相同', async ({ page, request }) => {
  await registerFreshUser(page, { core: true });
  await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  // 改价但**不卖** —— 留一笔持仓当浮动盈亏的样本
  await setPrice(request, 'BTCUSDT', 88000);

  // 持仓行上那个数（TradePanel 的 estimate()）
  const onTrade = (await page.locator('.trade-position__profit').first().innerText()).trim();
  expect(onTrade, '持仓行应当显示一个带符号的盈亏').toMatch(/^[+-]?\d+\.\d{4}$/);

  await page.goto('/fish/trade/stats');
  const row = page.locator('tr[data-position-id]');
  await expect(row).toHaveCount(1);
  // ★ 两页读同一份展示缓存价、调同一个 settleClose、用同一个费率 —— 所以必须逐字相同。
  //   这条**与价格无关**，因此在「展示价冻住」的 e2e 里是稳定的。
  await expect(row.locator('.tstats-pnl')).toHaveText(onTrade);
  // 只有一笔持仓，合计就等于它
  await expect(page.locator('.tstats-total strong')).toHaveText(onTrade);
});

test('非 core 用户进不了统计页：原地 403', async ({ page }) => {
  // 刻意**不提权**
  await registerFreshUser(page);
  const res = await page.goto('/fish/trade/stats');
  expect(res?.status(), '档不够 → 原地 403（不是跳登录页）').toBe(403);
});

test('未登录访问统计页 → 跳登录页并带回跳地址', async ({ page }) => {
  await page.goto('/fish/trade/stats');
  await expect(page).toHaveURL('/login?next=%2Ffish%2Ftrade%2Fstats');
});

test('两处入口都能进统计页', async ({ page }) => {
  await registerFreshUser(page, { core: true });

  // ① /fish 卡片的 info 区（**不能**放进那条被用例钉死为 3 颗的行动条）
  await page.goto('/fish');
  await page.locator('.fish-card__info-link', { hasText: '练手盘统计' }).click();
  await expect(page).toHaveURL('/fish/trade/stats');

  // ② 练手盘页头副标题里那条
  await page.goto('/fish/trade');
  await page.locator('.trade-stats-link').click();
  await expect(page).toHaveURL('/fish/trade/stats');
});
