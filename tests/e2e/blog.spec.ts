// 博客列表页与详情页的渲染。
//
// 【为什么详情页非 E2E 不可】正文是**客户端**渲染的（MarkdownRenderer = marked +
// DOMPurify + highlight.js，见 src/app/components/MarkdownRenderer.tsx）。
// 服务端只吐一个空壳 + 原始 Markdown，页面 200 且标题正确，但正文可能一个字都没渲染出来
// —— 只要 marked 加载失败、hydration 报错、或 DOMPurify 把内容清空了。
// 断言 HTTP 状态或服务端 HTML 都发现不了；必须真跑浏览器、等脚本执行完再看 DOM。

import { test, expect } from '@playwright/test';
import { SEED_USERS, SEED_BLOG, SEED_CATEGORY, BLOG_BODY_MARKER } from './seed';
import { loginViaApi } from './helpers';

// 列表/详情都在 requireCoreUser 之后，故每个用例先以 core 身份登录
test.beforeEach(async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
});

test('博客列表页渲染文章卡片与栏目侧栏', async ({ page }) => {
  const res = await page.goto('/blog');
  expect(res?.status()).toBe(200);

  const card = page.locator(`#id${SEED_BLOG.id}`);
  await expect(card).toBeVisible();
  await expect(card.locator('.blog-title')).toHaveText(SEED_BLOG.title);
  await expect(card.locator('.blog-description')).toHaveText(SEED_BLOG.description);
  // 作者名来自 listBlogs 的关联查询 —— 关联断了这里会空，而卡片本身照常显示
  await expect(card.locator('.blog-author span').first()).toHaveText(SEED_USERS.core.username);

  // 侧栏分类（seed 的栏目 excludeFromAll=false，应当出现）
  await expect(page.locator('.blog-layout')).toContainText(SEED_CATEGORY.name);
});

test('按栏目筛选命中种子文章', async ({ page }) => {
  await page.goto(`/blog?category=${SEED_CATEGORY.slug}`);
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toBeVisible();
});

test('搜索不匹配时列表为空（防「筛选条件被忽略」这类静默失效）', async ({ page }) => {
  await page.goto('/blog?search=绝不存在的关键词zzzqqq');
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toHaveCount(0);
});

test('博客详情页把 Markdown 正文渲染成 HTML', async ({ page }) => {
  const res = await page.goto(`/blog/${SEED_BLOG.id}`);
  expect(res?.status()).toBe(200);

  // 服务端直出的部分
  await expect(page.locator('.read-hero h1')).toHaveText(SEED_BLOG.title);

  // 客户端渲染的部分：哨兵串出现 = marked 真的跑完了
  await expect(page.getByText(BLOG_BODY_MARKER)).toBeVisible({ timeout: 10_000 });

  // 断言 Markdown 结构真被转成了 HTML，而不是把源码当纯文本吐出来。
  // 只断言哨兵串是不够的 —— 渲染彻底失效、原样 innerText 输出时它照样在。
  await expect(page.locator('h1', { hasText: 'E2E 标题' })).toBeVisible();
  await expect(page.locator('li', { hasText: '列表项一' })).toBeVisible();
});

test('不存在的文章 ID 返回 404', async ({ page }) => {
  const res = await page.goto('/blog/definitely-not-a-real-blog-id');
  expect(res?.status()).toBe(404);
});
