// 画报 / 收款码 + 扫码收款页（/fish/collect）—— 端到端。
//
// 【为什么必须有 e2e】单测能在 Node 里把 SVG 渲染成 PNG 再解码（tests/unit/poster.test.ts），
// 但证明不了「浏览器里点得到入口、弹窗里真出图、下载真拿到文件、付款真走通」。
// 这条链路横跨 RSC → route handler → sharp → <img>/<a download>，任何一段断掉，
// 单测都是绿的。
//
// 【为什么这几条不用新号】画报生成是**只读**（不写库、不消耗鱼干），唯一按用户计的
// 配额是 RULES.posterMinute（30/分），种子号完全够用。只有真正花钱的那条（扫码付款）
// 用一次性新号 —— 理由见 helpers.registerFreshUser 的注释。

import { test, expect, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

const BASE_URL = 'http://127.0.0.1:3100';

/** 新号 + 签到翻牌拿鱼（与 fish-market.spec 同一手法：e2e 里唯一不绕开业务的造鱼方式）。 */
async function fundByCheckin(page: Page): Promise<number> {
  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);
  const claim = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status()).toBe(200);
  const balance = Number((await claim.json()).dried_fish);
  expect(balance).toBeGreaterThanOrEqual(1);
  return balance;
}

/** 弹窗里的预览 <img>：它加载完才会 display:block，所以「可见」就等于「已经出图」。 */
async function expectPosterRendered(page: Page) {
  const modal = page.locator('.poster-modal');
  await expect(modal).toBeVisible();
  const img = modal.locator('.poster-frame__img');
  await expect(img).toBeVisible();
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth, '图必须真渲染出来（破图 naturalWidth 为 0）').toBeGreaterThan(0);
  return modal;
}

test('个人主页画报：本人能生成、能下载；别人的主页没有入口', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.owner.username);
  await page.goto(`/u/${SEED_USERS.owner.id}`);

  const trigger = page.getByRole('button', { name: '生成画报' });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const modal = await expectPosterRendered(page);

  // 下载：同源 <a download>，文件名由前端指定
  const waiting = page.waitForEvent('download');
  await modal.getByRole('link', { name: '下载 PNG' }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toContain(SEED_USERS.owner.username);
  expect(download.suggestedFilename()).toMatch(/\.png$/);

  // Esc 关掉（弹窗是条件渲染，关了就该从 DOM 里消失）
  await page.keyboard.press('Escape');
  await expect(page.locator('.poster-modal')).toHaveCount(0);

  // 别人主页没有这个入口 —— 生成只对自己开放
  await page.goto(`/u/${SEED_USERS.core.id}`);
  await expect(page.locator('.profile-hero__username')).toHaveText(SEED_USERS.core.username);
  await expect(page.getByRole('button', { name: '生成画报' })).toHaveCount(0);
});

test('鱼干收款码：从 /fish 生成并预览', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.owner.username);
  await page.goto('/fish');

  await page.getByRole('button', { name: '收款码' }).click();
  await expectPosterRendered(page);
});

test('画报接口的权限：只能给自己生成；未登录一律 401', async ({ page, browser }) => {
  await loginViaApi(page, SEED_USERS.owner.username);

  // 给自己：200 + PNG
  const mine = await page.request.get(`/api/poster/profile/${SEED_USERS.owner.id}`);
  expect(mine.status()).toBe(200);
  expect(mine.headers()['content-type']).toBe('image/png');

  // 给别人：403（画报入口本来就只在本人主页）
  const other = await page.request.get(`/api/poster/profile/${SEED_USERS.core.id}`);
  expect(other.status()).toBe(403);

  // 未登录：两个路由都 401
  const ctx = await browser.newContext();
  try {
    const anon = ctx.request;
    expect((await anon.get(`${BASE_URL}/api/poster/collect`)).status()).toBe(401);
    expect(
      (await anon.get(`${BASE_URL}/api/poster/profile/${SEED_USERS.owner.id}`)).status()
    ).toBe(401);
  } finally {
    await ctx.close();
  }
});

test('扫码收款页：金额由付款人自己填，密码确认后到账', async ({ page }) => {
  const payer = await registerFreshUser(page, { core: true });
  const balance = await fundByCheckin(page);

  await page.goto(`/fish/collect?to=${SEED_USERS.core.username}`);

  // 收款人是库里的真实用户（URL 参数不可信，展示的是查出来的那个）
  await expect(page.locator('.market-recipient__name')).toHaveText(SEED_USERS.core.username);
  // 与收银台的区别：没有商户横幅（这不是站外商户发起的）
  await expect(page.locator('.pay-merchant')).toHaveCount(0);

  // 快捷金额
  await page.locator('.pay-quick__btn').filter({ hasText: /^1$/ }).click();
  await expect(page.locator('#pay-amount')).toHaveValue('1');

  // 超余额 → 就地报错并禁用提交
  await page.locator('#pay-amount').fill('9999');
  await expect(page.locator('.pay-amount__error')).toContainText('小鱼干不足');
  await expect(page.locator('.market-submit')).toBeDisabled();

  // 金额合法但没输密码 → 仍然禁用（step-up 不可跳过）
  await page.locator('#pay-amount').fill('1');
  await expect(page.locator('.market-submit')).toBeDisabled();

  await page.locator('#pay-password').fill(SEED_PASSWORD);
  await page.locator('.market-submit').click();

  await expect(page.locator('.pay-result__title')).toContainText('付款成功');
  await expect(page.locator('.pay-result__to')).toContainText(SEED_USERS.core.username);
  await expect(page.locator('.pay-result__balance')).toContainText(String(balance - 1));

  expect(payer.username).toContain('e2e_'); // 用了新号，别把这条静默换成种子号
});

test('扫码收款页：自己扫自己 / 收款人不存在 / 缺参数，都是友好错误页', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.owner.username);

  await page.goto(`/fish/collect?to=${SEED_USERS.owner.username}`);
  await expect(page.locator('.pay-error__message')).toContainText('自己的收款码');

  await page.goto('/fish/collect?to=no_such_user_at_all');
  await expect(page.locator('.pay-error__message')).toContainText('收款人不存在');

  await page.goto('/fish/collect');
  await expect(page.locator('.pay-error__message')).toContainText('缺少收款人');
});

test('扫码收款页：未登录时跳本站登录页，登录后回到收款页', async ({ browser }) => {
  const ctx = await browser.newContext();
  const anonPage = await ctx.newPage();
  try {
    await anonPage.goto(`/fish/collect?to=${SEED_USERS.core.username}`);

    await expect(anonPage).toHaveURL(/\/login\?next=/);
    const next = new URL(anonPage.url()).searchParams.get('next') ?? '';
    expect(next, 'next 必须指回收款页并带上收款人').toContain('/fish/collect?to=');
    expect(next).toContain(SEED_USERS.core.username);
  } finally {
    await ctx.close();
  }
});
