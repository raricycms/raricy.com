// 每日签到（一步式）：点一次 → 建当日记录 + 发固定 3 条鱼干 + 写流水，同一个事务。
//
// 【档位：core+】签到是鱼干的赚取渠道，与投喂、点赞同档（普通账号不该有自助领鱼干
// 的口子）。因此下面每条正向用例都用 `registerFreshUser(page, { core: true })` 造号 ——
// 新注册默认是 role=user，不提权连签到按钮都点不动。反向用例见文件末尾。
//
// 【为什么每个用例都新注册一个用户】签到的唯一约束是 (userId, checkinDate)，一天只能签一次，
// 没有「撤销签到」的入口。用固定的种子用户，第二个用例（以及 mobile project 重跑同一批用例时）
// 必然撞上「今天已签到」——那种失败看起来像被测代码坏了，实为用例之间抢同一行数据。
//
// 【为什么断言本站账目】签到是**发鱼点**：建记录、发鱼干、写流水在**同一个 SQLite 事务**
// 里提交（见 src/lib/checkin-service.ts 头部）—— 要么全生效、要么全不生效。所以
// 「签到真的发了鱼」在本站是可以直接读回来的事实：余额多了 3 条、流水里多了一条 checkin。
// 服务层用例断言的是服务层返回值，看不见「接口这一层有没有接对」，这里补上。

import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser, publishBlog } from './helpers';

/** 签到固定发多少条（与 src/lib/checkin-service.ts 的 CHECKIN_REWARD_FISH 同值）。 */
const REWARD = 3;

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

/** 当前会话用户的流水。type='checkin' 只取签到那一条。 */
async function myLedger(page: Page, type?: string): Promise<LedgerRow[]> {
  const res = await page.request.get(
    `/api/fish/transactions${type ? `?type=${encodeURIComponent(type)}` : ''}`
  );
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).transactions ?? []) as LedgerRow[];
}

/** 当前会话用户的余额（鱼干）。真源就是本地 users.dried_fish。 */
async function myBalance(page: Page): Promise<number> {
  const res = await page.request.get('/api/fish/balance');
  expect(res.status(), await res.text()).toBe(200);
  return Number((await res.json()).balance);
}

test('点击签到 → 固定 +3 条鱼干；同日再签被拒且不再发鱼', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  await publishBlog(page); // 签到的前置条件：名下至少一篇未软删的文章

  await page.goto('/checkin');
  const btn = page.locator('.checkin-button');
  await expect(btn).toHaveText('每日签到');
  await expect(btn).toBeEnabled();
  // 未签到时给的是「每天能领多少」的静态提示（数字来自服务端常量）
  await expect(page.locator('.checkin-reward-hint')).toContainText(String(REWARD));

  await btn.click();

  await expect(page.locator('#toast-container .toast__body')).toContainText('签到成功');
  // 按钮进入已签到态并锁死（防重复提交的第一道闸）
  await expect(btn).toHaveText('今日已签到', { timeout: 10_000 });
  await expect(btn).toBeDisabled();

  // ── 鱼真的发了：余额 + 流水（同一个事务的两面）───────────────────────────
  const mine = await myLedger(page, 'checkin');
  expect(mine).toHaveLength(1);
  expect(mine[0].type).toBe('checkin');
  expect(mine[0].amount, '签到奖励是固定的这一档，不再是随机值').toBe(REWARD);
  expect(mine[0].description, '流水里要写清这一笔是哪来的').toContain('签到');
  expect(await myBalance(page), '余额真的多了这一笔').toBe(REWARD);

  // 卡片上显示的是服务端真值（读流水给的那一个）
  await expect(page.locator('.checkin-today-reward')).toContainText(`+${REWARD}`);
  // 累计签到天数落库为 1
  await expect(page.locator('.checkin-stats__item').first()).toContainText('1');

  // ── 同日重复签到 ────────────────────────────────────────────────────────
  const res = await page.request.post('/api/checkin', { data: {} });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.already_checked).toBe(true);
  expect(body.message).toContain('今天已签到');
  expect(body.total_count).toBe(1); // 没有被重复记成 2 天
  expect(body.today_fish).toBe(REWARD); // 今天到手的仍是那 3 条，不是 6 条

  // 重复签到不得发第二次鱼：账里还是那一条，余额一分不涨
  expect(await myLedger(page, 'checkin')).toHaveLength(1);
  expect(await myBalance(page)).toBe(REWARD);

  // 刷新后仍是已签到态（服务端状态，不是前端的临时 state）
  await page.goto('/checkin');
  await expect(btn).toHaveText('今日已签到');
  await expect(btn).toBeDisabled();
  await expect(page.locator('.checkin-today-reward')).toContainText(String(REWARD));
});

