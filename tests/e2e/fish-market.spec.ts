// 鱼干市场（/fish/market）—— 用户间转账的端到端链路。
//
// 【为什么必须有 e2e】单测把 account-client 整个 mock 掉了，证明不了「真发了 HTTP、
// 带对了 from/to/entry_type/幂等键」。这里查账户服务替身收到的转账记录，把这条跨进程
// 的链路焊死 —— 且替身**按 idempotency_key 去重**，所以「连续两笔同额 = 远端两条
// 不同键的记录」只有端到端才验证得了（键若重复，第二笔会被替身静默吞掉：本地记两笔、
// 远端记一笔，账目无声分叉）。
//
// 【为什么用签到给新号发鱼】新注册用户余额为 0，而转账要真金白银。签到翻牌是 e2e 里
// 唯一不绕开业务的造鱼方式（CLI grant 要拉子进程；直接改库等于绕开被测路径）。
// 运势值 1-5 随机，所以断言只用「≥1」与相对变化，不写死数值。
//
// 【为什么**发款方**必须 core+ 而收款方不用】签到是 core+ 档（鱼干的赚取渠道全在 core
// 门槛之后），所以凡是走 fundByCheckin 造鱼的账号都得先提权。收款方**刻意保持
// role=user** —— 「非核心账号拿不到鱼干，但仍然收得到转账」正是这套口径要保住的一半，
// 顺手就让每条转账用例都覆盖到它。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser, loginViaApi } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

const ACCOUNT_MOCK = 'http://127.0.0.1:3101';
/** 站点自身（无状态发包要打真实服务，不能只打替身）。 */
const BASE_URL = 'http://127.0.0.1:3100';

interface RemoteTransfer {
  from_user_id: string;
  to_user_id: string;
  amount: number;
  entry_type: string;
  idempotency_key: string | null;
}

/** 账户服务替身收到的全部转账记录。 */
async function remoteTransfers(request: APIRequestContext): Promise<RemoteTransfer[]> {
  const res = await request.get(`${ACCOUNT_MOCK}/__e2e__/transfers`);
  const body = (await res.json()) as { transfers: RemoteTransfer[] };
  return body.transfers;
}

/** 新号 + 签到翻牌拿鱼，返回到账后的余额（鱼干，1-5）。 */
async function fundByCheckin(page: Page): Promise<number> {
  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);
  const claim = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status()).toBe(200);
  const body = await claim.json();
  const balance = Number(body.dried_fish);
  expect(balance).toBeGreaterThanOrEqual(1);
  return balance;
}

/** 走 UI 转一笔：选收款人 → 填金额 → 确认弹窗 → 确认。 */
async function transferViaUI(page: Page, username: string, amount: string) {
  await page.locator('.market-recipient-pick').click();
  await expect(page.locator('.market-picker')).toBeVisible();
  await page.locator('.market-picker__search').fill(username);
  const item = page.locator('.market-picker__item', { hasText: username });
  await expect(item).toHaveCount(1);
  await item.click();
  await expect(page.locator('.market-recipient__name')).toHaveText(username);

  await page.locator('#market-amount').fill(amount);
  await page.locator('.market-submit').click();

  const confirm = page.locator('.market-confirm');
  await expect(confirm, '转账必须先过二次确认弹窗').toBeVisible();
  await expect(confirm).toContainText(username);
  await confirm.locator('.market-confirm__ok').click();

  // ★ 必须等这一笔**真的回来**再返回：成功才会关弹窗并复位表单（失败时弹窗按设计保留，
  //   好让用户原样重试）。不加这一步，下一次调用里的 toast 断言会被**上一笔**残留的
  //   toast 满足，用例就在「第二笔还在飞」的时候去读替身记录 —— 表现得像远端少记了一笔。
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.market-recipient-pick')).toBeVisible();
  await expect(page.locator('#toast-container .toast__body').last()).toContainText('已转给');
}

