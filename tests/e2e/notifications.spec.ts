// ─────────────────────────────────────────────────────────────────────────────
// notifications.spec.ts —— 通知列表翻页
//
// 【防的回归】「不管点第几页都是第一页」。
//
// 服务端翻页一直是对的：URL 变了、SSR 也老老实实吐了第 2 页的数据、分页组件上
// 高亮的那一页还会跟着移到 2。坏在客户端 —— NotificationItems 用
// `useState(initial)` 持有列表，而 `<Link href="?page=2">` 是同路由软导航，
// 组件**不会重挂载**，新 props 进不了 state，列表于是永远停在第一页。
//
// 这类失效只有真点才看得见：断言 URL（变了）、断言服务端 HTML（对的）、
// 断言接口返回值（也对的）全都发现不了。所以用例必须点链接、看 DOM。
//
// 【造数纪律】用专属账号 SEED_USERS.notif（25 条通知，见 global-setup）——
// 别借 core 号：其他 spec 按「当前身份收到的条数」断言，塞 25 条进去会互相绊到。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS, SEED_NOTIF_COUNT, notifDetail } from './seed';

// 每页 20 条，对齐 notification-service 的 DEFAULT_PER_PAGE
const PER_PAGE = 20;
const TOTAL_PAGES = Math.ceil(SEED_NOTIF_COUNT / PER_PAGE);

test.beforeEach(async ({ page }) => {
  await loginViaApi(page, SEED_USERS.notif.username);
});

test('通知列表翻页真的换一页内容', async ({ page }) => {
  await page.goto('/notifications');

  const cards = page.locator('.notification-card');
  // 分页组件只在 pages > 1 时渲染 —— 造数不够时这里先挂，比后面「找不到链接」
  // 那种含糊的报错好定位
  await expect(page.locator('nav.pagination')).toBeVisible();
  await expect(cards).toHaveCount(PER_PAGE);

  // 第 0 条最新 → 第 1 页首条；第 24 条最旧 → 第 2 页末条（timestamp 逐条错开）
  await expect(page.getByText(notifDetail(0))).toBeVisible();
  await expect(page.getByText(notifDetail(SEED_NOTIF_COUNT - 1))).toHaveCount(0);

  await page.locator('nav.pagination a.page-link', { hasText: /^2$/ }).click();

  await expect(page).toHaveURL(/page=2/);
  // 关键断言：内容真的换了。只断言 URL 会把 bug 原样放过 —— 旧实现下 URL
  // 照变不误，列表却纹丝不动。
  await expect(
    page.getByText(notifDetail(SEED_NOTIF_COUNT - 1)),
    '翻到第 2 页后内容没变 —— 列表被客户端 state 钉在了第一页'
  ).toBeVisible();
  await expect(page.getByText(notifDetail(0)), '第 1 页的内容不该还留在第 2 页').toHaveCount(0);
  await expect(cards).toHaveCount(SEED_NOTIF_COUNT - PER_PAGE * (TOTAL_PAGES - 1));

  // 翻回第 1 页同样要换回来（单向修好不算修好）
  await page.locator('nav.pagination a.page-link', { hasText: /^1$/ }).click();
  await expect(page.getByText(notifDetail(0))).toBeVisible();
  await expect(page.getByText(notifDetail(SEED_NOTIF_COUNT - 1))).toHaveCount(0);
});
