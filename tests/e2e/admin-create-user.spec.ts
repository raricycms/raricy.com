// ─────────────────────────────────────────────────────────────────────────────
// admin-create-user.spec.ts —— 站长建号（跳过人机验证与邀请码，直接 core）
//
// 【为什么必须有用例】这是全站唯一一个「凭空造出一个 core 用户」的入口，而且它**故意**
// 绕过了公开注册的两道门（人机验证、邀请码）。三条边界只有真发 HTTP 才验得到：
//
//   1. 非站长必须被挡在接口外 —— admin 也不行（它不能给自己人发 core 号）；
//   2. ⚠️ /admin/users 本身是 **core+**（核心用户能进只读列表），所以「URL 藏起来不等于
//      挡住」这条在这里不成立：正确的页面级断言是**页面照常 200，但里面没有建号表单**；
//   3. 建出来的号必须真能用手填的密码登录 —— 角色给对了不等于进得来。
//
// 另外钉住一个容易回退的 UX 细节：新号按 createdAt 升序排在列表**最后一页**，
// 建完 router.refresh() 后当前页不会有任何变化，所以成功面板必须给「在列表中查看」入口。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi, loginViaUI, uniqueTag } from './helpers';

const PASSWORD = 'e2ePassword123';

/** 唯一用户名：desktop / mobile 两个 project 会把同一个用例跑两遍，
 *  写死用户名第二遍必撞「用户名已存在」。前缀压到 6 字符，给唯一后缀留出
 *  validateUsername 的 20 字上限。 */
function newUsername(tag: string): string {
  return `e2e_n_${tag}`;
}

test.describe('POST /api/admin/users — 站长建号', () => {
  test('未登录 → 403', async ({ request }) => {
    const res = await request.post('/api/admin/users', {
      data: { username: 'nobody', password: PASSWORD },
    });
    expect(res.status()).toBe(403);
  });

  test('★ 管理员 → 403（建 core 号不归管理员）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.post('/api/admin/users', {
      data: { username: newUsername(uniqueTag()), password: PASSWORD },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe('没有站长权限');
  });

  test('core 用户 → 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.post('/api/admin/users', {
      data: { username: newUsername(uniqueTag()), password: PASSWORD },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('/admin/users 页面的建号表单', () => {
  test('★ 站长看得到', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: '新建用户（站长）' })).toBeVisible();
  });

  test('★ 管理员看不到（页面本身是 core+，只断言表单不在）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin/users');
    // 页面照常打开：/admin/users 对 admin 是正常的「用户管理」
    await expect(page.getByRole('heading', { name: '用户管理', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '新建用户（站长）' })).toHaveCount(0);
  });

  test('核心用户同样看不到（同一页的只读版）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: '用户列表', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '新建用户（站长）' })).toHaveCount(0);
  });
});

test.describe('建号的端到端结果', () => {
  test('★ 建出来直接是 core，且能用手填的密码登录', async ({ page }) => {
    const username = newUsername(uniqueTag());
    await loginViaApi(page, SEED_USERS.owner.username);

    const res = await page.request.post('/api/admin/users', {
      data: { username, password: PASSWORD, reason: 'e2e 建号用例' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const j = await res.json();
    expect(j.user.role).toBe('core');
    // 没填邮箱 → 合成占位邮箱，且如实回报
    expect(j.emailSynthesized).toBe(true);
    expect(j.email).toBe(`${username}@users.invalid`);

    // 换成这个新号登录（会顶掉当前 context 的会话 cookie）——角色对不等于进得来
    await loginViaUI(page, username, PASSWORD);
    await page.goto('/admin/users');
    // core 进来看到的是只读版标题；若角色被带成 admin 这里会是「用户管理」
    await expect(page.getByRole('heading', { name: '用户列表', level: 1 })).toBeVisible();
  });

  test('★ 走界面建号：成功面板给出「在列表中查看」入口', async ({ page }) => {
    const username = newUsername(uniqueTag());
    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto('/admin/users');

    await page.fill('#admin-new-username', username);
    await page.fill('#admin-new-password', PASSWORD);
    await page.getByRole('button', { name: '创建账号' }).click();

    const panel = page.locator('.settings-alert--success');
    await expect(panel).toContainText(username);
    // 新号在列表最后一页，不给出这个入口站长会以为建号失败了
    await expect(page.locator(`a[href="/admin/users?search=${username}"]`)).toBeVisible();
  });

  test('管理员拿表单里的参数直接打接口也过不去', async ({ page }) => {
    // 表单不给管理员看，但接口不能只靠「UI 没这个按钮」——上面已有 403 用例，
    // 这条再确认一次：换成管理员会话、带上合法的用户名/密码，结果仍是 403 且不建号。
    const username = newUsername(uniqueTag());
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.post('/api/admin/users', {
      data: { username, password: PASSWORD, reason: '越权测试' },
    });
    expect(res.status()).toBe(403);

    await loginViaApi(page, SEED_USERS.owner.username);
    await page.goto(`/admin/users?search=${username}`);
    await expect(page.locator('.empty-state, .user-grid')).not.toContainText(username);
  });
});
