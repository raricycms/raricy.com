// ─────────────────────────────────────────────────────────────────────────────
// admin-permissions.spec.ts —— /admin 平台的「站长专属」门控（合并自
// admin-categories.spec.ts / admin-logs.spec.ts / admin-role-buttons.spec.ts /
// broadcast-permission.spec.ts 四个同域小文件；旧的四个文件名即本文件的前身，
// 需要追溯某条用例的历史时按上面名字查 git log）。
//
// 【为什么必须是 E2E】这一批要实现的东西**只有真发 HTTP / 真渲染侧栏才验得到**：
//   · 路由的判权（页面挡了、接口没挡是这类漏洞的共同形状）；
//   · 页面自己的 layout 守卫（AdminShell 侧栏对非站长隐藏入口，但 URL 猜得到 ——
//     「链接藏起来」不等于「挡住」）；
//   · 角色按钮只在服务端渲染的 user-card 上，按角色两分支渲染（旧实现会把管理员
//     显示成「认证」按钮、点了反而降级）。
// service 层只覆盖 role/service 规则；判权与页面门控必须走真实请求。
//
// 【造数纪律】角色按钮用例会真的改种子用户角色，改完必须还原 —— 全套 e2e 共用一个库。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser } from './helpers';
import { SEED_USERS } from './seed';

/** 打开用户管理页并定位某个用户的卡片。 */
async function openUserCard(page: Page, username: string) {
  await page.goto(`/admin/users?search=${encodeURIComponent(username)}`);
  const card = page.locator('.user-card', { hasText: username }).first();
  await expect(card).toBeVisible();
  return card;
}

/** 走接口改角色（还原用：不经过 UI，避免依赖页面自身还正常）。 */
async function setRoleViaApi(page: Page, userId: string, role: string) {
  const res = await page.request.patch(`/api/admin/users/${userId}`, { data: { role } });
  expect(res.status(), `改角色失败：${await res.text()}`).toBe(200);
}

// ── 站长专属接口：群发 / 申诉裁决 / 栏目结构 ──────────────────────────────────
//
// 群发一次触达全站；申诉是对管理员权力的制衡（管理员能裁决针对自己的申诉就形同
// 虚设）；栏目结构是站点 URL 与发文规则。三者此前都只判 hasAdminRights。

const OWNER_ONLY_APIS: Array<{ name: string; path: string; body: object }> = [
  { name: '群发', path: '/api/admin/broadcast', body: { detail: '越权测试' } },
  { name: '申诉裁决', path: '/api/admin/appeals/1', body: { decision: 'accept' } },
  { name: '新建栏目', path: '/api/admin/categories', body: { name: '越权栏目', slug: 'evil-cat' } },
];

test.describe('站长专属接口', () => {
  for (const api of OWNER_ONLY_APIS) {
    test(`${api.name}：未登录 → 403`, async ({ request }) => {
      const res = await request.post(api.path, { data: api.body });
      expect(res.status()).toBe(403);
    });

    test(`★ ${api.name}：管理员 → 403（不是站长就不能动）`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.admin.username);
      const res = await page.request.post(api.path, { data: api.body });
      expect(res.status()).toBe(403);
      expect((await res.json()).message).toBe('没有站长权限');
    });
  }

  test('★ 管理员读栏目清单 → 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get('/api/admin/categories');
    expect(res.status()).toBe(403);
  });

  test('core 用户调群发 → 403（管理员以下一律不行）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.post('/api/admin/broadcast', { data: { detail: 'x' } });
    expect(res.status()).toBe(403);
  });
});

// ── 站长专属页面：URL 猜得到也必须 403 ────────────────────────────────────────