test('转账全链路：入口 → 选收款人 → 二次确认 → 到账 + 远端记账', async ({ page, request }) => {
  const sender = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);

  // 收款人：另一个新号（注册会把浏览器切成它的登录态，稍后要切回来）
  const recipient = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  // ── 入口：/fish 余额卡里「查看流水」旁边 ────────────────────────────────
  await page.goto('/fish');
  const marketLink = page.locator('.fish-card__actions a', { hasText: '鱼干市场' });
  await expect(marketLink).toBeVisible();
  await expect(page.locator('.fish-card__actions a', { hasText: '查看流水' })).toBeVisible();
  await marketLink.click();

  await expect(page).toHaveURL(/\/fish\/market$/);
  await expect(page.locator('.page-title')).toContainText('鱼干市场');
  await expect(page.locator('.market-card__balance-number')).toHaveText(String(balance));

  // ── 转账（金额 1：必然 ≤ 余额，因为签到至少给 1）────────────────────────
  await transferViaUI(page, recipient.username, '1');

  await expect(page.locator('.market-card__balance-number')).toHaveText(String(balance - 1));
  // 成功后表单复位（收款人与金额都清空），避免误点第二笔
  await expect(page.locator('.market-recipient-pick')).toBeVisible();
  await expect(page.locator('#market-amount')).toHaveValue('');

  // ── 远端确实记了一笔（用发送者自己的 Key 扣款）──────────────────────────
  const mine = (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].to_user_id).toBe(recipient.id);
  expect(mine[0].amount).toBe(1);
  expect(mine[0].entry_type).toBe('transfer');
  expect(mine[0].idempotency_key, '键必须存在且不超账户服务的 64 字符上限').toBeTruthy();
  expect(mine[0].idempotency_key!.length).toBeLessThanOrEqual(64);

  // ── 流水页能按「转账」筛出这一条（发送者侧只有转出）────────────────────
  await page.goto('/fish/transactions?type=transfer_all');
  const rows = page.locator('.fish-transaction');
  await expect(rows).toHaveCount(1); // 发送者只有转出这一条
  await expect(rows.first()).toContainText(recipient.username);
});

test('连续两笔同额：远端收到两条**不同键**的记录（幂等键不能复用）', async ({ page, request }) => {
  const sender = await registerFreshUser(page, { core: true });
  await fundByCheckin(page);
  const recipient = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  await page.goto('/fish/market');
  // 0.1：签到底线是 1，两笔 0.1 必然够
  await transferViaUI(page, recipient.username, '0.1');
  await transferViaUI(page, recipient.username, '0.1');

  const allTransfers = await remoteTransfers(request);
  const mine = allTransfers.filter((t) => t.from_user_id === sender.id);
  expect(mine, `本地记两笔，远端也必须记两笔。全部记录=${JSON.stringify(allTransfers)}`).toHaveLength(2);
  expect(mine[0].amount).toBe(0.1);
  expect(mine[1].amount).toBe(0.1);
  expect(
    mine[0].idempotency_key,
    '同额两笔必须各有各的键 —— 复用会被账户服务当重放静默去重'
  ).not.toBe(mine[1].idempotency_key);
});

test('余额不足与转给自己：前端拦住 + 服务端 400，远端无新记录', async ({ page, request }) => {
  const sender = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);
  const recipient = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  await page.goto('/fish/market');

  // 前端：金额超余额 → 提示 + 提交按钮禁用（连确认弹窗都进不去）
  await page.locator('.market-recipient-pick').click();
  await page.locator('.market-picker__search').fill(recipient.username);
  await page.locator('.market-picker__item', { hasText: recipient.username }).click();
  await page.locator('#market-amount').fill(String(balance + 1));
  await expect(page.locator('.market-field__hint--error')).toContainText('小鱼干不足');
  await expect(page.locator('.market-submit')).toBeDisabled();
  await expect(page.locator('.market-confirm')).toHaveCount(0);

  // 服务端（绕开前端）：余额不足 → 400，且不产生任何远端记录
  const before = (await remoteTransfers(request)).length;
  const over = await page.request.post('/api/fish/market/transfer', {
    data: { to_user_id: recipient.id, amount: balance + 1 },
  });
  expect(over.status()).toBe(400);
  expect((await over.json()).message).toContain('不足');

  // 转给自己 → 400
  const self = await page.request.post('/api/fish/market/transfer', {
    data: { to_user_id: sender.id, amount: 1 },
  });
  expect(self.status()).toBe(400);
  expect((await self.json()).message).toContain('自己');

  expect((await remoteTransfers(request)).length, '两笔非法请求都不该打远端').toBe(before);
  // 余额一分未动
  await page.reload();
  await expect(page.locator('.market-card__balance-number')).toHaveText(String(balance));
});

