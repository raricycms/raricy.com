// ─────────────────────────────────────────────────────────────────────────────
// likers-feeders.spec.ts —— 点赞者 / 投喂者列表端点
//
// 【为什么必须是 E2E】这两个端点原本根本不存在：前端 FeedButton 一直在请求
// /api/blogs/:id/likers 和 /feeders，Next 侧却没有对应路由文件 —— 点开弹窗必然 404。
// 这种「前端调的地址后端没有」的错，tsc 不管、单测不管（单测直接 import service
// 函数，压根不经过路由），只有真的发一次 HTTP 才暴露。故在此钉死路由确实可达。
//
// 权限也一并钉：这两个列表只对作者本人和管理员开放（与 Flask 一致）——
// 谁给你点了赞属于作者的信息，不该对所有登录用户公开。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_BLOG, SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

const ENDPOINTS = ['likers', 'feeders'] as const;

for (const ep of ENDPOINTS) {
  test(`/api/blogs/:id/${ep} 未登录 → 401`, async ({ request }) => {
    const res = await request.get(`/api/blogs/${SEED_BLOG.id}/${ep}`);
    expect(res.status()).toBe(401);
  });

  test(`/api/blogs/:id/${ep} 作者本人 → 200（路由存在，不是 404）`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username); // core 是种子文章的作者
    const res = await page.request.get(`/api/blogs/${SEED_BLOG.id}/${ep}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(200);
    expect(body.total).toBe(0); // 种子数据没造赞/投喂
    expect(Array.isArray(ep === 'likers' ? body.users : body.feeders)).toBe(true);
  });

  test(`/api/blogs/:id/${ep} 管理员 → 200`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get(`/api/blogs/${SEED_BLOG.id}/${ep}`);
    expect(res.status()).toBe(200);
  });

  test(`/api/blogs/:id/${ep} 非作者非管理员 → 403（不是谁登录都能看）`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.plain.username);
    const res = await page.request.get(`/api/blogs/${SEED_BLOG.id}/${ep}`);
    expect(res.status()).toBe(403);
  });

  test(`/api/blogs/:id/${ep} 文章不存在 → 404`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    const res = await page.request.get(`/api/blogs/no-such-blog/${ep}`);
    expect(res.status()).toBe(404);
  });
}