test.describe('站长专属页面', () => {
  test('★ 管理员直接访问三个 URL → 403（侧栏藏起入口不等于挡住）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    for (const url of ['/admin/broadcast', '/admin/appeals', '/admin/categories']) {
      const res = await page.request.get(url);
      expect(res.status(), `${url} 只该给站长`).toBe(403);
    }
  });

  test('管理员的侧栏里没有站长专属入口（群发 / 申诉 / 栏目）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin');
    // 只量侧栏：管理概览的「快捷入口」在站长下也会给这些链接，全页计数当门控证据会误判。
    await expect(page.locator('.admin-sidebar a[href="/admin/broadcast"]')).toHaveCount(0);
    await expect(page.locator('.admin-sidebar a[href="/admin/appeals"]')).toHaveCount(0);
    await expect(page.locator('.admin-sidebar a[href="/admin/categories"]')).toHaveCount(0);
  });

  test('站长全流程：侧栏可见「栏目管理」→ 进入页面 → 新建栏目成功', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    // 入口在站长专属导航组里（同样限定在侧栏，避开管理概览的快捷入口）
    await page.goto('/admin');
    const nav = page.locator('.admin-sidebar a[href="/admin/categories"]');
    await expect(nav).toHaveCount(1);
    await nav.click();
    await expect(page).toHaveURL(/\/admin\/categories$/);
    await expect(page.getByRole('heading', { name: '栏目管理' })).toBeVisible();

    // 新建一个一级栏目：名称 + slug（必填，其余默认）
    const tag = Date.now().toString(36);
    const name = `E2E 新建栏目 ${tag}`;
    const slug = `e2e-new-${tag}`;
    await page.getByRole('button', { name: '+ 新建栏目' }).click();
    const dialog = page.locator('.modal-dialog');
    await expect(dialog).toBeVisible();
    // 表单输入按 modal-body 内 form-control 顺序：名称、slug、图标、排序、描述
    await dialog.locator('input.form-control').nth(0).fill(name);
    await dialog.locator('input.form-control').nth(1).fill(slug);
    await dialog.getByRole('button', { name: '保存' }).click();

    // 保存成功 → 模态收起，列表直出新建的行（router.refresh 重新拉服务端数据）
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.article-card__title', { hasText: name })).toBeVisible();
    // 行内徽标默认：无「不进全部」等标签 —— 断言 slug 展示即验证服务端已落库
    await expect(page.locator('.article-card code', { hasText: slug })).toBeVisible();

    // 清理：新建的栏目没有内容，删除按钮可用 —— 不留脏种子
    const row = page.locator('.article-card', { hasText: name });
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.article-card', { hasText: name })).toHaveCount(0);
  });
});

// ── /admin/logs：页面自己把 admin+ 档（母版只判 core+）────────────────────────

test.describe('/admin/logs 门控', () => {
  test('未登录 → 302/307 去登录页', async ({ request }) => {
    const res = await request.get('/admin/logs', { maxRedirects: 0 });
    expect([302, 307]).toContain(res.status());
    expect(res.headers().location ?? '').toContain('/login?next=');
  });

  test('core / 普通用户 → 403（这一页是 admin+，别跟着母版的 core 档放行）', async ({ page }) => {
    for (const username of [SEED_USERS.core.username, SEED_USERS.plain.username]) {
      await loginViaApi(page, username);
      const res = await page.request.get('/admin/logs');
      expect(res.status(), `${username} 不该进日志检索`).toBe(403);
    }
  });

  test('admin → 200，且渲染出检索表单', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get('/admin/logs');
    expect(res.status()).toBe(200);
    await page.goto('/admin/logs');
    await expect(page.locator('.admin-hero h1')).toHaveText('日志检索');
    // 检索入口真的在页面上（动作下拉 + 执行者/当事人两个输入 + 「不限时间」档）。
    await expect(page.locator('form.audit-filter-bar #log-action')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="admin"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar input[name="target"]')).toBeVisible();
    await expect(page.locator('form.audit-filter-bar #log-range')).toBeVisible();
  });

  test('动作下拉在浮层里展开，选择后随 GET 表单提交', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/admin/logs');

    const toggle = page.locator('#log-action');
    const host = page.locator('.expand-select', { has: toggle });
    const panel = host.locator('.expand-select__panel');

    // 收起时面板 inert（不进入焦点序列）；点开后才可交互。
    await expect(panel).toHaveAttribute('inert', '');
    await toggle.click();
    await expect(panel).not.toHaveAttribute('inert', '');

    await host.getByRole('option', { name: '禁言用户', exact: true }).click();
    await expect(toggle).toContainText('禁言用户');
    await expect(panel).toHaveAttribute('inert', '');

    // 值经隐藏 input 随 GET 表单提交，URL 与服务端回填都要跟上。
    await page.locator('form.audit-filter-bar button[type="submit"]').click();
    await expect(page).toHaveURL(/[?&]action=ban_user(?:&|$)/);
    await expect(page.locator('#log-action')).toContainText('禁言用户');
  });
});

