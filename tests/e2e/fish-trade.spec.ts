// 鱼干练手盘（/fish/trade）—— 买 / 卖 / 结算的端到端链路。
//
// 【为什么必须有 e2e】两件事单测证明不了：
//   ① 成交价真的是**下单那一刻现取**的。单测把 fetchQuote mock 掉了，只能证明
//      「调了它」；这里改替身的价 → 下单 → 看余额真按新价结算，才是端到端的证据。
//      而这条正是整个功能唯一的安全边界（见 src/lib/market-price.ts 的文件头）。
//   ② 一次下单真的同时落了三样东西：余额、流水、持仓行。它们在**同一个 SQLite 事务**
//      里提交，只有真跑一遍才看得见落库后的账长什么样 —— 余额与流水对不上、
//      流水指向的持仓行不存在，这类问题单测的服务层断言一个都抓不到。
//
// 【读回来的账就是事实】鱼干账户曾经在站外一个独立微服务里，那时 e2e 手里没有别的
// 凭证，只能靠「那个服务收到了这笔」间接证明它发生过。搬进站内之后账目就在同一个库里，
// 直接读本站的流水读口
//（GET /api/fish/transactions）即可：买入是一条 market_buy（−），卖出是一条
// market_sell（+），两者都**没有对手方**（「系统水池」是账外概念，不是一行用户）。
//
// 【价格必须是可控的】行情源指向 tests/e2e/mock-market-price.ts（playwright.config
// 的 MARKET_PRICE_BASE_URL），用例自己用 __e2e__/set-price 定价。打真币安的话
// 「涨一倍该 mint 多少」根本写不出来 —— 真实行情每毫秒都在动。
//
// 【为什么投 1 条鱼干】签到翻牌给 1-5 条，投 1 条保证任何初始余额都够。注意存储层
// 最小单位是 0.0001 条（1 个单位），所以 1 条 = 10000 个单位：涨 100% 的实发是
// floor(10000 × 2 × 0.9998) = 19996 个单位 = 1.9996 条。断言写精确值，不写「变多了」。
//
// ⚠️ 这几个数字**跟着存储精度与费率走**：精度从 0.1 抬到 0.0001 之后，floor 少丢的零头
// 让实发从 1.9 变成 1.998 —— 差的这 0.098 正是那次改动的全部收益；费率从 0.1% 降到
// 0.02% 之后它又变成 1.9996。再动这两个数时这几处必红。
// 「平价卖出」那条（1.0000 − 0.0002 = 0.9998）同理：粒度 0.1 时那一笔会 floor 成 0.9，
// 手续费看起来就像 10%。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

/** GET /api/fish/transactions 的一行（那条读口是 snake_case）。amount 单位是鱼干。 */
interface LedgerRow {
  amount: number;
  type: string;
  description: string | null;
  related_user_id: string | null;
  transfer_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
}

