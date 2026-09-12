// ─────────────────────────────────────────────────────────────────────────────
// comment-rich.spec.ts —— 评论区的富文本输入系统（对齐聊天区）
//
// 覆盖：
//   · Markdown 真的渲染了（服务端只存原文，渲染发生在浏览器）
//   · 渲染是**净化后**的（XSS 向量不落地，但原文可见）
//   · 图床图片附件能引用、能点开放大
//   · 引用博客能出卡片、指向被引用的那篇
//   · 删除的两步确认真的走得通（见文件末尾「评论删除」的说明）
//   · 点赞真的接上了界面、且 liked 随查看者而变
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

/**
 * 某条评论在接口层还看不看得见。
 *
 * 软删的叶子会被 filterDeletedLeaves 从树里摘掉，所以「消失」在接口层是可观测的；
 * 断言它以区分「真的删了」与「只是前端把它藏了」—— 后者刷新一下就回来。
 */
async function commentVisibleViaApi(page: Page, marker: string): Promise<boolean> {
  const res = await page.request.get(`/api/blogs/${SEED_BLOG.id}/comments`);
  expect(res.status()).toBe(200);
  return (await res.text()).includes(marker);
}

/**
 * 按文案定位一条 toast。
 *
 * 【为什么必须过滤而不能直接断言容器】toast 是**叠加**的（3.5s 后才自己消失），
 * 一条用例里连发两次提示时 `#toast-container .toast__body` 会同时命中两个元素 ——
 * Playwright 的严格模式直接报错，而不是取最后一个。实测踩过。
 */
function toastWith(page: Page, text: string) {
  return page.locator('#toast-container .toast__body', { hasText: text });
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

// ─────────────────────────────────────────────────────────────────────────────
// 评论点赞（本次给已有后端补上界面入口）
//
// 后端（toggleCommentLike + /api/comments/:id/like）一直都在，但前端从来没调用过。
// 这里盯的是「界面真的接上了」以及「liked 是随人而变的」——后者是最容易做错的地方：
// 服务端按 viewer 算，未登录/别人看都是 false。
// ─────────────────────────────────────────────────────────────────────────────

test.describe('评论删除', () => {
  test.beforeEach(async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);
  });

  test('★ 作者删自己的评论：确认框弹得出，确认后页面与接口双双消失', async ({ page }) => {
    const marker = `e2e-del-${Date.now().toString(36)}`;
    await postComment(page, { content: marker });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: '删除' }).click();

    // ★ 这句是本用例的重点：确认框必须真的可见。
    // 展开类写成 Bootstrap 的 `show` 而站内 modal 认的是 `is-open` 时，弹窗恒为
    // display:none —— 下面点确认会一直等一个永远点不到的按钮，用户那边就是
    // 「点删除毫无反应」。接口层完全正常，只有真点才看得见。
    const confirm = page.locator('#comment-confirm-delete-btn');
    await expect(confirm, '确认框必须真的弹出来（展开类 is-open）').toBeVisible();
    await confirm.click();

    await expect(toastWith(page, '评论已删除')).toBeVisible();
    await expect(
      page.locator('.comment-item', { hasText: marker }),
      '删掉的评论不该再留在列表里'
    ).toHaveCount(0);
    expect(await commentVisibleViaApi(page, marker), '接口层也必须消失').toBe(false);
  });

  test('管理员删他人评论：不填原因被拦下，补上原因才删得掉', async ({ page }) => {
    const marker = `e2e-del-reason-${Date.now().toString(36)}`;
    await postComment(page, { content: marker }); // 以 core 身份发出

    // 换成 admin —— 删的是**别人**的评论，故服务端要求 reason（1..500）
    const login = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.admin.username, password: 'e2e-Password-123' },
    });
    expect(login.status()).toBe(200);

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: '删除' }).click();

    const reasonBox = page.locator('#comment-delete-reason');
    await expect(reasonBox, '删他人评论必须出现原因输入框').toBeVisible();

    const confirm = page.locator('#comment-confirm-delete-btn');
    await confirm.click();
    await expect(toastWith(page, '请填写删除原因')).toBeVisible();
    // 被拦下：评论还在库里，确认框也没关（用户可以不丢上下文地补填）
    expect(await commentVisibleViaApi(page, marker), '不填原因不该删成功').toBe(true);
    await expect(confirm).toBeVisible();

    await reasonBox.fill('E2E 用例：管理员删评原因');
    await confirm.click();
    await expect(toastWith(page, '评论已删除')).toBeVisible();
    await expect(page.locator('.comment-item', { hasText: marker })).toHaveCount(0);
    expect(await commentVisibleViaApi(page, marker)).toBe(false);
  });

  test('取消确认框不会删掉评论', async ({ page }) => {
    const marker = `e2e-del-cancel-${Date.now().toString(36)}`;
    await postComment(page, { content: marker });

    await page.goto(BLOG_URL);
    await commentRow(page, marker).locator('button', { hasText: '删除' }).click();
    const confirm = page.locator('#comment-confirm-delete-btn');
    await expect(confirm).toBeVisible();

    await page.locator('#commentDeleteModal .btn-close').click();
    await expect(confirm, '关掉确认框后按钮不可见（弹窗收起）').toBeHidden();
    await expect(commentRow(page, marker), '评论仍在').toBeVisible();
    expect(await commentVisibleViaApi(page, marker)).toBe(true);
  });
});

