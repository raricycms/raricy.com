// 鱼干市场（/fish/market）—— 用户间转账的端到端链路。
//
// 【为什么必须有 e2e】单测在服务层里断言的是「返回值长什么样」，证明不了
// 「用户在页面上点一下确认，钱真的从一个余额走进另一个余额、两条流水都落了库」。
// 页面 → 路由 → 服务层 → SQLite 这一整条，只有真跑一遍才看得见。
//
// 【账目已经是本站自己的了，断言就直接读本站的账】鱼干账户曾经在站外一个独立微服务
// 里，那时 e2e 只能去问那个服务「你收到转账了吗」。搬进站内之后，余额与流水就在同一个
// 库里、与转账在**同一个事务**里提交 —— **读回来的账**就是事实本身。所以这里读本站的
// 两个读口：会话侧 GET /api/fish/transactions（网页用的那一个），以及站外脚本侧的
// 无状态 POST /api/fish/market/{balance,transactions}（收款人只有凭据、没有会话）。
// 每笔转账都**收付两侧各读一次**，断言余额一减一增、两条流水共享同一个 transfer_id。
//
// 【两笔同额凭什么各算各的】服务端自动生成的幂等键**不登记任何记录**（键每次都不一样，
// 登记没有去重价值，见 src/lib/fish-idempotency.ts 头部）。所以 e2e 手里能证明
// 「这笔与那笔是两个东西」的凭证是 **transfer_id** —— 它由幂等键派生、写进收付双方
// 两条流水；两笔同额若被静默吞掉一笔，第二个单号根本不会存在。
//
// 【为什么用签到给新号发鱼】新注册用户余额为 0，而转账要真金白银。签到翻牌是 e2e 里
// 唯一不绕开业务的造鱼方式（CLI grant 要拉子进程；直接改库等于绕开被测路径）。
// 运势值 1-5 随机，所以断言只用「≥1」与相对变化，不写死数值。
//
// 【为什么**发款方**必须 core+ 而收款方不用】签到是 core+ 档（鱼干的赚取渠道全在 core
// 门槛之后），所以凡是走 fundByCheckin 造鱼的账号都得先提权。收款方**刻意保持
// role=user** —— 「非核心账号拿不到鱼干，但仍然收得到转账」正是这套口径要保住的一半，
// 顺手就让每条转账用例都覆盖到它。收款方能读自己的账也因此被顺带钉住
//（无状态读口不筛 role：账是自己的，没有理由不给看）。

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser, loginViaApi } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

/** 站点自身。显式给 baseURL 是因为 `playwright.request` 新建的 context 不继承
 *  config 里的 use.baseURL —— 不传它，相对路径的请求直接打不出去。 */
const BASE_URL = 'http://127.0.0.1:3100';

/** 一条流水（本文件里的断言统一按这个 **snake_case** 形状写）。 */
interface LedgerRow {
  amount: number;
  type: string;
  description: string | null;
  related_user_id: string | null;
  /** 转账的共享单号；其余流水一律 null。收付双方靠它认同一笔。 */
  transfer_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
}

/** 当前会话用户的流水（会话侧读口）。amount 单位是鱼干，带符号。 */
async function myLedger(page: Page, type?: string): Promise<LedgerRow[]> {
  const res = await page.request.get(
    `/api/fish/transactions${type ? `?type=${encodeURIComponent(type)}` : ''}`
  );
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).transactions ?? []) as LedgerRow[];
}

/**
 * 用**别人的凭据**读他的账与余额（站外脚本那两条无状态读口）。
 *
 * ⚠️ 必须用**独立**的 context。带当前会话的 cookie 去打这两条接口时，
 * `_auth.ts` 明文规定**以会话为准** —— 读回来的会是自己的账，而不是凭据那个人的。
 *
 * 两条读口（会话侧 GET / 无状态侧 POST）现在**逐字段同形**（都是 snake_case，
 * 由 `fish-service.toFishTxJson` 一份映射产出，见它的注释），所以这里直接断言，
 * 不需要任何归一化。**曾经需要过** —— 那时这条口透传服务层 DTO，同一响应里
 * 信封是 snake、数组项是 camel，测试只好两边都认一遍。
 */
