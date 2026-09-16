// 未登录 / 权限不足时的门控行为。
//
// 【统一契约（对齐 src/lib/guard.ts / admin/layout.tsx 的现行语义）】
//   · 未登录 → redirect('/login?next=…')：一律先登录（含 /blog —— 早期曾对匿名
//     原地 403，那是 Flask abort(403) 的旧语义，已被「先登录再回来」取代）
//   · 已登录但角色不够 → forbidden()：原地渲染 403 页，URL 不变（对齐 Flask abort(403)）
// 若哪天有人把 guard 改回「匿名也 403」或「低角色也跳登录」，这两组用例会让改动当场可见。

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_BLOG } from './seed';
import { loginViaApi } from './helpers';

test.describe('未登录访问受控页面', () => {
  test('/checkin 跳转登录页，并带上回跳地址', async ({ page }) => {
    await page.goto('/checkin');
    // 带 ?next= 才能在登录后回到这里（对齐 Flask-Login 的 login_view 行为）。
    // Next 侧一度只跳 '/login'、登录后一律回首页 —— 那是行为回归。
    await expect(page).toHaveURL('/login?next=%2Fcheckin');
    await expect(page.locator('#loginForm')).toBeVisible();
  });

  test('/admin 跳转登录页，并带上回跳地址', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL('/login?next=%2Fadmin');
  });

  test('/blog 跳转登录页（匿名一律先登录；403 只留给已登录但角色不够的人）', async ({ page }) => {
    const res = await page.goto('/blog');
    // 必须真的发生重定向 —— 匿名访问受控页要先去登录（requireCoreUser 语义）
    expect(res?.url()).toMatch(/\/login\?next=/);
    // next 取 referer（直接导航无 referer → 回根路径 '/'），别断言具体值，钉死「带了 next」即可
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.locator('#loginForm')).toBeVisible();
  });
});

