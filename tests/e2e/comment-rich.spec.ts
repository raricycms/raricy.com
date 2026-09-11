// ─────────────────────────────────────────────────────────────────────────────
// comment-rich.spec.ts —— 评论区的富文本输入系统（对齐聊天区）
//
// 覆盖四件事：
//   · Markdown 真的渲染了（服务端只存原文，渲染发生在浏览器）
//   · 渲染是**净化后**的（XSS 向量不落地，但原文可见）
//   · 图床图片附件能引用、能点开放大
//   · 引用博客能出卡片、指向被引用的那篇
//
// 【为什么这些必须走真浏览器】服务端不渲染评论正文（没有 window，DOMPurify 会静默
// 降级成转义纯文本），所以「Markdown 有没有生效」「XSS 有没有被挡住」在接口层看不出来
// —— 接口返回的 content 本来就是原文。单测（tests/unit/comment-markdown.test.ts）
// 管管线的白名单，这里管「装到页面上之后还是对的」。
//
// 【造数纪律】评论按天限频（1200/天/用户），远够用；图片上传 75/小时，本文件每次
// 只传 1 张。用种子号 core —— 它能评论（canComment 要求 core+）。
// 断言一律用 uniqueTag 哨兵串锚定，不断言「评论区里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SEED_BLOG, SEED_BLOG2, SEED_USERS } from './seed';

const BLOG_URL = `/blog/${SEED_BLOG.id}`;

/** 1×1 的合法 PNG —— 服务端校验 magic bytes 且要过 sharp 压缩，必须得是真图。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 用 API 发一条评论。
 *
 * 刻意走接口而不是填表单：这些用例要验的是**渲染与附件**，不是输入区本身
 * （输入区的交互由最后一组用例覆盖）。走接口也让每条用例只依赖自己想验的那一环。
 */
async function postComment(
  page: Page,
  body: { content?: string; image_id?: string; quote_blog_id?: string; parent_id?: string }
) {
  const res = await page.request.post(`/api/blogs/${SEED_BLOG.id}/comments`, { data: body });
  expect(res.status(), `发评论失败: ${await res.text()}`).toBe(200);
  const json = (await res.json()) as { code: number; comment?: { id: string } };
  expect(json.code).toBe(200);
  return json.comment!.id;
}

async function uploadViaApi(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/images', {
    multipart: { file: { name: 'e2e.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(res.status(), `上传失败: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** 按哨兵串定位评论条目 —— 楼中楼里父级文本会包住子级，所以用最内层匹配。 */
function commentRow(page: Page, marker: string) {
  return page.locator('.comment-item', { hasText: marker }).last();
}

test.describe('评论富文本', () => {
  test.beforeEach(async ({ page }) => {
    // 通过表单登录会顺带验证 cookie 链路；这里只是前置条件，用 API 更快
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);
  });

  test('Markdown 真的渲染了（服务端只存原文，渲染在浏览器）', async ({ page }) => {
    const marker = `e2e-md-${Date.now().toString(36)}`;
    await postComment(page, {
      content: `${marker} **加粗** \`行内码\`\n\n- 甲\n- 乙`,
    });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();

    // ★ 关键断言：源文件里的 ** 必须已经变成 <strong> —— 如果渲染管线没跑，
    // 页面上会原样显示两个星号，而接口状态完全正常（服务端不渲染）。
    await expect(row.locator('.comment-content__md strong')).toHaveText('加粗');
    await expect(row.locator('.comment-content__md code')).toHaveText('行内码');
    await expect(row.locator('.comment-content__md li')).toHaveCount(2);
    await expect(row.locator('.comment-content')).not.toContainText('**加粗**');
  });

  test('★ 存储型 XSS 不落地：原始 HTML 被当文本，但用户看得见自己写了什么', async ({ page }) => {
    const marker = `e2e-xss-${Date.now().toString(36)}`;
    // 两个向量：直接注入 <img onerror>，以及经 marked 裸文本通道的畸形标签
    await postComment(page, {
      content: `${marker} <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>`,
    });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();

    // 页面里不该有任何由评论注入的 img / script
    await expect(row.locator('.comment-content__md img')).toHaveCount(0);
    await expect(row.locator('.comment-content__md script')).toHaveCount(0);
    // 也没有任何一个真的执行了
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    // 原文以转义文本形式保留（不静默吞内容）
    await expect(row.locator('.comment-content')).toContainText('<img src=x onerror=');
  });

  test('图床图片附件：出图、点开原位放大、不新开窗口', async ({ page }) => {
    const marker = `e2e-img-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);
    await postComment(page, { content: marker, image_id: imageId });

    let newPages = 0;
    page.context().on('page', () => {
      newPages += 1;
    });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    const thumb = row.locator('.comment-image');
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveAttribute('src', `/api/images/${imageId}/raw`);

    await thumb.click();
    const overlay = page.locator('.chat-lightbox');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('img')).toHaveAttribute('src', `/api/images/${imageId}/raw`);
    expect(newPages, '点图片不应新开窗口').toBe(0);

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('引用博客：出卡片且指向被引用的那篇（不是当前这篇）', async ({ page }) => {
    const marker = `e2e-quote-${Date.now().toString(36)}`;
    await postComment(page, { content: marker, quote_blog_id: SEED_BLOG2.id });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    const card = row.locator('.comment-blog');
    await expect(card).toBeVisible();
    // ★ 指向被引用的 SEED_BLOG2 —— 若误存成「评论所属文章」，这里会变成当前页
    await expect(card).toHaveAttribute('href', `/blog/${SEED_BLOG2.id}`);
    await expect(card.locator('.comment-blog__title')).toHaveText(SEED_BLOG2.title);
  });
});

test.describe('评论输入区（与聊天同源的 RichComposer）', () => {
  test('输入区具备 Markdown 工具条与提交按钮；空内容提交被拦下', async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);

    await page.goto(BLOG_URL);
    const composer = page.locator('.comment-composer').first();
    await expect(composer).toBeVisible();
    // 与聊天同一套结构（只是 BEM 前缀不同）：工具条两个按钮 + 文本域 + 提交
    await expect(composer.locator('.comment-composer__input')).toBeVisible();
    await expect(composer.locator('.comment-composer__send')).toBeVisible();
    await expect(composer.locator('.comment-composer__icon-btn')).toHaveCount(2);

    // 空内容点提交 → 只弹提示，不发请求（评论区条数不变）
    const before = await page.locator('.comment-item').count();
    await composer.locator('.comment-composer__send').click();
    await page.waitForTimeout(300);
    expect(await page.locator('.comment-item').count()).toBe(before);
  });

  test('走输入区真的能发出一条 Markdown 评论', async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);

    const marker = `e2e-ui-${Date.now().toString(36)}`;
    await page.goto(BLOG_URL);
    const composer = page.locator('.comment-composer').first();
    await composer.locator('.comment-composer__input').fill(`${marker} **来自输入区**`);
    await composer.locator('.comment-composer__send').click();

    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.comment-content__md strong')).toHaveText('来自输入区');
  });
});
