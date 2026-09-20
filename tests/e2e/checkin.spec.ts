// 每日签到（两步式）：签到建记录 → 弹卡 → 翻牌定命 → 发鱼干并记账。
//
// 【档位：core+】签到是鱼干的赚取渠道，与投喂、点赞同档（普通账号不该有自助领鱼干
// 的口子）。因此下面每条正向用例都用 `registerFreshUser(page, { core: true })` 造号 ——
// 新注册默认是 role=user，不提权连签到按钮都点不动。反向用例见文件末尾。
//
// 【两步语义】签到（POST /api/checkin）只建记录：fortune_value=NULL、牌池洗好落库，
// 不发鱼、不动余额。翻牌（POST /api/checkin/claim，用户点选位置 0-4）才从落库牌池
// 取 pool[chosenIndex] 赋值并发鱼 —— 翻哪张拿哪个值，由翻牌的选择决定。
// 因此「签到即发鱼」的旧断言全部改为「翻牌才发鱼」。
//
// 【为什么每个用例都新注册一个用户】签到的唯一约束是 (userId, checkinDate)，一天只能签一次，
// 没有「撤销签到」的入口。用固定的种子用户，第二个用例（以及 mobile project 重跑同一批用例时）
// 必然撞上「今天已签到」——那种失败看起来像被测代码坏了，实为用例之间抢同一行数据。
//
// 【为什么断言本站账目】翻牌是**唯一发鱼点**：置 fortune_value、累加 totalFortune、
// 发鱼干、写一条 checkin 流水，四件事在**同一个 SQLite 事务**里提交（见
// src/lib/checkin-service.ts 头部）—— 要么全生效、要么全不生效。所以「翻牌真的发了鱼」
// 在本站是可以直接读回来的事实：余额多了那个值、流水里多了一条 checkin。
// 单测在服务层里断言服务层的返回值，看不见「两步之间余额有没有被提前动过」——
// 那正是这里要钉的：签到那一步余额与流水必须纹丝不动，翻牌才动，且只能动一次。

import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

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

test('首次签到 → 弹卡翻牌 → 运势落定并发鱼；同日再签被拒', async ({ page }) => {
  await registerFreshUser(page, { core: true });

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

  // 签到此刻**不**该发鱼 —— 鱼在翻牌那刻才发：余额还是 0，账里一条 checkin 都没有
  expect(await myBalance(page), '签到只是建记录').toBe(0);
  expect(await myLedger(page, 'checkin'), '签到不能产生流水').toHaveLength(0);

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

  // ── 鱼真的发了：余额 + 流水（同一个事务的两面）──────────────────────────
  await modal.locator('.fortune-modal__close-btn').click();
  await expect(modal).not.toBeVisible();

  const mine = await myLedger(page, 'checkin');
  expect(mine).toHaveLength(1);
  expect(mine[0].type).toBe('checkin');
  // 运势值 1-5，鱼干发放量与之相等（= 结果区显示的那个值）
  expect(mine[0].amount).toBe(value);
  expect(mine[0].description, '流水里要写清这一笔是哪来的').toContain('签到');
  expect(await myBalance(page), '余额真的多了这一笔').toBe(value);

  // ── 同日重复签到 ────────────────────────────────────────────────────────
  const res = await page.request.post('/api/checkin', { data: {} });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.already_checked).toBe(true);
  expect(body.fortune_pending).toBe(false); // 已翻过牌
  expect(body.message).toContain('今天已签到');
  expect(body.total_count).toBe(1); // 没有被重复记成 2 天

  // 重复签到不得发第二次鱼：账里还是那一条，余额一分不涨
  expect(await myLedger(page, 'checkin')).toHaveLength(1);
  expect(await myBalance(page)).toBe(value);

  // 刷新后仍是已签到态（服务端状态，不是前端的临时 state）
  await page.goto('/checkin');
  await expect(btn).toHaveText('今日已签到');
  await expect(btn).toBeDisabled();
  // 今日运势已显示翻出的值（服务端真值）
  await expect(page.locator('.checkin-today-fortune')).toContainText(String(value));
  // 累计签到天数落库为 1
  await expect(page.locator('.checkin-stats__item').first()).toContainText('1');

  // 站内不展示运势值总和：签到卡只剩「累计签到天数」一格，榜单也只有签到天数榜
  // （「今日运势」是这一把翻出来的值，保留 —— 两者别混为一谈）
  await expect(page.locator('.checkin-stats__item')).toHaveCount(1);
  await expect(page.locator('.checkin-leaderboard')).not.toContainText('运势');
});

