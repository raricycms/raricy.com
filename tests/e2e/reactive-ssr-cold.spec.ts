// ─────────────────────────────────────────────────────────────────────────────
// reactive-ssr-cold.spec.ts —— **冷启动后的第一个正文请求**，且浏览器禁用 JS
//
// 为什么单独一条：`ReactiveDocumentLazy` 是 React.lazy + Suspense fallback=null。
// 如果 SSR 只产出一层空的 Suspense 壳，普通页面在 JS 打开时会“先空后填”，
// 测试很容易把“已经预热过的页面上看见了正文”误当成静态首屏；关掉 JS 才会露馅。
//
// 判据刻意不用“响应 HTML 里含字符串”（标题 / 摘要 / RSC 载荷都可能带上它），
// 也不用“打开过一个页面再关 JS”：本 spec 只用 API 造数，绝不在无 JS 页面之前
// 导航任何页面。它必须**单独一个 playwright 调用**、在新建的 next start 上跑。
//
// 断言的是正文容器里一个只存在于**正文段落**的句子 visible（有布局、非隐藏、
// 不在标题 / 摘要里），并且它位于 `.reactive-document` 内部。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

const PARAGRAPH = `冷启动唯一正文段落-${uniqueTag()}`;

test('冷启动首请求（无 JS）：正文段落直接从 SSR 可读', async ({ request, browser }) => {
  // ── 造数只用 APIRequestContext：它不会加载任何页面 / chunk ────────────────
  const login = await request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const created = await request.post('/api/blogs', {
    data: {
      title: `冷启动标题-${uniqueTag()}`,
      description: '这段摘要不是正文，不能拿它冒充正文可读',
      content: [
        '## 冷启动小节',
        '',
        PARAGRAPH,
        '',
        '脚注[^1]',
        '',
        '[^1]: 冷启动脚注',
      ].join('\n'),
      visibility: 'public',
      format: 'markdown',
    },
  });
  expect(created.status(), `发文失败：${await created.text()}`).toBe(200);
  const { blog_id: blogId } = (await created.json()) as { blog_id: string };

  // ── 这里是该服务进程收到的第一个页面请求 ────────────────────────────────
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto(`/blog/${blogId}`);
  expect(response?.status()).toBe(200);

  const container = page.locator('#userContentContainer');
  await expect(container).toHaveAttribute('data-content-renderer', 'reactive');

  // 必须真的在正文容器里、可见、有实际尺寸。
  const paragraph = container.getByText(PARAGRAPH, { exact: false });
  await expect(paragraph).toBeVisible();
  const box = await paragraph.boundingBox();
  expect(box, '正文段落没有布局盒（可能只是隐藏的 Suspense 壳）').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // 它是 .reactive-document 的正文，不是页面标题 / 摘要。
  await expect(container.locator('.reactive-document').getByText(PARAGRAPH, { exact: false })).toBeVisible();
  await expect(page.locator('h1')).not.toContainText(PARAGRAPH);
  await expect(page.locator('meta[name="description"]')).not.toHaveAttribute('content', new RegExp(PARAGRAPH));

  // 脚注与代码/正文结构同样来自静态首屏。
  await expect(container.locator('.local-footnote-ref a')).toHaveCount(1);
  const text = await container.innerText();
  expect(text).toContain(PARAGRAPH);

  await context.close();
});