async function ledgerOf(
  api: APIRequestContext,
  username: string,
  password: string,
  type?: string
): Promise<{ balance: number; transactions: LedgerRow[] }> {
  const auth = { username, password };
  const bal = await api.post('/api/fish/market/balance', { data: auth });
  expect(bal.status(), await bal.text()).toBe(200);

  const txs = await api.post('/api/fish/market/transactions', {
    data: type ? { ...auth, type } : auth,
  });
  expect(txs.status(), await txs.text()).toBe(200);

  const rows = ((await txs.json()).transactions ?? []) as LedgerRow[];

  return { balance: (await bal.json()).balance as number, transactions: rows };
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
  //   toast 满足，用例就在「第二笔还在飞」的时候去读账 —— 表现得像少记了一笔。
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.market-recipient-pick')).toBeVisible();
  await expect(page.locator('#toast-container .toast__body').last()).toContainText('已转给');
}

test('转账全链路：入口 → 选收款人 → 二次确认 → 到账 + 双方账目', async ({
  page,
  playwright,
}) => {
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
  await expect(page.locator('.market-card__balance-number')).toHaveText(balance.toFixed(4));

  // ── 转账（金额 1：必然 ≤ 余额，因为签到至少给 1）────────────────────────
  await transferViaUI(page, recipient.username, '1');

  await expect(page.locator('.market-card__balance-number')).toHaveText((balance - 1).toFixed(4));
  // 成功后表单复位（收款人与金额都清空），避免误点第二笔
  await expect(page.locator('.market-recipient-pick')).toBeVisible();
  await expect(page.locator('#market-amount')).toHaveValue('');

  // ── 发送方侧：一条 transfer 流水，扣 1 ─────────────────────────────────
  const out = await myLedger(page, 'transfer_all');
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    amount: -1,
    type: 'transfer',
    related_user_id: recipient.id,
  });
  expect(out[0].transfer_id, '两条流水靠这个单号配对，必须落库').toBeTruthy();

  // ── 收款方侧：余额真的 +1，且与上面那条**同一个单号** ──────────────────
  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    const theirs = await ledgerOf(api, recipient.username, SEED_PASSWORD, 'transfer_all');
    expect(theirs.transactions).toHaveLength(1);
    expect(theirs.transactions[0]).toMatchObject({
      amount: 1,
      type: 'transfer_receive',
      related_user_id: sender.id,
    });
    expect(theirs.balance, '收款方余额真的 +1').toBe(1);
    expect(
      theirs.transactions[0].transfer_id,
      '收付双方两条流水必须是同一个单号 —— 双方对账全靠它'
    ).toBe(out[0].transfer_id);
  } finally {
    await api.dispose();
  }

  // ── 流水页能按「转账」筛出这一条（发送者侧只有转出）────────────────────
  await page.goto('/fish/transactions?type=transfer_all');
  const rows = page.locator('.fish-transaction');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(recipient.username);
});

test('连续两笔同额：两笔各自落账（各有一个单号，不被静默去重）', async ({
  page,
  playwright,
}) => {
  const sender = await registerFreshUser(page, { core: true });
  const start = await fundByCheckin(page);
  const recipient = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  await page.goto('/fish/market');
  // 0.1：签到底线是 1，两笔 0.1 必然够
  await transferViaUI(page, recipient.username, '0.1');
  await transferViaUI(page, recipient.username, '0.1');

  const out = await myLedger(page, 'transfer_all');
  expect(out, '本地记两笔，账里就必须是两笔').toHaveLength(2);
  expect(out.map((t) => t.amount)).toEqual([-0.1, -0.1]);
  expect(
    new Set(out.map((t) => t.transfer_id)).size,
    '同额两笔必须各有各的单号 —— 单号若复用，等于有一笔根本没记'
  ).toBe(2);

  // 余额确实被扣了两次（0.2），不是一次
  await expect(page.locator('.market-card__balance-number')).toHaveText(
    (start - 0.2).toFixed(4)
  );

  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    const theirs = await ledgerOf(api, recipient.username, SEED_PASSWORD, 'transfer_all');
    expect(theirs.transactions, '收款方也收到两笔，一笔都不能少').toHaveLength(2);
    expect(theirs.balance, '两笔 0.1 都要到账').toBe(0.2);
  } finally {
    await api.dispose();
  }
});

