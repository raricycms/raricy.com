import { expect, type Page } from '@playwright/test';
import { SEED_PASSWORD } from './seed';

/** 唯一后缀：注册类用例每次都要新用户名，且 desktop / mobile 两个 project 会把同一个
 *  用例跑两遍 —— 写死用户名第二遍必撞「用户名已存在」。 */
export function uniqueTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 服务端认为「当前是谁」。
 *
 * 读的是 root layout 直出的 <meta name="user-authenticated">：它由服务端在渲染每个
 * 页面时按 cookie 现算，因此**只有 cookie 真的随导航发回了服务端**它才会是 true。
 * 这正是线上那个 bug 的探针 —— 当时 Secure cookie 被浏览器丢弃，登录接口回 200、
 * 前端 toast「登录成功」，但任何一次导航后服务端都认不出人。断言接口返回值看不见它，
 * 断言前端状态也看不见它，只有真浏览器 + 真导航才看得见。
 */
export async function serverSeesAuthenticated(page: Page): Promise<boolean> {
  const content = await page
    .locator('meta[name="user-authenticated"]')
    .getAttribute('content');
  return content === 'true';
}

/** 走真实登录页（填表 + 提交），而不是直接种 cookie —— 要测的就是这条链路本身。 */
export async function loginViaUI(page: Page, username: string, password = SEED_PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    // 登录成功后前端 router.push('/')，等这次跳转落地再继续
    page.waitForURL('/', { timeout: 15_000 }),
    page.click('#submitBtn'),
  ]);
}

/**
 * 用 API 快速登录（把登录当**前置条件**而非被测目标时用它，省掉一次表单往返）。
 *
 * 必须用 page.request 而不是顶层的 `request` fixture：后者是独立的
 * APIRequestContext，它拿到的 Set-Cookie 进不了浏览器的 cookie jar，
 * 随后的 page.goto 依然是未登录 —— 用例会以「跳转到登录页」的假象挂掉，
 * 而且看起来像被测代码的鉴权有问题。page.request 与页面共用同一个 context 的 cookie。
 */
export async function loginViaApi(page: Page, username: string) {
  const res = await page.request.post('/api/auth/login', {
    data: { username, password: SEED_PASSWORD },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).code).toBe(200);
}

/** 注册一个全新用户（角色 user）并让浏览器 context 处于其登录态。返回用户信息。 */
export async function registerFreshUser(page: Page): Promise<{ id: string; username: string }> {
  const tag = uniqueTag();
  const username = `e2e_${tag}`;
  const res = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD },
  });
  const body = await res.json();
  // 断言而非静默继续：注册失败时后续用例的报错会指向八竿子打不着的地方
  expect(body.code, `注册失败：${JSON.stringify(body)}`).toBe(200);
  return { id: body.user.id, username };
}