test('收银台：商户链接 → 核对 → 输密码支付 → 返回商户；参数非法时给出明确错误', async ({
  page,
  request,
}) => {
  const sender = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);
  const merchant = await registerFreshUser(page); // 站外商户 / 银行账号
  await loginViaApi(page, sender.username);

  const RETURN = 'https://bank.example/paid';
  const payUrl =
    `/fish/pay?to=${merchant.username}&amount=1&note=order-1` +
    `&from=${encodeURIComponent('鱼干银行')}&return=${encodeURIComponent(RETURN)}`;

  await page.goto(payUrl);

  // 商户横幅必须明说「本站不验证商户身份」（商户名是链接里的自由文本）
  await expect(page.locator('.pay-merchant__name')).toContainText('鱼干银行');
  await expect(page.locator('.pay-merchant__badge')).toContainText('不验证商户身份');
  await expect(page.locator('.market-recipient__name')).toHaveText(merchant.username);
  await expect(page.locator('.pay-amount__value')).toHaveText('1');
  await expect(page.locator('.pay-note')).toContainText('order-1');

  // ── 没输密码：按钮禁用（step-up 不可跳过）───────────────────────────────
  await expect(page.locator('.market-submit')).toBeDisabled();

  // ── 密码错误：401 → toast 报错，钱一分不动 ───────────────────────────────
  await page.locator('#pay-password').fill('definitely-not-the-password');
  await page.locator('.market-submit').click();
  await expect(page.locator('#toast-container .toast__body')).toContainText('用户名或密码错误');
  await expect(page.locator('.pay-result')).toHaveCount(0);
  expect(
    (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id),
    '密码错误绝不能产生转账'
  ).toHaveLength(0);

  // ── 正确密码：支付成功 + 远端记账 + 返回商户按钮 ────────────────────────
  await page.locator('#pay-password').fill(SEED_PASSWORD);
  await page.locator('.market-submit').click();

  await expect(page.locator('.pay-result__title')).toContainText('支付成功');
  await expect(page.locator('.pay-result__to')).toContainText(merchant.username);
  await expect(page.locator('.pay-result__balance')).toContainText(String(balance - 1));
  const backLink = page.locator('.pay-result__return');
  await expect(backLink).toHaveAttribute('href', RETURN);
  await expect(backLink, '返回按钮要显示目标主机名，让人看清去哪').toContainText('bank.example');

  const mine = (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].to_user_id).toBe(merchant.id);
  expect(mine[0].entry_type).toBe('transfer');

  // ── 参数非法：友好错误页（不是 500，也不是渲染出半个支付页）────────────
  await page.goto('/fish/pay?to=' + merchant.username + '&amount=1.23');
  await expect(page.locator('.pay-error__message')).toContainText('金额参数无效');
  await page.goto('/fish/pay?to=no_such_user_at_all&amount=1');
  await expect(page.locator('.pay-error__message')).toContainText('收款人不存在');
});

test('收银台：带 order 的链接，付完刷新再付一次**不会**重复扣款', async ({ page, request }) => {
  const sender = await registerFreshUser(page, { core: true });
  await fundByCheckin(page); // 得先有鱼干才付得出去
  const merchant = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  // 关键：链接里带上商户订单号。
  const payUrl = `/fish/pay?to=${merchant.username}&amount=1&order=order-77`;
  await page.goto(payUrl);
  await page.locator('#pay-password').fill(SEED_PASSWORD);
  await page.locator('.market-submit').click();

  await expect(page.locator('.pay-result__title')).toContainText('支付成功');
  // 付款人拿到的凭据号（共享单号），商户流水里有同一个值
  const receipt = await page.locator('.pay-result__receipt code').textContent();
  expect(receipt, '凭据号应当是 16 位十六进制').toMatch(/^[0-9a-f]{16}$/);
  const balanceAfterFirst = await page.locator('.pay-result__balance').textContent();

  const first = (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id);
  expect(first, '第一次支付应当成交').toHaveLength(1);

  // ── 刷新同一个链接再付一次：必须被认成同一笔 ────────────────────────────
  // 这正是 order 参数存在的理由。没有它时键基每次加载都随机，这一次会真的再扣一笔。
  await page.goto(payUrl);
  await page.locator('#pay-password').fill(SEED_PASSWORD);
  await page.locator('.market-submit').click();

  await expect(page.locator('.pay-result__title')).toContainText('这笔已经付过了');
  await expect(
    page.locator('.pay-result__receipt code'),
    '重放回报的必须是**原来那笔**的凭据号'
  ).toHaveText(receipt!);

  const after = (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id);
  expect(after, '★ 刷新后再付一次不能产生第二笔').toHaveLength(1);
  // 余额只被扣了一次：重放回报的余额与第一次支付后**一模一样**
  //（注：不断言 /fish 页的余额 —— 那一页走远端账户服务拿权威值，这里只有 mock）
  await expect(page.locator('.pay-result__balance')).toHaveText(balanceAfterFirst!);
});

