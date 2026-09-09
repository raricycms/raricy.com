// ─────────────────────────────────────────────────────────────────────────────
// audit-detail.spec.ts —— 操作详情页 + 申诉提交
//
// 【为什么必须是 E2E】这个页面此前根本不存在：/audit 列表每行的「详情」链接全部
// 404，且提交申诉的 API（/api/audit/[id]/appeal）因此成了孤儿 —— 用户没有任何
// 入口申诉，而 Flask 里可以。这类「页面缺失 / 链接断头」tsc 不管、单测也不管
// （单测直接调 service，不经过路由与页面），只有真的走一遍 HTTP 才暴露。
//
// 【申诉用例为什么按 project 分日志】申诉只允许**当事人本人**提交（见
// src/lib/audit-service.ts 的 createAppeal）。desktop 与 mobile 两个 project 共库，
// 同一条日志被两边各申诉一次，后跑的会撞「同人同日志只允许一条 pending」——
// 故 seed.ts 给每个 project 各备一条日志与一位当事人。
// 提交申诉的接口要求 core+（详情**页面**同样要求 core）。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_LOG, SEED_LOGS } from './seed';
import { loginViaApi, registerFreshUser } from './helpers';

test.describe('操作详情页', () => {
  test('未登录访问 → 302 去登录页（与 /audit 列表一致的门控）', async ({ request }) => {
    // guard.requireCoreUser 的语义：未登录 → redirect(/login?next=…) 让用户登录后
    // 再回来；403 留给「已登录但权限不够」。maxRedirects:0 才能看到这一跳本身，
    // 默认会跟着重定向落到登录页（200），测不到门控。Next 的 redirect() 默认发 307。
    const res = await request.get(`/audit/${SEED_LOG.id}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers().location ?? '').toContain('/login?next=');
  });

  test('已登录普通用户（非 core）访问 → 403（原地渲染，非跳转）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    const res = await page.request.get(`/audit/${SEED_LOG.id}`);
    expect(res.status()).toBe(403);
  });

  test('不存在的日志 id → 404', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.get('/audit/99999999');
    expect(res.status()).toBe(404);
  });

  test('非数字 id → 404（不是 500）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.get('/audit/abc');
    expect(res.status()).toBe(404);
  });

  test('列表页的「详情」链接可达，且渲染出日志内容（这条链接曾经 404）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/audit');

    const detailLink = page.locator(`a[href="/audit/${SEED_LOG.id}"]`);
    await expect(detailLink).toHaveCount(1);

    await detailLink.click();
    await expect(page.locator('h2')).toHaveText('操作详情');
    await expect(page.locator('.card').first()).toContainText(SEED_LOG.action);
    await expect(page.locator('.card').first()).toContainText(SEED_LOG.reason);
  });
});

test.describe('申诉链路', () => {
  test('提交申诉 → 详情页可见；同人同日志重复提交被拒', async ({ page }, testInfo) => {
    // 每个 project 用各自的日志与当事人 —— 申诉只允许当事人本人提交，
    // 且 desktop/mobile 共库，同一条日志申诉两次会撞「同人同日志只允许一条 pending」。
    const log = testInfo.project.name === 'mobile' ? SEED_LOGS.mobile : SEED_LOGS.desktop;
    const target = SEED_USERS[log.targetUser];
    await loginViaApi(page, target.username);

    const content = `E2E 申诉 ${target.username}`;
    const res = await page.request.post(`/api/audit/${log.id}/appeal`, { data: { content } });
    expect(res.status()).toBe(200);
    expect((await res.json()).code).toBe(200);

    // 同人同日志只允许一条 pending
    const dup = await page.request.post(`/api/audit/${log.id}/appeal`, {
      data: { content: '再来一条' },
    });
    expect(dup.status()).toBe(400);

    // 换成 core 去看详情页 —— 申诉必须真的落库并渲染出来（服务端真值）
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/audit/${log.id}`);
    await expect(page.locator('.list-group')).toContainText(content);
    await expect(page.locator('.list-group')).toContainText('待处理');
  });

  test('★ 非当事人提交申诉被拒（日志 id 公开，不校验即可替他人申诉）', async ({ page }) => {
    const fresh = await registerFreshUser(page, { core: true }); // 光注册是 role=user，接口要求 core
    const log = SEED_LOGS.desktop;

    const res = await page.request.post(`/api/audit/${log.id}/appeal`, {
      data: { content: `越权申诉 ${fresh.username}` },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('只能对针对自己的操作记录申诉');
  });

  test('空内容申诉被拒', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.post(`/api/audit/${SEED_LOG.id}/appeal`, {
      data: { content: '   ' },
    });
    expect(res.status()).toBe(400);
  });

  test('未登录不能提交申诉', async ({ request }) => {
    const res = await request.post(`/api/audit/${SEED_LOG.id}/appeal`, { data: { content: 'x' } });
    expect(res.status()).toBe(401);
  });
});
