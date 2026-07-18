// 未登录 / 权限不足时的门控行为。
//
// 【为什么分两种预期】本站的门控**故意**有两套语义，别把它们当成同一件事：
//   · redirect('/login')  —— /admin/*、/checkin、/fish/*：跳登录页
//   · forbidden()         —— requireCoreUser 的页面（/blog 等）：原地渲染 403 页，URL 不变
// 后者是为对齐原 Flask 的 abort(403)（见 src/lib/guard.ts）。若哪天有人把 guard 改成
// 统一跳转，403 页那条语义就悄悄没了 —— 这两组用例就是为了让那种改动当场可见。

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

  test('/blog 原地渲染 403（对齐原站 abort(403)，非跳转）', async ({ page }) => {
    const res = await page.goto('/blog');
    // 状态码必须真的是 403 —— 渲染 403 页面但回 200 会让爬虫/监控误判
    expect(res?.status()).toBe(403);
    await expect(page).toHaveURL(/\/blog$/); // URL 不变，这是与 redirect 的分水岭
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });
});

test.describe('角色门控', () => {
  test('普通用户（role=user）访问 /admin 被挡回登录页', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);

    await page.goto('/admin');
    // AdminLayout: hasAdminRights(user) 为假 → redirect(loginUrlWithNext('/admin'))
    await expect(page).toHaveURL('/login?next=%2Fadmin');
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

  test('管理员访问 /admin 正常进入', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('h1')).toContainText('管理概览');
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
// 点赞、建剪贴板、投票、建投票、看照片墙、投喂、申诉，实测全部 200。
// 邀请码/core 体系的意义就是「未认证用户不能做这些」，等于整体失效。
//
// 页面挡了、接口没挡，是这一类漏洞的共同形状 —— 所以这里只打接口，不走 UI。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('核心用户门槛（接口层）', () => {
  // Flask 侧这些全是 @authenticated_required
  const CASES: Array<{ name: string; method: 'GET' | 'POST'; path: string; body?: object }> = [
    { name: '点赞', method: 'POST', path: `/api/blogs/${SEED_BLOG.id}/like` },
    { name: '投喂', method: 'POST', path: `/api/blogs/${SEED_BLOG.id}/feed`, body: { amount: 1 } },
    { name: '剪贴板列表', method: 'GET', path: '/api/clipboard' },
    { name: '建剪贴板', method: 'POST', path: '/api/clipboard', body: { title: 't', content: 'c', publicity: true } },
    { name: '图床列表', method: 'GET', path: '/api/images' },
    { name: '投票列表', method: 'GET', path: '/api/votes' },
    { name: '建投票', method: 'POST', path: '/api/votes', body: { title: 't', options: ['a', 'b'] } },
    { name: '照片墙', method: 'GET', path: '/api/photowall' },
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
