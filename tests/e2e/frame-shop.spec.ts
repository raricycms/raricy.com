// 鱼干商城（/fish/market 的第二块）—— 用鱼干租头像框的端到端链路。
//
// 【为什么必须有 e2e】服务层的用例（tests/service/frame-shop-service.test.ts）能证明
// 「扣钱与发框在同一个事务里」，但证明不了**用户在页面上点这几下**真的走通了：
// 选天数 → 二次确认 → 钱扣了 → 持有行建了 → 那个框出现在 /settings 的清单里能戴上。
// 这几段各自都有静默失败的可能（比如资产目录在 e2e 环境里是另一份，
// 见 tests/e2e/global-setup.ts 的 FRAMES_DIR 隔离），只有真跑一遍才看得见。
//
// 【为什么用签到给新号发鱼】与 fish-market.spec.ts 同一条理由：新号余额为 0，
// 而签到翻牌是 e2e 里唯一不绕开业务的造鱼方式。运势 1–5 随机，所以断言只用相对变化，
// 不写死数值。
//
// 【别名对照表在哪里】这一条**不进** playwright.config.ts 的 RESPONSIVE_SPECS ——
// 它全是 DOM 断言，没有视口分支（与 fish-market.spec.ts 同款）。

import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

/** 在售的那款框。改 `frame-refs.ts` 的定价/在架清单时这里跟着改。 */
const KEY = 'fishblue';
const LABEL = '鱼干蓝';

/** 新号 + 签到翻牌拿鱼，返回到账后的余额（鱼干，1–5）。 */
async function fundByCheckin(page: import('@playwright/test').Page): Promise<number> {
  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);
  const claim = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status()).toBe(200);
  const balance = Number((await claim.json()).dried_fish);
  expect(balance).toBeGreaterThanOrEqual(1);
  return balance;
}

test('租用全链路：商城 → 选天数 → 二次确认 → 扣款 + 那个框真的能戴', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);

  await page.goto('/fish/market');
  await expect(page.locator('.market-shop__title')).toContainText('鱼干商城');
  await expect(page.locator('.market-shop__name')).toHaveText(LABEL);
  await expect(page.locator('.market-shop__price')).toContainText('1');
  // 素材在盘上（global-setup 为每个 SEED_FRAME_KEYS 铺了占位图）——
  // 缺图时这里会变成那句「暂时买不了」，而那正是另一条用例要覆盖的分支
  await expect(page.locator('.market-shop__submit')).toBeEnabled();

  // ── 选 1 天 → 二次确认 ──────────────────────────────────────────────────
  await page.locator('#market-shop-days').fill('1');
  // ⚠️ 用 `.market-shop__summary` 而**不是** `.market-summary` —— 转账面板的摘要条
  // 也在这一页，裸选择器会解析到两个元素（这条断言当初就是这么写的，然后当场红）。
  await expect(page.locator('.market-shop__summary')).toContainText('合计');
  await page.locator('.market-shop__submit').click();

  const confirm = page.locator('#market-shop-confirm');
  await expect(confirm, '租用必须先过二次确认弹窗').toBeVisible();
  await expect(confirm).toContainText(LABEL);
  await expect(confirm).toContainText('1 天');
  await confirm.locator('.market-confirm__ok').click();

  // 成功才会关弹窗并复位天数（失败时弹窗按设计保留，好让用户原样重试）
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('#market-shop-days')).toHaveValue('1');
  // 一条 toast 里既有结论也有到期时刻（服务端算好的那个，不是前端推的）
  const toast = page.locator('#toast-container .toast__body').last();
  await expect(toast).toContainText('已租用');
  await expect(toast).toContainText('到期');

  // ── 余额真的扣了，且页面上多出「当前持有到 …」那一行 ────────────────────
  const bal = await page.request.get('/api/fish/balance');
  expect(bal.status()).toBe(200);
  expect(Number((await bal.json()).balance)).toBeCloseTo(balance - 1, 4);
  await expect(page.locator('.market-shop__owned')).toContainText('当前持有到');

  // ── 账上是一条 frame_rent，带着框的 key ─────────────────────────────────
  const tx = await page.request.get('/api/fish/transactions?type=frame_rent');
  expect(tx.status()).toBe(200);
  const rows = (await tx.json()).transactions as {
    amount: number;
    type: string;
    reference_type: string | null;
    reference_id: string | null;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    amount: -1,
    type: 'frame_rent',
    reference_type: 'frame',
    reference_id: KEY,
  });

  // ── ★ 那个框真的进了 /settings 的清单，而且戴得上 ──────────────────────
  // 这一段是「整条链真的通了」的终点：持有行建了、到期判定过了、素材在盘上，
  // 三者缺一都会让「戴上」失败或者戴上了看不见。
  await page.goto('/settings#avatar-frame');
  const card = page.locator('.frame-panel__grid li', { hasText: LABEL });
  await expect(card).toHaveCount(1);
  await card.locator('button', { hasText: '戴上' }).click();

  // 戴上之后顶栏头像该有框了 —— 断言那张 <img> 真的挂了上去
  await expect(page.locator('.site-user-avatar .avatar__frame')).toHaveAttribute(
    'src',
    `/api/frames/${KEY}`
  );
});

test('新号余额为 0：按钮灰着，服务端也不放行（不留半张框）', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  // 不签到 —— 余额 0

  await page.goto('/fish/market');
  await expect(page.locator('.market-shop__submit')).toBeDisabled();
  await expect(page.locator('.market-shop__error')).toContainText('小鱼干不足');

  // 绕过界面直接打接口：服务端必须自己挡住，而不是指望前端那个 disabled
  const res = await page.request.post('/api/fish/market/rent', {
    data: { frame_key: KEY, days: 1 },
  });
  expect(res.status()).toBe(400);
  expect(String((await res.json()).message)).toContain('小鱼干不足');

  // 真的什么都没留下
  const tx = await page.request.get('/api/fish/transactions?type=frame_rent');
  expect(((await tx.json()).transactions as unknown[]).length).toBe(0);
  await page.goto('/settings#avatar-frame');
  await expect(page.locator('.frame-panel__grid li', { hasText: LABEL })).toHaveCount(0);
});
