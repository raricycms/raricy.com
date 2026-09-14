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

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerFreshUser, loginViaApi } from './helpers';

const ACCOUNT_MOCK = 'http://127.0.0.1:3101';

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
  const sender = await registerFreshUser(page);
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
  const sender = await registerFreshUser(page);
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
  const sender = await registerFreshUser(page);
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
