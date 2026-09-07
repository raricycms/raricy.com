// 每日签到（两步式）：签到建记录 → 弹卡 → 翻牌定命 → 远端记账。
//
// 【两步语义】签到（POST /api/checkin）只建记录：fortune_value=NULL、牌池洗好落库，
// 不发鱼、不碰远端。翻牌（POST /api/checkin/claim，用户点选位置 0-4）才从落库牌池
// 取 pool[chosenIndex] 赋值并发鱼 + 远端同步 —— 翻哪张拿哪个值，由翻牌的选择决定。
// 因此「签到即转账」的旧断言全部改为「翻牌才转账」。
//
// 【为什么每个用例都新注册一个用户】签到的唯一约束是 (userId, checkinDate)，一天只能签一次，
// 没有「撤销签到」的入口。用固定的种子用户，第二个用例（以及 mobile project 重跑同一批用例时）
// 必然撞上「今天已签到」——那种失败看起来像被测代码坏了，实为用例之间抢同一行数据。
//
// 【为什么要断言远端记账】签到翻牌走 fail-closed：本地事务先提交（账本登记 pending），
// 再向账户微服务 transfer，远端失败就补偿复原（fortune_value 回 NULL）。单测里客户端是
// mock 掉的，证明不了「真发了 HTTP」。这里查账户服务替身收到的转账记录，把这条跨进程的
// 链路真正焊死 —— 且必须断言**翻牌后才有**转账（签到本身没有）。

import { test, expect, type APIRequestContext } from '@playwright/test';
import { registerFreshUser } from './helpers';

const ACCOUNT_MOCK = 'http://127.0.0.1:3101';

/** UTC+8 当天 YYYY-MM-DD —— 必须与 checkin-service.todayUtc8() 同一把尺子。
 *  用 new Date().toISOString() 会得到真实 UTC 日期，UTC+8 的 00:00–07:59 期间
 *  两者差一天，幂等键断言会莫名其妙地挂。见 src/lib/db-time.ts。 */
function todayUtc8(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 账户服务替身收到的本用户 checkin 转账。 */
async function checkinTransfers(request: APIRequestContext, userId: string) {
  const res = await request.get(`${ACCOUNT_MOCK}/__e2e__/transfers`);
  const body = (await res.json()) as {
    transfers: Array<{
      to_user_id: string;
      entry_type: string;
      amount: number;
      idempotency_key: string | null;
    }>;
  };
  return body.transfers.filter((t) => t.to_user_id === userId && t.entry_type === 'checkin');
}

test('首次签到 → 弹卡翻牌 → 运势落定并同步账户服务；同日再签被拒', async ({ page, request }) => {
  const user = await registerFreshUser(page);

  // ── 第一步：签到（走真实 UI）────────────────────────────────────────────
  await page.goto('/checkin');
  const btn = page.locator('.checkin-button');
  await expect(btn).toHaveText('每日签到');
  await expect(btn).toBeEnabled();

  await btn.click();

  await expect(page.locator('#toast-container .toast__body')).toContainText('签到成功');
  // 按钮进入已签到态并锁死（防重复提交的第一道闸）
  await expect(btn).toHaveText('今日已签到', { timeout: 10_000 });
  await expect(btn).toBeDisabled();

  // 签到此刻**不**该有任何转账 —— 鱼在翻牌那刻才发
  expect(await checkinTransfers(request, user.id), '签到只是建记录，不能触发远端转账').toHaveLength(0);

  // ── 第二步：弹卡翻牌（运势此刻才定）──────────────────────────────────────
  // 签到成功约 1.3s 后自动弹出运势卡
  const modal = page.locator('.fortune-modal--open');
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal.locator('.fortune-modal__header h3')).toContainText('签到成功！');
  await expect(modal.locator('.fortune-card')).toHaveCount(5);

  // 点第 1 张牌 → 约 1.5s 后出结果区
  await modal.locator('.fortune-card').first().click();
  const result = modal.locator('.fortune-modal__result');
  await expect(result).toBeVisible({ timeout: 10_000 });
  const value = Number((await result.locator('.fortune-modal__result-value').textContent())?.trim());
  expect(value).toBeGreaterThanOrEqual(1);
  expect(value).toBeLessThanOrEqual(5);
  // 五张牌全部揭示（迷你池）
  await expect(modal.locator('.fortune-mini-card')).toHaveCount(5);

  // ── 远端确实记了账（fail-closed 的另一半）───────────────────────────────
  await modal.locator('.fortune-modal__close-btn').click();
  await expect(modal).not.toBeVisible();

  const mine = await checkinTransfers(request, user.id);
  expect(mine).toHaveLength(1);
  // 运势值 1-5，鱼干发放量与之相等（= 结果区显示的那个值）
  expect(mine[0].amount).toBe(value);
  // 幂等键必须带上日期：漏了日期，用户第二天签到会被账户服务当成重放而静默吞掉
  expect(mine[0].idempotency_key).toBe(`checkin-${user.id}-${todayUtc8()}`);

  // ── 同日重复签到 ────────────────────────────────────────────────────────
  const res = await page.request.post('/api/checkin', { data: {} });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.already_checked).toBe(true);
  expect(body.fortune_pending).toBe(false); // 已翻过牌
  expect(body.message).toContain('今天已签到');
  expect(body.total_count).toBe(1); // 没有被重复记成 2 天

  // 重复签到不得触发第二次远端转账（否则就是白发鱼干）
  expect(await checkinTransfers(request, user.id)).toHaveLength(1);

  // 刷新后仍是已签到态（服务端状态，不是前端的临时 state）
  await page.goto('/checkin');
  await expect(btn).toHaveText('今日已签到');
  await expect(btn).toBeDisabled();
  // 今日运势已显示翻出的值（服务端真值）
  await expect(page.locator('.checkin-today-fortune')).toContainText(String(value));
  // 累计签到天数落库为 1
  await expect(page.locator('.checkin-stats__item').first()).toContainText('1');
});