test.describe('角色门控', () => {
  test('普通用户（role=user）访问 /admin 原地 403（已登录但角色不够 → forbidden，非跳转）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.goto('/admin');
    // AdminLayout: isCoreUser(user) 为假 → forbidden() 原地 403，URL 不变
    // （段级 layout 是 core+；/admin 这一页自己的 requireAdmin() 也拦得住 user）
    expect(res?.status()).toBe(403);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
    // 顶栏能证明「他确实登着录」，被挡是因为角色不够，不是因为没登录 ——
    // 少了这一条，用例在「会话根本没生效」时也会绿。
    await expect(page.locator('#userDropdownToggle')).toContainText(SEED_USERS.plain.username);
  });

  test('普通用户（role=user）访问 /blog 得到 403，而非登录页', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.goto('/blog');
    expect(res?.status()).toBe(403);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });

  test('普通用户（role=user）访问 /checkin 得到 403（签到是鱼干的赚取渠道，core+ 档）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    const res = await page.goto('/checkin');
    expect(res?.status(), '签到给未认证账号开了自助领鱼干的口子').toBe(403);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });

  test('403 页不劝已登录用户「去登录」（他就是登录着才被挡的）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    await page.goto('/blog');
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');

    const actions = page.locator('.rainbow-error__actions');
    await expect(actions.getByRole('link', { name: '去登录' })).toHaveCount(0);
    await expect(actions.getByRole('link', { name: '返回首页' })).toBeVisible();
    // 提示里点出当前账号 —— 用户第一反应是「我明明登录了」，得让他确认是不是登错号
    await expect(page.locator('.rainbow-error__hint')).toContainText(SEED_USERS.plain.username);
  });

  test('管理员（非 owner）访问 /admin/oauth 原地 403，而不是 404', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    const res = await page.goto('/admin/oauth');
    // 该页原先 redirect('/forbidden')，但项目里没有 /forbidden 路由 → 落到 404 页，
    // 「权限不够」被显示成「页面不存在」。现在与其它 owner-only 页一致：原地 403。
    expect(res?.status()).toBe(403);
    await expect(page).toHaveURL(/\/admin\/oauth$/);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });

  test('站长访问 /admin/oauth 正常进入（收紧不能误伤）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    const res = await page.goto('/admin/oauth');
    expect(res?.status()).toBe(200);
    await expect(page.locator('.rainbow-error__code')).toHaveCount(0);
    await expect(page.locator('h1')).toHaveText('OAuth 应用');
  });

  test('管理员访问 /admin 正常进入', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('h1')).toContainText('管理概览');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // /admin/* 的档位是**按页**分的，不是整齐一刀
  //
  // 回归背景：段级 layout 一度收在 hasAdminRights，而 AdminShell 的侧栏对 core 用户
  // 就露出「用户管理」（对齐 Flask admin_base.html 的 is_core_user 门控）——
  // 于是核心用户点进去必然 403：入口和门禁自相矛盾。Flask 侧 auth.user_management 的
  // 装饰器是 @authenticated_required（core+），management.html 给核心用户看的是只读版。
  // 修法是段级放宽到 core+，真正要管理权的页面各自把门。这组用例把两半都钉住。
  // ───────────────────────────────────────────────────────────────────────────
  test('★ 核心用户能进 /admin/users（只读版：标题「用户列表」，无禁言按钮）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    const res = await page.goto('/admin/users');
    expect(res?.status(), '核心用户看用户管理被 403 了 —— 侧栏有入口、门禁却不认').toBe(200);
    await expect(page.locator('h1')).toHaveText('用户列表');
    await expect(page.locator('.rainbow-error__code')).toHaveCount(0);

    // 只读：能看列表（「查看」是人人都有的），但没有点了必然 403 的动作按钮
    await expect(page.locator('.user-card').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '禁言', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '解除禁言' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '认证' })).toHaveCount(0);
  });

  test('管理员进 /admin/users 是完整版（标题「用户管理」，禁言按钮在）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    const res = await page.goto('/admin/users');
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('用户管理');
    // 种子里既有普通用户也有 core，必然至少渲染出一个可禁言的按钮
    expect(await page.getByRole('button', { name: '禁言', exact: true }).count()).toBeGreaterThan(0);
  });

  test('普通用户（role=user）仍进不了 /admin/users', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    const res = await page.goto('/admin/users');
    expect(res?.status()).toBe(403);
  });

  test('★ 放宽不能连带放行：核心用户进不了 /admin 与 /admin/blogs', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    for (const url of ['/admin', '/admin/blogs']) {
      const res = await page.goto(url);
      expect(res?.status(), `${url} 只该给管理员 —— 段级放宽到 core 后页面得自己把门`).toBe(403);
      await expect(page.locator('.rainbow-error__code')).toHaveText('403');
    }
  });

  test('普通用户顶栏不出现「管理面板」入口', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    await page.goto('/');
    // 入口藏在用户下拉里（移动端折叠），故不看可见性、只看它在不在 DOM 里
    await expect(page.locator('#userDropdownMenu a[href="/admin"]')).toHaveCount(0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 核心用户门槛：**接口**层
//
// 上面那组测的是页面门控。而这批 API 一度只判了「登录」不判「核心用户」——
// role=user（注册了但从没用邀请码认证的人）用不了界面，却 curl 得动：
// 点赞、建剪贴板、投票、建投票、投喂、申诉，实测全部 200。
// 邀请码/core 体系的意义就是「未认证用户不能做这些」，等于整体失效。
//
// 页面挡了、接口没挡，是这一类漏洞的共同形状 —— 所以这里只打接口，不走 UI。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('核心用户门槛（接口层）', () => {
  // Flask 侧这些全是 @authenticated_required
  //
  // ⚠️ 只放**两个方向都无副作用**的调用。签到的写接口（POST /api/checkin 与
  //    /claim）刻意不在此列：core 那一轮会真的给 e2e_core 建一条签到记录并翻牌发鱼，
  //    改掉种子账号的余额，把别的用例绊倒。它们的方向断言在 checkin.spec 里
  //    （用临时注册的账号，不碰种子）。这里放状态 GET 就够证明门槛在了。
  const CASES: Array<{ name: string; method: 'GET' | 'POST'; path: string; body?: object }> = [
    { name: '点赞', method: 'POST', path: `/api/blogs/${SEED_BLOG.id}/like` },
    { name: '投喂', method: 'POST', path: `/api/blogs/${SEED_BLOG.id}/feed`, body: { amount: 1 } },
    { name: '剪贴板列表', method: 'GET', path: '/api/clipboard' },
    { name: '建剪贴板', method: 'POST', path: '/api/clipboard', body: { title: 't', content: 'c', publicity: true } },
    { name: '图床列表', method: 'GET', path: '/api/images' },
    { name: '投票列表', method: 'GET', path: '/api/votes' },
    { name: '建投票', method: 'POST', path: '/api/votes', body: { title: 't', options: ['a', 'b'] } },
    { name: '签到状态', method: 'GET', path: '/api/checkin' },
  ];

  for (const c of CASES) {
    test(`role=user 调 ${c.name} → 403`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.plain.username);
      const res =
        c.method === 'GET'
          ? await page.request.get(c.path)
          : await page.request.post(c.path, { data: c.body ?? {} });
      expect(res.status(), `${c.method} ${c.path} 应拒绝非核心用户`).toBe(403);
    });
  }

  for (const c of CASES) {
    test(`core 用户调 ${c.name} → 不是 403（收紧不能误伤）`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.core.username);
      const res =
        c.method === 'GET'
          ? await page.request.get(c.path)
          : await page.request.post(c.path, { data: c.body ?? {} });
      // 不断言 200：投喂会因余额不足给 400，那是业务规则，与权限无关。
      // 只要不是 403，就说明权限这关放行了。
      expect(res.status(), `${c.method} ${c.path} 不该把核心用户挡在外面`).not.toBe(403);

      // 点赞是**切换**，且打在种子文章上 —— 不还原的话 likers 用例（断言 total=0）
      // 会挂在一个跟它自己八竿子打不着的地方。再点一次抵消。
      if (c.name === '点赞' && res.status() === 200) {
        await page.request.post(c.path, { data: {} });
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 「功能存在，但当前账号权限不够」——入口**保留**，不做同档隐藏
//
// 站长 2026-09 的明确口径：讨论的入口对所有人渲染（与顶栏「博客」「日志」同待遇），
// 点进去 403 就 403。曾经按「入口与门禁同档」把讨论入口与首页讨论卡藏掉过 ——
// 那是把一条**具体**的教训过度推广了：
//   · 必须修的是 /admin/users 那种自相矛盾：入口有、门禁却不认（核心用户看得到
//     侧栏「用户管理」却被 403）——那是入口和门禁**互相打架**；
//   · 不该修的是「功能存在，但你权限不够」——那正是权限阶梯该有的样子，
//     藏起来反而让人不知道站里有这个板块。
// 这一组用例把两半都钉住，免得下次又有人「顺手对齐」把它藏回去。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('入口保留：非核心用户看得到讨论入口，但进不去', () => {
  test('匿名访客：顶栏与首页讨论卡都在', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.site-nav a[href="/chat"]')).toHaveCount(1);
    await expect(page.locator('a.card-chat')).toBeVisible();
  });

  test('普通用户（role=user）：入口在，/chat 原地 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    await page.goto('/');
    await expect(page.locator('.site-nav a[href="/chat"]')).toHaveCount(1);

    const res = await page.goto('/chat');
    expect(res?.status(), '讨论仍是 core+ 档：入口保留不等于放行').toBe(403);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });
});