test('余额不足与转给自己：前端拦住 + 服务端 400，账目一分不动', async ({
  page,
  playwright,
}) => {
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

  // 服务端（绕开前端）：余额不足 → 400
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

  // 两笔非法请求都不该留下任何账目痕迹：发送者仍只有签到那一条，
  // 收款方则一行都没有（转账若真发生过，receipt 流水是不可能不写的）。
  const mine = await myLedger(page);
  expect(mine).toHaveLength(1);
  expect(mine[0].type).toBe('checkin');

  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    const theirs = await ledgerOf(api, recipient.username, SEED_PASSWORD);
    expect(theirs.transactions, '收款方一个字都不该多').toHaveLength(0);
    expect(theirs.balance).toBe(0);
  } finally {
    await api.dispose();
  }

  // 余额一分未动
  await page.reload();
  await expect(page.locator('.market-card__balance-number')).toHaveText(balance.toFixed(4));
});

test('收银台：商户链接 → 核对 → 输密码支付 → 返回商户；参数非法时给出明确错误', async ({
  page,
  playwright,
}) => {
  const sender = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);
  const merchant = await registerFreshUser(page); // 站外商户 / 银行账号
  await loginViaApi(page, sender.username);

  const RETURN = 'https://bank.example/paid';
  const payUrl =
    `/fish/pay?to=${merchant.username}&amount=1&note=order-1` +
    `&from=${encodeURIComponent('鱼干银行')}&return=${encodeURIComponent(RETURN)}`;

  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    await page.goto(payUrl);

    // 商户横幅必须明说「本站不验证商户身份」（商户名是链接里的自由文本）
    await expect(page.locator('.pay-merchant__name')).toContainText('鱼干银行');
    await expect(page.locator('.pay-merchant__badge')).toContainText('不验证商户身份');
    await expect(page.locator('.market-recipient__name')).toHaveText(merchant.username);
    // 展示走 fmtFish（固定 4 位小数），所以 1 渲染成 '1.0000'
    await expect(page.locator('.pay-amount__value')).toHaveText('1.0000');
    await expect(page.locator('.pay-note')).toContainText('order-1');

    // ── 没输密码：按钮禁用（step-up 不可跳过）─────────────────────────────
    await expect(page.locator('.market-submit')).toBeDisabled();

    // ── 密码错误：401 → toast 报错，钱一分不动 ─────────────────────────────
    await page.locator('#pay-password').fill('definitely-not-the-password');
    await page.locator('.market-submit').click();
    await expect(page.locator('#toast-container .toast__body')).toContainText('用户名或密码错误');
    await expect(page.locator('.pay-result')).toHaveCount(0);
    expect(await myLedger(page, 'transfer_all'), '密码错误绝不能产生转账').toHaveLength(0);
    expect(
      (await ledgerOf(api, merchant.username, SEED_PASSWORD, 'transfer_all')).transactions,
      '商户侧同样一个字都不该多'
    ).toHaveLength(0);

    // ── 正确密码：支付成功 + 商户侧到账 + 返回商户按钮 ─────────────────────
    await page.locator('#pay-password').fill(SEED_PASSWORD);
    await page.locator('.market-submit').click();

    await expect(page.locator('.pay-result__title')).toContainText('支付成功');
    await expect(page.locator('.pay-result__to')).toContainText(merchant.username);
    await expect(page.locator('.pay-result__balance')).toContainText((balance - 1).toFixed(4));
    const backLink = page.locator('.pay-result__return');
    await expect(backLink).toHaveAttribute('href', RETURN);
    await expect(backLink, '返回按钮要显示目标主机名，让人看清去哪').toContainText('bank.example');

    const out = await myLedger(page, 'transfer_all');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: -1, type: 'transfer', related_user_id: merchant.id });

    const theirs = await ledgerOf(api, merchant.username, SEED_PASSWORD, 'transfer_all');
    expect(theirs.transactions).toHaveLength(1);
    expect(theirs.transactions[0]).toMatchObject({ amount: 1, type: 'transfer_receive' });
    expect(theirs.balance, '商户侧真的到账 1 条').toBe(1);
    expect(
      theirs.transactions[0].transfer_id,
      '付款人与商户的两条流水必须同号 —— 商户就是靠它对上这笔账'
    ).toBe(out[0].transfer_id);

    // ── 参数非法：友好错误页（不是 500，也不是渲染出半个支付页）──────────
    // ⚠️ 用 5 位小数，别用 1.23 —— 后者在精度提到 0.0001 之后**已经是合法金额**了，
    // 这一页会正常渲染支付表单，于是断言「元素找不到」而不是「文案不对」，很容易误判成页面挂了。
    await page.goto('/fish/pay?to=' + merchant.username + '&amount=1.23456');
    await expect(page.locator('.pay-error__message')).toContainText('金额参数无效');
    await page.goto('/fish/pay?to=no_such_user_at_all&amount=1');
    await expect(page.locator('.pay-error__message')).toContainText('收款人不存在');
  } finally {
    await api.dispose();
  }
});