test('恢复态：只签到不翻牌 → 刷新后自动弹「继续完成签到」→ 选牌补翻', async ({ page, request }) => {
  const user = await registerFreshUser(page);

  // ── 只签到、不翻牌（模拟签到后关掉页面/请求中断）────────────────────────
  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status()).toBe(200);
  expect(await checkinTransfers(request, user.id), '未翻牌绝不能发鱼').toHaveLength(0);

  // 状态接口必须暴露 fortune_pending（前端据此在页面加载时自动弹恢复态卡）
  const st = await page.request.get('/api/checkin');
  expect(st.status()).toBe(200);
  const status = await st.json();
  expect(status.checked_in).toBe(true);
  expect(status.fortune_pending).toBe(true);
  expect(status.fortune_value).toBeNull();

  // ── 进页面 → 约 400ms 后自动弹出恢复态运势卡 ────────────────────────────
  await page.goto('/checkin');
  const modal = page.locator('.fortune-modal--open');
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal.locator('.fortune-modal__header h3')).toContainText('继续完成签到');

  // 选第 3 张牌补翻
  await modal.locator('.fortune-card').nth(2).click();
  const result = modal.locator('.fortune-modal__result');
  await expect(result).toBeVisible({ timeout: 10_000 });
  const value = Number((await result.locator('.fortune-modal__result-value').textContent())?.trim());
  await modal.locator('.fortune-modal__close-btn').click();
  await expect(modal).not.toBeVisible();

  // 翻牌后才触发这一次转账
  const mine = await checkinTransfers(request, user.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].amount).toBe(value);
  expect(mine[0].idempotency_key).toBe(`checkin-${user.id}-${todayUtc8()}`);

  // 刷新：pending 消失、运势落定、不再自动弹卡
  await page.goto('/checkin');
  await expect(page.locator('.fortune-modal--open')).toHaveCount(0);
  await expect(page.locator('.checkin-today-fortune')).toContainText(String(value));
});

test('claim 校验：越界/缺 index/非法 index 被拒，且不落值不发鱼', async ({ page, request }) => {
  const user = await registerFreshUser(page);

  // 先签到，进入待翻牌态
  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status()).toBe(200);

  // 越界
  const oob = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 99 } });
  expect(oob.status()).toBe(400);
  expect((await oob.json()).message).toContain('无效的选择');

  // 缺 index
  const missing = await page.request.post('/api/checkin/claim', { data: {} });
  expect(missing.status()).toBe(400);
  expect((await missing.json()).message).toContain('请选择一个卡牌');

  // 非整数（字符串乱码 / 小数不能静默取整 —— 翻牌只能一次）
  const garbage = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 'abc' } });
  expect(garbage.status()).toBe(400);
  const floaty = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 1.5 } });
  expect(floaty.status()).toBe(400);

  // 以上全部被拒后：仍是待翻牌态（值未落、无转账、无流水痕迹可查）
  const st = await page.request.get('/api/checkin');
  const status = await st.json();
  expect(status.fortune_pending).toBe(true);
  expect(status.fortune_value).toBeNull();
  expect(await checkinTransfers(request, user.id), '被拒的 claim 绝不能发鱼').toHaveLength(0);
});

test('未签到就翻牌 → 「今天还没有签到」', async ({ page }) => {
  await registerFreshUser(page);
  const res = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(res.status()).toBe(400);
  expect((await res.json()).message).toContain('今天还没有签到');
});

test('未登录调用签到/翻牌接口返回 401', async ({ request }) => {
  const ci = await request.post('/api/checkin', { data: {} });
  expect(ci.status()).toBe(401);
  expect((await ci.json()).message).toContain('请先登录');

  const claim = await request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status()).toBe(401);
});