test('状态接口的形状：签到前后各一次（机器人按它决定要不要签）', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  await publishBlog(page); // 同上：得先跨过内容前置条件

  const before = await page.request.get('/api/checkin');
  expect(before.status()).toBe(200);
  expect(await before.json()).toMatchObject({
    checked_in: false,
    can_check_in: true, // 有文章 → 够格签
    total_count: 0,
    today_fish: 0,
    dried_fish: 0,
    reward_fish: REWARD,
  });

  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);

  const after = await page.request.get('/api/checkin');
  expect(await after.json()).toMatchObject({
    checked_in: true,
    can_check_in: true,
    total_count: 1,
    today_fish: REWARD,
    dried_fish: REWARD,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 内容前置条件：没发过文章不能签到（2026-10）
//
// 【为什么要有】它是抬高批量空号成本的那道门（见 checkin-service.ts 头部）。三条边界
// 只有真发 HTTP 才验得到：状态接口**不拒**（回 can_check_in:false，不 403 —— 否则
// base.js 会点亮假徽标）、写接口**拒**、页面给引导态而不是一个点了必 403 的按钮。
// ─────────────────────────────────────────────────────────────────────────────
test('没发过文章：状态接口回 can_check_in=false（不 403），写接口 403，页面给引导', async ({ page }) => {
  await registerFreshUser(page, { core: true }); // 有 core 但一篇文章都没有

  const st = await page.request.get('/api/checkin');
  expect(st.status(), '状态读不该拒 —— 拒了 base.js 会点亮假徽标').toBe(200);
  expect(await st.json()).toMatchObject({ checked_in: false, can_check_in: false });

  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status(), '写接口必须挡死').toBe(403);
  const body = await ci.json();
  expect(body.message).toContain('发布过文章');
  expect(body.can_check_in).toBe(false);

  // 一分鱼干都没发
  expect(await myLedger(page, 'checkin')).toHaveLength(0);
  expect(await myBalance(page)).toBe(0);

  // 页面给的是引导态（没有签到按钮），引导链落在博客目录、且搜索框预填「自我介绍」
  await page.goto('/checkin');
  await expect(page.locator('.checkin-button')).toHaveCount(0);
  await page.locator('a[href*="/blog?search="]').click();
  await expect(page.locator('.search-input')).toHaveValue('自我介绍');
});

test('★ 发过又全部删除 = 没发过：文章软删后回到不能签', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await publishBlog(page);

  // 有文章时够格签
  expect((await (await page.request.get('/api/checkin')).json()).can_check_in).toBe(true);

  // 删掉那篇（走真实的删除接口，而不是直连库改 ignore）
  const del = await page.request.delete(`/api/blogs/${blogId}`);
  expect(del.status(), `删文失败：${await del.text()}`).toBe(200);

  // 名下已无未删文章 → 又不能签了
  expect((await (await page.request.get('/api/checkin')).json()).can_check_in).toBe(false);
  expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(403);
});

test('未登录调用签到接口返回 401', async ({ request }) => {
  const ci = await request.post('/api/checkin', { data: {} });
  expect(ci.status()).toBe(401);
  expect((await ci.json()).message).toContain('请先登录');

  const st = await request.get('/api/checkin');
  expect(st.status()).toBe(401);
});

// ─────────────────────────────────────────────────────────────────────────────
// core+ 门槛
//
// 【为什么签到是 core+】鱼干是 core+ 体系的报酬：赚取渠道（签到、投喂分成）全在
// core 门槛之后。放开签到 = 给未认证账号一条自助领鱼干的路，而它拿到鱼干也没有出口。
// 这条与 `access-control.spec` 的接口矩阵是同一个契约 —— 而签到**一整个接口就在发钱**
// （没有第二步了），所以两个方法都得单独钉一遍。
// ─────────────────────────────────────────────────────────────────────────────
test('凡 core+ 门槛：role=user 签到与状态接口都 403，且一分鱼干都不发', async ({ page }) => {
  const user = await registerFreshUser(page); // 默认就是 role=user
  expect(user.id).toBeTruthy();

  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status(), 'role=user 不该能签到').toBe(403);
  expect((await ci.json()).message).toContain('核心用户');

  // 状态接口同样挡掉：base.js 靠它决定点不点亮签到徽标
  const status = await page.request.get('/api/checkin');
  expect(status.status()).toBe(403);

  // 账目侧的自证：读自己的账不需要 core（账是自己的），而它必须一条不剩地空着 ——
  // 那条被 403 的写路径若漏网，这里就会看见钱。
  expect(await myLedger(page, 'checkin'), '被 403 的路径绝不能发鱼').toHaveLength(0);
  expect(await myBalance(page)).toBe(0);

  // 入口仍在（与讨论、博客同一种待遇），但点进去是 403
  const pageRes = await page.goto('/checkin');
  expect(pageRes?.status()).toBe(403);
  await expect(page.locator('.rainbow-error__code')).toHaveText('403');
});
