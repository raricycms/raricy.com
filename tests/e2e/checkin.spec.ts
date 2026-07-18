// 每日签到：首次成功、同日重复被拒。
//
// 【为什么每个用例都新注册一个用户】签到的唯一约束是 (userId, checkinDate)，一天只能签一次，
// 没有「撤销签到」的入口。用固定的种子用户，第二个用例（以及 mobile project 重跑同一批用例时）
// 必然撞上「今天已签到」——那种失败看起来像被测代码坏了，实为用例之间抢同一行数据。
//
// 【为什么要断言远端记账】签到走 Phase 1.5 的 fail-closed：本地事务提交**之前**先向账户
// 微服务 transfer，远端失败就整体回滚。单测里客户端是 mock 掉的，证明不了「真发了 HTTP」。
// 这里查账户服务替身收到的转账记录，把这条跨进程的链路真正焊死。

import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

const ACCOUNT_MOCK = 'http://127.0.0.1:3101';

/** UTC+8 当天 YYYY-MM-DD —— 必须与 checkin-service.todayUtc8() 同一把尺子。
 *  用 new Date().toISOString() 会得到真实 UTC 日期，UTC+8 的 00:00–07:59 期间
 *  两者差一天，幂等键断言会莫名其妙地挂。见 src/lib/db-time.ts。 */
function todayUtc8(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

test('首次签到成功并同步到账户服务，同日再签返回「已签到」', async ({ page, request }) => {
  const user = await registerFreshUser(page);

  // ── 首次签到（走真实 UI）────────────────────────────────────────────────
  await page.goto('/checkin');
  const btn = page.locator('.checkin-button');
  await expect(btn).toHaveText('每日签到');
  await expect(btn).toBeEnabled();

  await btn.click();

  await expect(page.locator('#toast-container .toast__body')).toContainText('签到成功');
  // 按钮进入已签到态并锁死（防重复提交的第一道闸）
  await expect(btn).toHaveText('今日已签到', { timeout: 10_000 });
  await expect(btn).toBeDisabled();

  // 此处**不**断言「累计签到天数」变成 1：那个数字来自服务端组件的 props，
  // 只有关掉运势卡触发 router.refresh() 后才会重取（见 CheckinCard.closeModal）。
  // 签到成功的当下它仍是 0 —— 这是设计，不是 bug。落库与否留到下面刷新后验。

  // ── 远端确实记了账（fail-closed 的另一半）──────────────────────────────
  const transfers = (await (await request.get(`${ACCOUNT_MOCK}/__e2e__/transfers`)).json())
    .transfers as Array<{
    to_user_id: string;
    entry_type: string;
    amount: number;
    idempotency_key: string | null;
  }>;
  const mine = transfers.filter((t) => t.to_user_id === user.id && t.entry_type === 'checkin');
  expect(mine).toHaveLength(1);
  // 运势值 1-5，鱼干发放量与之相等
  expect(mine[0].amount).toBeGreaterThanOrEqual(1);
  expect(mine[0].amount).toBeLessThanOrEqual(5);
  // 幂等键必须带上日期：漏了日期，用户第二天签到会被账户服务当成重放而静默吞掉
  expect(mine[0].idempotency_key).toBe(`checkin-${user.id}-${todayUtc8()}`);

  // ── 同日重复签到 ────────────────────────────────────────────────────────
  const res = await page.request.post('/api/checkin', { data: {} });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.already_checked).toBe(true);
  expect(body.message).toContain('今天已签到');
  expect(body.total_count).toBe(1); // 没有被重复记成 2 天

  // 重复签到不得触发第二次远端转账（否则就是白发鱼干）
  const after = (await (await request.get(`${ACCOUNT_MOCK}/__e2e__/transfers`)).json())
    .transfers as Array<{ to_user_id: string; entry_type: string }>;
  expect(after.filter((t) => t.to_user_id === user.id && t.entry_type === 'checkin')).toHaveLength(
    1
  );

  // 刷新后仍是已签到态（服务端状态，不是前端的临时 state）
  await page.goto('/checkin');
  await expect(page.locator('.checkin-button')).toHaveText('今日已签到');
  await expect(page.locator('.checkin-button')).toBeDisabled();
  // 累计签到天数落库为 1（重新渲染取的是服务端真值）
  await expect(page.locator('.checkin-stats__item').first()).toContainText('1');
});

test('未登录调用签到接口返回 401', async ({ request }) => {
  const res = await request.post('/api/checkin', { data: {} });
  expect(res.status()).toBe(401);
  expect((await res.json()).message).toContain('请先登录');
});

test('签到时传越界的 chosenIndex 被拒（不静默改成随机牌）', async ({ page }) => {
  await registerFreshUser(page);
  const res = await page.request.post('/api/checkin', { data: { chosenIndex: 99 } });
  expect(res.status()).toBe(400);
  expect((await res.json()).message).toContain('无效的选择');
});