test('个人资料页不展示运势值总和', async ({ page }) => {
  // 这条与签到同文件：那个数字来自签到累计（users.total_fortune），是签到这条线上
  // 唯一可能外露的面 —— 故单独钉一条，确认统计行里没有它。
  // （资料页**匿名可达**，但统计行只对本人与 core+ 渲染；这里的账号正是本人。）
  const user = await registerFreshUser(page, { core: true });
  await page.goto(`/u/${user.id}`);

  const stats = page.locator('.profile-stats');
  await expect(stats).toContainText('文章'); // 自检：统计行确实渲染出来了
  await expect(stats).not.toContainText('运势');
});

test('恢复态：只签到不翻牌 → 刷新后自动弹「继续完成签到」→ 选牌补翻', async ({ page }) => {
  await registerFreshUser(page, { core: true });

  // ── 只签到、不翻牌（模拟签到后关掉页面/请求中断）────────────────────────
  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status()).toBe(200);
  expect(await myLedger(page, 'checkin'), '未翻牌绝不能发鱼').toHaveLength(0);
  expect(await myBalance(page)).toBe(0);

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

  // 翻牌这一下才发鱼：一条 checkin 流水，金额就是翻出来的那个值
  const mine = await myLedger(page, 'checkin');
  expect(mine).toHaveLength(1);
  expect(mine[0].amount).toBe(value);
  expect(await myBalance(page)).toBe(value);

  // 刷新：pending 消失、运势落定、不再自动弹卡。
  //
  // 【为什么要重试】closeModal 里调了 router.refresh()（刷新排行榜 / 顶栏绿点），
  // Next 把这次 RSC 刷新应用成一次**软导航**（HistoryUpdater 的 history.replaceState）。
  // 若紧跟着的整页刷新与它撞车，WebKit 下 page.goto 会抛「Navigation … is interrupted
  // by another navigation …」—— trace 实测：goto 的文档请求被 cancel，紧接着又提交了
  // 一条 /checkin（Referer: /checkin）。产品侧没问题（真人不会在关弹窗 20ms 后硬刷新），
  // 是这里时序太紧；被打断就再发一次。
  await expect(async () => {
    await page.goto('/checkin', { timeout: 10_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('.fortune-modal--open')).toHaveCount(0);
  await expect(page.locator('.checkin-today-fortune')).toContainText(String(value));
});

test('claim 校验：越界/缺 index/非法 index 被拒，且不落值不发鱼', async ({ page }) => {
  await registerFreshUser(page, { core: true });

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

  // 以上全部被拒后：仍是待翻牌态（值未落、余额没动、账里也没有任何痕迹可查）
  const st = await page.request.get('/api/checkin');
  const status = await st.json();
  expect(status.fortune_pending).toBe(true);
  expect(status.fortune_value).toBeNull();
  expect(await myLedger(page, 'checkin'), '被拒的 claim 绝不能发鱼').toHaveLength(0);
  expect(await myBalance(page)).toBe(0);
});

test('未签到就翻牌 → 「今天还没有签到」', async ({ page }) => {
  await registerFreshUser(page, { core: true });
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

// ─────────────────────────────────────────────────────────────────────────────
// core+ 门槛
//
// 【为什么签到是 core+】鱼干是 core+ 体系的报酬：赚取渠道（签到翻牌、投喂分成）全在
// core 门槛之后。放开签到 = 给未认证账号一条自助领鱼干的路，而它拿到鱼干也没有出口。
// 这条与 `access-control.spec` 的接口矩阵是同一个契约，但**翻牌那一步必须单独钉**：
// 只挡 POST /api/checkin 而漏掉 /claim，就是「签到进不来、翻牌照样领」——
// 而发鱼的恰恰是 claim。
// ─────────────────────────────────────────────────────────────────────────────
test('凡 core+ 门槛：role=user 签到与翻牌都 403，且一分鱼干都不发', async ({ page }) => {
  const user = await registerFreshUser(page); // 默认就是 role=user
  expect(user.id).toBeTruthy();

  const ci = await page.request.post('/api/checkin', { data: {} });
  expect(ci.status(), 'role=user 不该能签到').toBe(403);
  expect((await ci.json()).message).toContain('核心用户');

  const claim = await page.request.post('/api/checkin/claim', { data: { chosenIndex: 0 } });
  expect(claim.status(), '翻牌才是发鱼的那一步，漏了它等于门槛形同虚设').toBe(403);

  // 状态接口同样挡掉：base.js 靠它决定点不点亮签到徽标
  const status = await page.request.get('/api/checkin');
  expect(status.status()).toBe(403);

  // 账目侧的自证：读自己的账不需要 core（账是自己的），而它必须一条不剩地空着 ——
  // 被 403 的那两步若有一条漏网，这里就会看见钱。
  expect(await myLedger(page, 'checkin'), '被 403 的路径绝不能发鱼').toHaveLength(0);
  expect(await myBalance(page)).toBe(0);

  // 入口仍在（与讨论、博客同一种待遇），但点进去是 403
  const pageRes = await page.goto('/checkin');
  expect(pageRes?.status()).toBe(403);
  await expect(page.locator('.rainbow-error__code')).toHaveText('403');
});