/** 给行情替身定价 —— 用例据此让「涨」和「跌」成为确定的事实。 */
async function setPrice(request: APIRequestContext, symbol: string, price: number) {
  const res = await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=${symbol}&price=${price}`);
  expect(res.status(), `定价 ${symbol}=${price} 失败`).toBe(200);
}

/** 当前会话用户的流水。type 传 market_all 取买 + 卖两条腿。 */
async function myLedger(page: Page, type?: string): Promise<LedgerRow[]> {
  const res = await page.request.get(
    `/api/fish/transactions${type ? `?type=${encodeURIComponent(type)}` : ''}`
  );
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).transactions ?? []) as LedgerRow[];
}

/** 新号 + 签到翻牌拿鱼（e2e 里唯一不绕开业务的造鱼方式）。 */
async function fundByCheckin(page: Page): Promise<number> {
  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);
  const claim = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status()).toBe(200);
  const balance = Number((await claim.json()).dried_fish);
  expect(balance).toBeGreaterThanOrEqual(1);
  return balance;
}

const uiBalance = (page: Page) =>
  page.locator('.trade-card__balance-number').innerText().then(Number);

/** 走 UI 买一笔：填金额 → 二次确认 → 等它真的回来。 */
async function buyViaUI(page: Page, amount: string) {
  await page.locator('#trade-amount').fill(amount);
  await page.locator('.trade-submit').click();

  const confirm = page.locator('.trade-confirm');
  await expect(confirm, '买入必须先过二次确认弹窗').toBeVisible();
  await confirm.locator('.trade-confirm__ok').click();

  // 必须等这一笔真的回来再返回 —— 与转账的 transferViaUI 同一条纪律：不等的话，
  // 下一次断言会被上一笔残留的 toast 满足，用例在「请求还在飞」时就往下走了。
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

test('买入全链路：定价 → 下单 → 扣款 + 建仓 + 记 market_buy 流水', async ({ page, request }) => {
  await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await expect(page.locator('.trade-card--quote')).toBeVisible();
  // 自选列表的第一行必须是 BTC —— 钉的是 MARKET_SYMBOLS 的顺序与短名映射
  //（displaySymbol），不是某个 DOM 位置
  await expect(page.locator('.trade-watch__name').first()).toHaveText('BTC');
  // 买入面板上那一行费率（与卖出弹窗里的是同一个 formatFeeRate，见 market-math）。
  // 钉住文本而不只是数字：0.02% 被渲染成「0.0%」时**页面上一切照常**，只有这里会红。
  await expect(page.locator('.trade-summary')).toContainText('手续费 0.02%');

  await buyViaUI(page, '1');

  await expect.poll(() => uiBalance(page), { message: '买入后余额应减少 1 条' }).toBe(start - 1);

  // 持仓出现，开仓价来自替身（不是页面上那个展示值）
  const pos = page.locator('.trade-position').first();
  await expect(pos).toContainText('BTC');
  await expect(pos).toContainText('80,000.00');
  // 持仓行也带现价与「较开仓」涨跌 —— 价没动过，所以是 0.00%（0 不带正号）
  await expect(pos).toContainText('现价 80,000.00');
  await expect(pos).toContainText('较开仓 0.00%');

  // ── 账目：一条 market_buy，扣 1，且**没有对手方** ──────────────────────
  const rows = await myLedger(page, 'market_buy');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ amount: -1, type: 'market_buy' });
  expect(rows[0].description, '流水里要写清是哪个标的、什么价成交的').toContain('BTC');
  expect(
    rows[0].related_user_id,
    '练手盘没有对手方 —— 「系统水池」是账外概念，不是一行用户'
  ).toBeNull();

  // 读回来的余额与页面上那个数同源（余额的真源就是本地 users.dried_fish）
  const bal = await page.request.get('/api/fish/balance');
  expect((await bal.json()).balance).toBe(start - 1);
});

test('卖出细则：弹窗摊开涨跌 / 毛额 / 手续费 / 盈亏 / 到手，且「预计到手」= 真到账', async ({
  page,
  request,
}) => {
  // 价**全程不动**：这一屏里的每个数因此都是确定的，断言写精确值。
  // 这条用例钉的是「页面上那几个数不是另算一遍的」—— 弹窗的 0.9998 与真到账的 0.9998
  // 走的是同一个 settleClose（src/lib/market-math.ts）。谁把公式抄回页面一份，
  // 这里迟早红。
  await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  await expect.poll(() => uiBalance(page)).toBe(start - 1);

  await page.locator('.trade-position').first().locator('.trade-position__sell').click();
  const confirm = page.locator('.trade-confirm');
  await expect(confirm).toBeVisible();

  await expect(confirm, '弹窗要有卖出细则这一屏').toContainText('开仓价');
  await expect(confirm).toContainText('80,000.00');
  // 价没动 → 0.00%（fmtPct 只在**大于** 0 时给正号：0 既不是涨也不是跌）
  await expect(confirm, '价没动 → 较开仓价为 0').toContainText('0.00%');
  await expect(confirm).toContainText('手续费 0.02%');
  // 投 1 条、价没动：毛额 1.0000，手续费 1.0000 × 0.02% = 0.0002，到手 0.9998。
  // ★ 平价卖出**也要亏**，亏的正好是手续费 —— 这是「频繁进出被磨」的全部实现。
  await expect(confirm).toContainText('1.0000 小鱼干');
  await expect(confirm).toContainText('-0.0002 小鱼干');
  await expect(confirm).toContainText('-0.0002 小鱼干（-0.02%）');
  await expect(confirm).toContainText('0.9998 小鱼干');

  await confirm.locator('.trade-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
  // ⚠️ 比的是钱，用 toBeCloseTo 而不是 toBe（同 frame-shop.spec.ts）：`start - 1 + 0.9998`
  // 是 double 加法，某些 start 下会算出 3.9998000000000002，而余额那边是 unitsToFish
  // 除出来的精确 3.9998 —— 差一个 ULP，`.toBe` 就会红成「到账金额不对」。
  await expect
    .poll(() => uiBalance(page), { message: '到手应正好是弹窗上显示的那个数' })
    .toBeCloseTo(start - 1 + 0.9998, 4);
});

test('★ 涨价卖出 → 按真实涨跌幅 mint（成交价是下单那一刻现取的）', async ({
  page,
  request,
}) => {
  await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  await expect.poll(() => uiBalance(page)).toBe(start - 1);

  // 翻倍。1 条 = 10000 个单位 → floor(10000 × 2 × 0.9998) = 19996 个单位 = 1.9996 条
  await setPrice(request, 'BTCUSDT', 160000);
  // 页面上的展示价 15 秒才轮询一次，但这里**不依赖它** —— 成交价由服务端现取，
  // 所以定价之后立刻卖就够。这本身就是那条安全边界在端到端的体现。
  await sellViaUI(page);

  await expect
    .poll(() => uiBalance(page), { message: '涨一倍后到账应为 1.9996 条' })
    .toBeCloseTo(start - 1 + 1.9996, 4);
  await expect(page.locator('.trade-position'), '卖完之后持仓应清空').toHaveCount(0);

  // ── 账目：买入那条与卖出那条都在，卖出是 +1.9996（mint 凭空进余额）──────
  const all = await myLedger(page, 'market_all');
  expect(all).toHaveLength(2);
  const sell = all.find((t) => t.type === 'market_sell');
  expect(sell, '卖出必须留下一条 market_sell 流水').toBeTruthy();
  expect(sell!.amount).toBe(1.9996);
  expect(sell!.description).toContain('BTC');
  expect(sell!.related_user_id, '结算没有对手方（见文件头）').toBeNull();
  expect(all.find((t) => t.type === 'market_buy')!.amount).toBe(-1);
});

test('★ 跌价卖出 → 拿回的比投入少（少发的那部分就是 burn 回系统水池）', async ({
  page,
  request,
}) => {
  await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  await expect.poll(() => uiBalance(page)).toBe(start - 1);

  // 腰斩。floor(10000 × 0.5 × 0.9998) = floor(4999) = 4999 个单位 = 0.4999 条
  await setPrice(request, 'BTCUSDT', 40000);
  await sellViaUI(page);

  await expect
    .poll(() => uiBalance(page), { message: '腰斩后只该拿回 0.4999 条' })
    .toBeCloseTo(start - 1 + 0.4999, 4);

  const all = await myLedger(page, 'market_all');
  expect(all).toHaveLength(2);
  const sell = all.find((t) => t.type === 'market_sell');
  expect(sell!.amount, '亏的那部分不发给他 —— 这就是 burn 的全部实现').toBe(0.4999);
});

test('★ 重复卖同一笔 → 200 且标记重放，钱不多发也不多记', async ({ page, request }) => {
  await registerFreshUser(page, { core: true });
  await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  // 走 API 是为了拿到 position_id（UI 上卖掉之后那一行就没了）
  const opened = await page.request.post('/api/fish/trade/buy', {
    data: { symbol: 'BTCUSDT', amount: 1 },
  });
  expect(opened.status()).toBe(200);
  const positionId = (await opened.json()).position.id as string;

  // 买入那条流水指向这一行持仓 —— 账与持仓靠 reference_id 对上
  const buys = await myLedger(page, 'market_buy');
  expect(buys).toHaveLength(1);
  expect(buys[0]).toMatchObject({
    type: 'market_buy',
    reference_type: 'market_position',
    reference_id: positionId,
  });

  await setPrice(request, 'BTCUSDT', 160000);
  const first = await page.request.post('/api/fish/trade/sell', {
    data: { position_id: positionId },
  });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.replayed).toBe(false);
  expect(firstBody.payout).toBe(1.9996);

  const balanceAfterFirst = Number(
    (await (await page.request.get('/api/fish/balance')).json()).balance
  );

  // 同样的请求再发一次 —— 幂等必须挡住，绝不能发第二遍钱
  const again = await page.request.post('/api/fish/trade/sell', {
    data: { position_id: positionId },
  });
  expect(again.status()).toBe(200);
  const againBody = await again.json();
  expect(againBody.replayed).toBe(true);
  expect(againBody.payout, '重放回报的必须是当初结算的那个数').toBe(firstBody.payout);

  const balanceNow = Number(
    (await (await page.request.get('/api/fish/balance')).json()).balance
  );
  expect(balanceNow, '重放不得多发一分钱').toBe(balanceAfterFirst);

  // 重放不但不能多发钱，也不能**多记一笔**（账里两条腿各一条，仅此而已）
  const all = await myLedger(page, 'market_all');
  expect(all).toHaveLength(2);
  expect(all.filter((t) => t.type === 'market_sell')).toHaveLength(1);
});

test('非 core 用户进不了：接口 403、页面 403，且不动钱', async ({ page, request }) => {
  // 刻意**不提权**
  await registerFreshUser(page);
  await setPrice(request, 'BTCUSDT', 80000);

  const res = await page.request.post('/api/fish/trade/buy', {
    data: { symbol: 'BTCUSDT', amount: 1 },
  });
  expect(res.status(), '接口不靠页面挡人 —— 直接 POST 也必须 403').toBe(403);

  const pageRes = await page.goto('/fish/trade');
  expect(pageRes?.status(), '档不够 → 原地 403（不是跳登录页）').toBe(403);
});

test('未登录访问行情接口 → 401', async ({ request }) => {
  const res = await request.get('http://127.0.0.1:3100/api/fish/trade/quote');
  expect(res.status()).toBe(401);
});