test('收银台：order 非法时明确报错，不静默丢掉防重保护', async ({ page }) => {
  const sender = await registerFreshUser(page, { core: true });
  const merchant = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  await page.goto(`/fish/pay?to=${merchant.username}&amount=1&order=${encodeURIComponent('has space')}`);
  await expect(page.locator('.pay-error__message')).toContainText('订单号参数无效');
  // 超长（32 位以上）
  await page.goto(`/fish/pay?to=${merchant.username}&amount=1&order=${'a'.repeat(33)}`);
  await expect(page.locator('.pay-error__message')).toContainText('订单号参数无效');
  // 数字过长（会撑爆幂等键的长度上限，必须在页面就被挡住）
  await page.goto(`/fish/pay?to=${merchant.username}&amount=${'9'.repeat(30)}`);
  await expect(page.locator('.pay-error__message')).toContainText('金额参数无效');
});

test('收银台：未登录时跳本站登录页（密码只输在 raricy 域名下），登录后回到收银台', async ({
  browser,
}) => {
  // 用一个真实存在的用户当收款人：收款人不存在会先撞上参数校验（那是另一条用例）。
  const merchant = SEED_USERS.core.username;
  const payPath = `/fish/pay?to=${merchant}&amount=1&from=${encodeURIComponent('某商户')}`;

  // 全新 context：没有任何会话 cookie，模拟从商户站点点过来的陌生用户
  const ctx = await browser.newContext();
  const anonPage = await ctx.newPage();
  try {
    await anonPage.goto(payPath);

    // 关键：跳的是**本站**登录页，且 next 带着回跳参数 —— 密码从这里开始
    // 就只输入在 raricy 的域名下，商户站点全程接触不到。
    await expect(anonPage).toHaveURL(/\/login\?next=/);
    await expect(anonPage.locator('input[type="password"]')).toBeVisible();
    const next = new URL(anonPage.url()).searchParams.get('next') ?? '';
    expect(next, 'next 必须指回收银台并带上原参数').toContain('/fish/pay?');
    expect(next).toContain('amount=1');
  } finally {
    await ctx.close();
  }
});

test('无状态单次发包：不带任何 cookie，仅凭用户名 + 密码转账 / 查余额 / 查流水', async ({
  page,
  playwright,
  request,
}) => {
  const sender = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);
  const recipient = await registerFreshUser(page);

  // 全新 context —— 与浏览器那条会话**完全隔离**，一个 cookie 都没有
  const anon = await playwright.request.newContext({ baseURL: BASE_URL });
  expect((await anon.storageState()).cookies, '前提：这个 context 确实无会话').toHaveLength(0);

  try {
    // ── 转账：一次发包，凭据在 body 里 ───────────────────────────────────
    const res = await anon.post('/api/fish/market/transfer', {
      data: {
        username: sender.username,
        password: SEED_PASSWORD,
        to_username: recipient.username,
        amount: 1,
        note: '机器人转账',
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const json = await res.json();
    expect(json.recipient.username).toBe(recipient.username);
    expect(json.balance).toBe(balance - 1);
    expect(JSON.stringify(json), '响应里绝不能回显密码').not.toContain(SEED_PASSWORD);

    // 远端确实记了这一笔（跨进程链路真的通了，不只是本地改了数）
    const mine = (await remoteTransfers(request)).filter(
      (t) => t.from_user_id === sender.id && t.entry_type === 'transfer'
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].to_user_id).toBe(recipient.id);

    // ── 查余额 ──────────────────────────────────────────────────────────
    const bal = await anon.post('/api/fish/market/balance', {
      data: { username: sender.username, password: SEED_PASSWORD },
    });
    expect(bal.status()).toBe(200);
    expect((await bal.json()).balance).toBe(balance - 1);

    // ── 查流水（带 type 筛选）───────────────────────────────────────────
    const txs = await anon.post('/api/fish/market/transactions', {
      data: { username: sender.username, password: SEED_PASSWORD, type: 'transfer_all' },
    });
    expect(txs.status()).toBe(200);
    const txJson = await txs.json();
    expect(txJson.total).toBe(1);
    expect(txJson.transactions[0]).toMatchObject({ amount: -1, type: 'transfer' });

    // ── 密码错误 → 401，且分文不动 ──────────────────────────────────────
    const bad = await anon.post('/api/fish/market/transfer', {
      data: {
        username: sender.username,
        password: 'definitely-not-the-password',
        to_username: recipient.username,
        amount: 1,
      },
    });
    expect(bad.status()).toBe(401);
    expect((await bad.json()).message).toBe('用户名或密码错误');
    expect(
      (await remoteTransfers(request)).filter((t) => t.from_user_id === sender.id),
      '凭据错误不能产生第二笔'
    ).toHaveLength(1);
  } finally {
    await anon.dispose();
  }
});
