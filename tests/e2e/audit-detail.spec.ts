// ─────────────────────────────────────────────────────────────────────────────
// audit-detail.spec.ts —— 操作详情页 + 申诉提交
//
// 【为什么必须是 E2E】这个页面此前根本不存在：/audit 列表每行的「详情」链接全部
// 404，且提交申诉的 API（/api/audit/[id]/appeal）因此成了孤儿 —— 用户没有任何
// 入口申诉，而 Flask 里可以。这类「页面缺失 / 链接断头」tsc 不管、单测也不管
// （单测直接调 service，不经过路由与页面），只有真的走一遍 HTTP 才暴露。
//
// 【为什么申诉用例要注册新用户】desktop 与 mobile 两个 project 共用同一个库。
// 若都用种子里的 core 提交申诉，先跑的那个留下 pending，后跑的「首次提交」就会
// 撞上「同人同日志只允许一条 pending」而误红。每次注册全新用户即可彻底避开。
// 申诉 API 只要求登录（不要求 core），所以新注册的 role=user 也能提交 ——
// 只有详情**页面**需要 core。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_LOG } from './seed';
import { loginViaApi, registerFreshUser } from './helpers';

test.describe('操作详情页', () => {
  test('未登录访问 → 403（与 /audit 列表一致的门控）', async ({ request }) => {
    const res = await request.get(`/audit/${SEED_LOG.id}`);
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
  test('提交申诉 → 详情页可见；同人同日志重复提交被拒', async ({ page }) => {
    const fresh = await registerFreshUser(page, { core: true }); // 申诉是 @authenticated_required，光注册不够

    const content = `E2E 申诉 ${fresh.username}`;
    const res = await page.request.post(`/api/audit/${SEED_LOG.id}/appeal`, { data: { content } });
    expect(res.status()).toBe(200);
    expect((await res.json()).code).toBe(200);

    // 同人同日志只允许一条 pending
    const dup = await page.request.post(`/api/audit/${SEED_LOG.id}/appeal`, {
      data: { content: '再来一条' },
    });
    expect(dup.status()).toBe(400);

    // 换成 core 去看详情页 —— 申诉必须真的落库并渲染出来（服务端真值）
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/audit/${SEED_LOG.id}`);
    await expect(page.locator('.list-group')).toContainText(content);
    await expect(page.locator('.list-group')).toContainText('待处理');
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