// ── 用户管理：角色档位按钮 ─────────────────────────────────────────────────────
//
// 防的回归：core → admin 与 admin → core 只能上服务器跑 CLI；管理员卡片上出现
// 写着「认证」、点了却把人降级的按钮（旧实现按「是 core 就显取消认证」两分支渲染）。

test.describe('用户管理：角色档位按钮（站长）', () => {
  test('站长可提拔核心用户为管理员，再降回核心用户', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    // 造一个干净的核心用户当靶子（用真实提权接口升到 core）
    const target = await registerFreshUser(page, { core: true });
    await loginViaApi(page, SEED_USERS.owner.username); // 上面把登录态换走了

    try {
      // ── 提拔 ──
      const card = await openUserCard(page, target.username);
      await expect(card.locator('.user-card__role')).toHaveText('核心用户');
      await card.getByRole('button', { name: '提拔管理员' }).click();

      // 操作成功后组件会 router.refresh()（延迟 300ms），等角色标签自己变过来
      await expect(card.locator('.user-card__role')).toHaveText('管理员', { timeout: 10_000 });
      // 已经是管理员了 → 提拔按钮消失，出现降级按钮，且**不该**有「认证」
      await expect(card.getByRole('button', { name: '提拔管理员' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: '认证' })).toHaveCount(0);

      // ── 降级 ──
      await card.getByRole('button', { name: '降为核心用户' }).click();
      await expect(card.locator('.user-card__role')).toHaveText('核心用户', { timeout: 10_000 });
      await expect(card.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: '提拔管理员' })).toBeVisible();
    } finally {
      await setRoleViaApi(page, target.id, 'user');
    }
  });

  test('管理员的卡片上没有「认证」按钮（旧实现会把人降成 core）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    const card = await openUserCard(page, SEED_USERS.admin.username);
    await expect(card.locator('.user-card__role')).toHaveText('管理员');
    // 管理员档位只有「降为核心用户」，没有「认证」/「取消认证」这一对
    await expect(card.getByRole('button', { name: '降为核心用户' })).toBeVisible();
    await expect(card.getByRole('button', { name: '认证', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '取消认证' })).toHaveCount(0);
  });

  test('站长自己的卡片上没有角色按钮（不能自己降自己）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    const card = await openUserCard(page, SEED_USERS.owner.username);
    await expect(card.locator('.user-card__role')).toHaveText('站长');
    await expect(card.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '认证', exact: true })).toHaveCount(0);
  });
});

test.describe('用户管理：角色档位按钮（管理员）', () => {
  test('管理员看不到「提拔管理员」/「降为核心用户」——任命管理员是站长专属', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    const core = await openUserCard(page, SEED_USERS.core.username);
    await expect(core.locator('.user-card__role')).toHaveText('核心用户');
    await expect(core.getByRole('button', { name: '认证', exact: true })).toHaveCount(0); // 站长专属的那一对
    await expect(core.getByRole('button', { name: '提拔管理员' })).toHaveCount(0);

    const admin = await openUserCard(page, SEED_USERS.admin.username);
    await expect(admin.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
  });
});