test.describe('评论点赞', () => {
  test.beforeEach(async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);
  });

  test('点一下变已赞并 +1，再点取消', async ({ page }) => {
    const marker = `e2e-like-${Date.now().toString(36)}`;
    await postComment(page, { content: marker });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    const btn = row.locator('.comment-like');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveClass(/is-liked/);
    // 0 赞时只显示心形，不显示数字
    await expect(btn.locator('span')).toHaveCount(0);

    await btn.click();
    await expect(btn).toHaveClass(/is-liked/);
    await expect(btn.locator('span')).toHaveText('1');

    await btn.click();
    await expect(btn).not.toHaveClass(/is-liked/);
    await expect(btn.locator('span')).toHaveCount(0);
  });

  test('★ 赞过之后刷新页面仍然是已赞（liked 落到了服务端，不是纯前端状态）', async ({ page }) => {
    const marker = `e2e-like-persist-${Date.now().toString(36)}`;
    await postComment(page, { content: marker });

    await page.goto(BLOG_URL);
    await commentRow(page, marker).locator('.comment-like').click();
    await expect(commentRow(page, marker).locator('.comment-like')).toHaveClass(/is-liked/);

    await page.reload();
    const after = commentRow(page, marker).locator('.comment-like');
    await expect(after).toHaveClass(/is-liked/);
    await expect(after.locator('span')).toHaveText('1');
  });

  test('★ 别人看同一条是未赞（liked 随查看者而变）', async ({ page }) => {
    const marker = `e2e-like-viewer-${Date.now().toString(36)}`;
    await postComment(page, { content: marker });

    await page.goto(BLOG_URL);
    await commentRow(page, marker).locator('.comment-like').click();
    await expect(commentRow(page, marker).locator('.comment-like')).toHaveClass(/is-liked/);

    // 换个账号（admin 是另一个种子用户）
    await page.request.post('/api/auth/logout').catch(() => {});
    const res = await page.request.post('/api/auth/login', {
      data: { username: SEED_USERS.admin.username, password: 'e2e-Password-123' },
    });
    expect(res.status()).toBe(200);

    await page.goto(BLOG_URL);
    const other = commentRow(page, marker).locator('.comment-like');
    await expect(other, '别人看不该是已赞').not.toHaveClass(/is-liked/);
    await expect(other.locator('span'), '但计数是共享的').toHaveText('1');
  });
});
