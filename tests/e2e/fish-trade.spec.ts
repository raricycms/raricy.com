// 鱼干练手盘（/fish/trade）—— 买 / 卖 / 结算的端到端链路。
//
// 【为什么必须有 e2e】两件事单测证明不了：
//   ① 成交价真的是**下单那一刻现取**的。单测把 fetchQuote mock 掉了，只能证明
//      「调了它」；这里改替身的价 → 下单 → 看余额真按新价结算，才是端到端的证据。
//      而这条正是整个功能唯一的安全边界（见 src/lib/market-price.ts 的文件头）。
//   ② 远端账本里真的是 market_buy / market_sell。改价、点按钮、查替身收到的转账
//      —— 跨进程那一截只有 e2e 焊得住。
//
// 【价格必须是可控的】行情源指向 tests/e2e/mock-market-price.ts（playwright.config
// 的 MARKET_PRICE_BASE_URL），用例自己用 __e2e__/set-price 定价。打真币安的话
// 「涨一倍该 mint 多少」根本写不出来 —— 真实行情每毫秒都在动。
//
// 【为什么投 1 条鱼干】签到翻牌给 1-5 条，投 1 条保证任何初始余额都够。注意存储层
// 最小单位是 0.1 条（10 个单位），所以 1 条 = 10 个单位：涨 100% 的实发是
// floor(10 × 2 × 0.999) = 19 个单位 = 1.9 条。断言写精确值，不写「变多了」。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';
const ACCOUNT_MOCK = 'http://127.0.0.1:3101';

interface RemoteTransfer {
  from_user_id: string;
  to_user_id: string;
  amount: number;
  entry_type: string;
  idempotency_key: string | null;
}

/** 给行情替身定价 —— 用例据此让「涨」和「跌」成为确定的事实。 */
async function setPrice(request: APIRequestContext, symbol: string, price: number) {
  const res = await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=${symbol}&price=${price}`);
  expect(res.status(), `定价 ${symbol}=${price} 失败`).toBe(200);
}

async function remoteTransfers(request: APIRequestContext): Promise<RemoteTransfer[]> {
  const body = (await (await request.get(`${ACCOUNT_MOCK}/__e2e__/transfers`)).json()) as {
    transfers: RemoteTransfer[];
  };
  return body.transfers;
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

  // 必须等这一笔真的回来再返回 —— 与 transferViaUI 同一条纪律：不等的话，
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

test('买入全链路：定价 → 下单 → 扣款 + 建仓 + 远端记 market_buy', async ({ page, request }) => {
  const user = await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await expect(page.locator('.trade-card--quote')).toBeVisible();
  await expect(page.locator('.trade-quote__name').first()).toHaveText('BTC');

  await buyViaUI(page, '1');

  await expect.poll(() => uiBalance(page), { message: '买入后余额应减少 1 条' }).toBe(start - 1);

  // 持仓出现，开仓价来自替身（不是页面上那个展示值）
  const pos = page.locator('.trade-position').first();
  await expect(pos).toContainText('BTC');
  await expect(pos).toContainText('80,000.00');

  // 远端真收到了这一笔，entry_type 与方向都对
  const sent = (await remoteTransfers(request)).filter((t) => t.from_user_id === user.id);
  expect(sent).toHaveLength(1);
  expect(sent[0].entry_type).toBe('market_buy');
  expect(sent[0].to_user_id).toBe('raricy-blog-system');
  expect(sent[0].amount).toBe(1);
  expect(sent[0].idempotency_key).toBeTruthy();
  expect(String(sent[0].idempotency_key).length).toBeLessThanOrEqual(64);
});

test('★ 涨价卖出 → 按真实涨跌幅 mint（成交价是下单那一刻现取的）', async ({
  page,
  request,
}) => {
  const user = await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  await expect.poll(() => uiBalance(page)).toBe(start - 1);

  // 翻倍。1 条 = 10 个单位 → floor(10 × 2 × 0.999) = 19 个单位 = 1.9 条
  await setPrice(request, 'BTCUSDT', 160000);
  // 页面上的展示价 15 秒才轮询一次，但这里**不依赖它** —— 成交价由服务端现取，
  // 所以定价之后立刻卖就够。这本身就是那条安全边界在端到端的体现。
  await sellViaUI(page);

  await expect
    .poll(() => uiBalance(page), { message: '涨一倍后到账应为 1.9 条' })
    .toBe(Math.round((start - 1 + 1.9) * 10) / 10);
  await expect(page.locator('.trade-position'), '卖完之后持仓应清空').toHaveCount(0);

  // ⚠️ 只按 to_user_id 过滤会把**签到**那条也捞进来 —— 它同样是「系统 → 用户」。
  // 必须带上 entry_type。
  const sent = (await remoteTransfers(request)).filter(
    (t) => t.entry_type === 'market_sell' && t.to_user_id === user.id
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].from_user_id).toBe('raricy-blog-system');
  expect(sent[0].amount).toBe(1.9);
});

test('★ 跌价卖出 → 拿回的比投入少（亏的那部分 burn 回系统水池）', async ({ page, request }) => {
  const user = await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  await page.goto('/fish/trade');
  await buyViaUI(page, '1');
  await expect.poll(() => uiBalance(page)).toBe(start - 1);

  // 腰斩。floor(10 × 0.5 × 0.999) = floor(4.995) = 4 个单位 = 0.4 条
  await setPrice(request, 'BTCUSDT', 40000);
  await sellViaUI(page);

  await expect
    .poll(() => uiBalance(page), { message: '腰斩后只该拿回 0.4 条' })
    .toBe(Math.round((start - 1 + 0.4) * 10) / 10);

  const sent = (await remoteTransfers(request)).filter(
    (t) => t.entry_type === 'market_sell' && t.to_user_id === user.id
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].amount).toBe(0.4);
});

test('★ 重复卖同一笔 → 200 且标记重放，钱不多发', async ({ page, request }) => {
  await registerFreshUser(page, { core: true });
  await fundByCheckin(page);
  await setPrice(request, 'BTCUSDT', 80000);

  // 走 API 是为了拿到 position_id（UI 上卖掉之后那一行就没了）
  const opened = await page.request.post('/api/fish/trade/buy', {
    data: { symbol: 'BTCUSDT', amount: 1 },
  });
  expect(opened.status()).toBe(200);
  const positionId = (await opened.json()).position.id as string;

  await setPrice(request, 'BTCUSDT', 160000);
  const first = await page.request.post('/api/fish/trade/sell', {
    data: { position_id: positionId },
  });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.replayed).toBe(false);
  expect(firstBody.payout).toBe(1.9);

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