test('收银台：带 order 的链接，付完刷新再付一次**不会**重复扣款', async ({
  page,
  playwright,
}) => {
  const sender = await registerFreshUser(page, { core: true });
  await fundByCheckin(page); // 得先有鱼干才付得出去
  const merchant = await registerFreshUser(page);
  await loginViaApi(page, sender.username);

  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
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

    const first = await myLedger(page, 'transfer_all');
    expect(first, '第一次支付应当成交').toHaveLength(1);
    expect(first[0].transfer_id, '页面显示的凭据号就是流水里的单号').toBe(receipt);

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

    expect(await myLedger(page, 'transfer_all'), '★ 刷新后再付一次不能产生第二笔流水').toHaveLength(
      1
    );

    // 商户侧：只入账一次、余额只 +1，且那一笔正是凭据号那一笔。
    //（余额的真源就是本地 users.dried_fish，与付款人看到的是同一个数。）
    const theirs = await ledgerOf(api, merchant.username, SEED_PASSWORD, 'transfer_all');
    expect(theirs.transactions, '重放不得重复入账').toHaveLength(1);
    expect(theirs.transactions[0].transfer_id, '商户流水里的单号 = 付款人手里的凭据号').toBe(
      receipt
    );
    expect(theirs.balance, '商户余额是 1 不是 2').toBe(1);

    // 余额只被扣了一次：重放回报的余额与第一次支付后**一模一样**
    await expect(page.locator('.pay-result__balance')).toHaveText(balanceAfterFirst!);
  } finally {
    await api.dispose();
  }
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
    expect(json.transfer_id, '响应里的单号就是落进两条流水的那个').toBeTruthy();
    expect(JSON.stringify(json), '响应里绝不能回显密码').not.toContain(SEED_PASSWORD);

    // 账目真的落了：发送方一条转出、收款方一条转入，两条同号
    const mine = await ledgerOf(anon, sender.username, SEED_PASSWORD, 'transfer_all');
    expect(mine.transactions).toHaveLength(1);
    expect(mine.transactions[0]).toMatchObject({
      amount: -1,
      type: 'transfer',
      related_user_id: recipient.id,
    });
    expect(mine.transactions[0].transfer_id).toBe(json.transfer_id);
    expect(mine.balance).toBe(balance - 1);

    const theirs = await ledgerOf(anon, recipient.username, SEED_PASSWORD, 'transfer_all');
    expect(theirs.transactions).toHaveLength(1);
    expect(theirs.transactions[0]).toMatchObject({ amount: 1, type: 'transfer_receive' });
    expect(theirs.transactions[0].transfer_id).toBe(json.transfer_id);
    expect(theirs.balance).toBe(1);

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
      (await ledgerOf(anon, sender.username, SEED_PASSWORD, 'transfer_all')).transactions,
      '凭据错误不能产生第二笔'
    ).toHaveLength(1);
  } finally {
    await anon.dispose();
  }
});
