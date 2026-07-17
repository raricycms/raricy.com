// 注册 → 登录 → 登录态跨页面保持 → 登出。
//
// 【为什么这条链路值得用真浏览器打】线上翻过的车：cookie 的 Secure 标记设错，
// HTTP 站点下浏览器**静默丢弃**会话 cookie。表现是登录接口 200、前端弹「登录成功」、
// 然后什么都没发生。API 测试全绿，因为 Set-Cookie 头确实发出去了 —— 只有真浏览器
// 会执行「丢弃」这一步。故本文件的断言一律落在「服务端在下一次导航时还认不认得我」，
// 而不是「接口回了什么」。

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_PASSWORD } from './seed';
import { loginViaUI, serverSeesAuthenticated, uniqueTag } from './helpers';

test.describe('认证主链路', () => {
  test('注册后会话立即生效（服务端认得新用户）', async ({ page }) => {
    const tag = uniqueTag();
    const username = `e2e_${tag}`;

    await page.goto('/register');
    await page.fill('#username', username);
    await page.fill('#email', `${tag}@e2e.local`);
    await page.fill('#password', SEED_PASSWORD);
    await page.fill('#confirmPassword', SEED_PASSWORD);
    // 用户协议是 required 勾选框，不勾会被原生表单校验拦下、请求根本发不出去
    await page.check('#agreeTerms');
    await page.click('button[type="submit"]');

    // 注册成功后前端 setTimeout 1.8s 再 router.push('/login')（对齐 Flask register.html）
    await page.waitForURL('**/login', { timeout: 15_000 });

    // 关键断言：注册接口下发的会话 cookie 必须被浏览器接受、并在**新的导航**里发回服务端。
    // 直接跳去首页而不是信任上一跳，确保这是一次真实的服务端往返。
    await page.goto('/');
    expect(await serverSeesAuthenticated(page)).toBe(true);
    await expect(page.locator('#userDropdownToggle')).toContainText(username);
  });

  test('登录态跨页面保持，登出后失效', async ({ page }) => {
    await loginViaUI(page, SEED_USERS.core.username);

    // 落地页（router.push 后的首页）服务端已认人
    expect(await serverSeesAuthenticated(page)).toBe(true);

    // 跨页面保持：换几个不同的路由段，每次都是全新的服务端渲染。
    // 只测一个页面不够 —— cookie 的 path 属性设错时，恰好只在某些路径下会发。
    for (const url of ['/blog', '/checkin', '/']) {
      await page.goto(url);
      expect(await serverSeesAuthenticated(page), `导航到 ${url} 后登录态应保持`).toBe(true);
      // 未登录时 /checkin 会 redirect('/login')，能停在原 URL 本身就是登录态生效的证据
      expect(new URL(page.url()).pathname).toBe(url);
    }

    // 登出：走顶栏那个无 JS 依赖的 GET /logout（移动端下拉菜单是折叠的，
    // 直接点 DOM 里的链接在 iPhone 视口下不可见，故用导航触发）
    // 注意别在 goto 之后再 waitForURL('/')：goto 已经跟完了 302 并停在 '/'，
    // 此时 waitForURL 是在等**下一次**导航，那次导航永远不会来 → 30s 超时，
    // 且失败信息长得像「登出没跳转」，极具误导性。goto 返回即代表跳转已完成。
    await page.goto('/logout');
    expect(new URL(page.url()).pathname).toBe('/'); // GET /logout 应重定向回首页
    expect(await serverSeesAuthenticated(page)).toBe(false);
    // 顶栏切回未登录态。用 toHaveCount 而非 toBeVisible：移动端（iPhone 13 视口）下
    // 整个 .nav-collapse 折在汉堡菜单里，登录链接在 DOM 里但 hidden ——
    // 断可见性会让这条用例只在桌面视口成立，且失败信息像「登出没生效」，纯属误导。
    await expect(page.locator('.nav-login')).toHaveCount(1);
    await expect(page.locator('#userDropdownToggle')).toHaveCount(0);

    // 登出必须是服务端认定的：再访问需要登录的页面应被打回
    await page.goto('/checkin');
    await expect(page).toHaveURL(/\/login/);
  });

  test('密码错误不下发会话', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', SEED_USERS.core.username);
    await page.fill('#password', 'wrong-password');
    await page.click('#submitBtn');

    // 失败时前端只弹 toast、不跳转（toast 3.5s 后自动消失，故断言要快）
    await expect(page.locator('#toast-container .toast__body')).toContainText(
      '用户名或密码错误'
    );
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/');
    expect(await serverSeesAuthenticated(page)).toBe(false);
  });
});

test.describe('登录回跳（next）', () => {
  test('带 next 登录后回到原页，而不是首页', async ({ page }) => {
    // Next 侧一度**完全忽略** next：登录页那个 name="next" 的 hidden input
    // 从没被发送过，跳转硬编码 '/'。于是「未登录点签到 → 登录 → 落到首页」，
    // 用户还得自己再点一次。Flask 有 64 个 @login_required 路由都能正常回原页。
    await loginViaUI(page, SEED_USERS.core.username, SEED_PASSWORD, '/checkin');
    await expect(page).toHaveURL('/checkin');
    expect(await serverSeesAuthenticated(page)).toBe(true);
  });

  test('★ next 指向外站时不跳出去（开放重定向）', async ({ page }) => {
    // 补回 next 就等于把一个攻击者可控的值喂给 router.push。
    // 攻击长这样：诱导用户点 /login?next=https://evil.com，用户在**我们自己的**
    // 登录页输完密码后被弹去钓鱼站 —— 全程地址栏都是可信域名。
    await page.goto('/login?next=' + encodeURIComponent('https://evil.example.com'));
    await page.fill('#username', SEED_USERS.core.username);
    await page.fill('#password', SEED_PASSWORD);
    await page.click('#submitBtn');
    await expect(page).toHaveURL('/'); // 落回首页，没被弹出去
    expect(page.url()).not.toContain('evil');
  });

  test('★ 协议相对 URL 也挡住（//evil.com 浏览器当跨站跳转）', async ({ page }) => {
    await page.goto('/login?next=' + encodeURIComponent('//evil.example.com'));
    await page.fill('#username', SEED_USERS.core.username);
    await page.fill('#password', SEED_PASSWORD);
    await page.click('#submitBtn');
    await expect(page).toHaveURL('/');
    expect(page.url()).not.toContain('evil');
  });
});
