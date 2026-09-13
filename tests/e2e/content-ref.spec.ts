// ─────────────────────────────────────────────────────────────────────────────
// content-ref.spec.ts —— 评论 / 聊天正文里的 `[@ ]` 内容引用 + 「从图床选择」
//
// 【为什么必须走真浏览器】服务端不渲染评论 / 聊天正文（没有 window，DOMPurify 会
// 静默降级成转义纯文本），所以「引用有没有展开」「图片有没有出来」在接口层看不出来
// —— 接口返回的 content 本来就是原文。单测（tests/unit/content-refs.test.ts）管
// 管线的白名单与安全边界，这里管「装到页面上之后还是对的」。
//
// 覆盖面：
//   · 8 位剪贴板引用 → 内联剪贴板正文（且一条消息只展开一条）
//   · 10 位图床引用 → 内联图片、点开原位放大、不新开窗口
//   · 9 位投票引用 → **刻意不展开**，保持字面量、不出投票组件
//   · 代码块里的引用不展开（要展示语法本身时写得出来）
//   · 「从图床选择」：弹出列表 → 选一张 → 变成待发附件 → 发送后带图
//
// 【造数纪律】一律用 uniqueTag 哨兵串锚定，不断言「列表里有几条」。剪贴板按需现建
// （POST /api/clipboard）；图片走 POST /api/images。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SEED_BLOG, SEED_PASSWORD, SEED_USERS } from './seed';

const BLOG_URL = `/blog/${SEED_BLOG.id}`;
const LOBBY = 'lobby';

/** 1×1 的合法 PNG —— 服务端会校验 magic bytes 且要过 sharp 压缩，必须得是真图。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 走接口传一张图，返回其 10 位 id。 */
async function uploadViaApi(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/images', {
    multipart: { file: { name: 'e2e.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(res.status(), `上传失败: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** 走接口建一条公开剪贴板，返回其 8 位 id。 */
async function createClipViaApi(request: APIRequestContext, content: string): Promise<string> {
  const res = await request.post('/api/clipboard', {
    data: { title: `e2e-${Date.now().toString(36)}`, content, publicity: true },
  });
  expect(res.status(), `建剪贴板失败: ${await res.text()}`).toBe(200);
  const json = (await res.json()) as { id?: string; clip?: { id: string } };
  const id = json.id ?? json.clip?.id;
  expect(typeof id, '剪贴板接口没给出 id').toBe('string');
  return id!;
}

/** 按哨兵串定位评论条目（楼中楼里父级文本会包住子级，故取最内层匹配）。 */
function commentRow(page: Page, marker: string) {
  return page.locator('.comment-item', { hasText: marker }).last();
}

/** 用接口发一条评论。 */
async function postComment(page: Page, body: { content: string }) {
  const res = await page.request.post(`/api/blogs/${SEED_BLOG.id}/comments`, { data: body });
  expect(res.status(), `发评论失败: ${await res.text()}`).toBe(200);
}

async function loginAs(page: Page, username: string) {
  const res = await page.request.post('/api/auth/login', {
    data: { username, password: SEED_PASSWORD },
  });
  expect(res.status()).toBe(200);
}

test.describe('评论区的内容引用', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SEED_USERS.core.username);
  });

  test('★ 10 位图床引用：渲染成内联图片，点开原位放大且不新开窗口', async ({ page }) => {
    const marker = `e2e-refimg-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);
    await postComment(page, { content: `${marker} 看图 [@${imageId}]` });

    let newPages = 0;
    page.context().on('page', () => {
      newPages += 1;
    });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();

    const inline = row.locator('.comment-content__md img');
    await expect(inline).toHaveCount(1);
    // ★ 必须是站内图床地址 —— 若实现改成放开 img 白名单，外链图也会进来
    await expect(inline).toHaveAttribute('src', `/api/images/${imageId}/raw`);
    // 字面量不该残留
    await expect(row.locator('.comment-content')).not.toContainText('[@');

    await inline.click();
    const overlay = page.locator('.chat-lightbox');
    await expect(overlay).toBeVisible();
    // 注意这里是**属性值比较**用 contains：放大层拿到的是 DOM 的 .src（浏览器解析成
    // 绝对地址），而内联 img 的 src 属性是相对路径 —— 两者指向同一个资源。
    await expect(overlay.locator('img')).toHaveAttribute(
      'src',
      new RegExp(`/api/images/${imageId}/raw$`)
    );
    expect(newPages, '点内联图不应新开窗口').toBe(0);

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('★ 8 位剪贴板引用：正文被内联；一条评论只展开一条', async ({ page }) => {
    const marker = `e2e-refclip-${Date.now().toString(36)}`;
    const clipId = await createClipViaApi(page.request, '剪贴板里的**正文**');
    const otherId = await createClipViaApi(page.request, '第二条不该出现');
    await postComment(page, { content: `${marker} [@${clipId}] 后面 [@${otherId}]` });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();

    // 第一条展开成了 Markdown（**加粗** 被渲染）
    await expect(row.locator('.comment-content__md strong')).toHaveText('正文');
    // 第二条原样保留字面量，且它的正文没被拉进来
    await expect(row.locator('.comment-content')).toContainText(`[@${otherId}]`);
    await expect(row.locator('.comment-content')).not.toContainText('第二条不该出现');
  });

  test('★ 9 位投票引用不展开（保持字面量、不出投票组件）', async ({ page }) => {
    const marker = `e2e-refvote-${Date.now().toString(36)}`;
    const voteId = 'vOtE12345';
    await postComment(page, { content: `${marker} [@${voteId}]` });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.comment-content')).toContainText(`[@${voteId}]`);
    await expect(row.locator('.vote-embed')).toHaveCount(0);
    await expect(row.locator('.comment-content__md img')).toHaveCount(0);
  });

  test('代码块里的引用不展开（用户要能展示这个语法本身）', async ({ page }) => {
    const marker = `e2e-refcode-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);
    await postComment(page, { content: `${marker}\n\n\`\`\`\n[@${imageId}]\n\`\`\`` });

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.comment-content__md img')).toHaveCount(0);
    await expect(row.locator('.comment-content')).toContainText(`[@${imageId}]`);
  });
});

test.describe('从图床选择（评论输入区）', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SEED_USERS.core.username);
  });

  test('★ 弹出图床列表 → 选一张 → 变成待发附件 → 发送后评论带图', async ({ page }) => {
    const marker = `e2e-picker-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);

    await page.goto(BLOG_URL);
    const composer = page.locator('.comment-composer').first();
    await composer.getByRole('button', { name: '从图床选择' }).click();

    // ⚠️ 弹窗必须真的可见：展开类写成 Bootstrap 的 show / 站内 modal 的 is-open
    // 而 .modal-overlay 认的是 show 时，弹窗恒为 display:none —— 用户那边就是
    // 「点了没反应」，而接口与单测全都正常。comment-rich.spec.ts 记过同一个坑。
    const modal = page.locator('.image-picker-modal');
    await expect(modal).toBeVisible();

    // 刚传的那张就在列表里（定位到它自己的缩略图，不断言「有几张」）
    const card = modal.locator(`.image-picker-card:has(img[src="/api/images/${imageId}/raw"])`);
    await expect(card).toBeVisible();
    await card.click();

    await expect(modal, '选完应当自动收起').toHaveCount(0);
    // 待发附件条出现（与「上传图片」落在同一个状态上）
    await expect(composer.locator('.comment-composer__image img')).toHaveAttribute(
      'src',
      `/api/images/${imageId}/raw`
    );

    await composer.locator('.comment-composer__input').fill(marker);
    await composer.locator('.comment-composer__send').click();

    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.comment-image')).toHaveAttribute(
      'src',
      `/api/images/${imageId}/raw`
    );
  });
});

test.describe('聊天区的内容引用', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SEED_USERS.core.username);
  });

  /** 按哨兵串定位消息行（回复引用块里也会出现原文，必须限定在正文内匹配）。 */
  function msgRow(page: Page, marker: string) {
    return page.locator('.chat-msg', {
      has: page.locator('.chat-msg__content', { hasText: marker }),
    });
  }

  test('★ 10 位图床引用内联成图片，8 位剪贴板引用内联成正文', async ({ page }) => {
    const marker = `e2e-chatref-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);
    const clipId = await createClipViaApi(page.request, '聊天里的剪贴板正文');

    const posted = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
      data: { content: `${marker} 图 [@${imageId}] 文 [@${clipId}]` },
    });
    expect(posted.status()).toBe(200);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const inline = row.locator('.chat-msg__md img');
    await expect(inline).toHaveCount(1);
    await expect(inline).toHaveAttribute('src', `/api/images/${imageId}/raw`);

    // 剪贴板正文被内联进来了
    await expect(row.locator('.chat-msg__content')).toContainText('聊天里的剪贴板正文');
    await expect(row.locator('.chat-msg__content')).not.toContainText('[@');
  });

  test('★ 9 位投票引用不展开（聊天正文里没有投票组件）', async ({ page }) => {
    const marker = `e2e-chatvote-${Date.now().toString(36)}`;
    const voteId = 'vOtE12345';
    const posted = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
      data: { content: `${marker} [@${voteId}]` },
    });
    expect(posted.status()).toBe(200);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.chat-msg__content')).toContainText(`[@${voteId}]`);
    await expect(row.locator('.vote-embed')).toHaveCount(0);
  });

  test('★ 从图床选择：选一张已有的图发出去', async ({ page }) => {
    const marker = `e2e-chatpicker-${Date.now().toString(36)}`;
    const imageId = await uploadViaApi(page.request);

    await page.goto(`/chat?channel=${LOBBY}`);
    const composer = page.locator('.chat-composer');
    await composer.getByRole('button', { name: '从图床选择' }).click();

    const modal = page.locator('.image-picker-modal');
    await expect(modal).toBeVisible();
    const card = modal.locator(`.image-picker-card:has(img[src="/api/images/${imageId}/raw"])`);
    await expect(card).toBeVisible();
    await card.click();

    await expect(modal).toHaveCount(0);
    await expect(composer.locator('.chat-composer__image img')).toHaveAttribute(
      'src',
      `/api/images/${imageId}/raw`
    );

    await composer.locator('.chat-composer__input').fill(marker);
    await composer.locator('.chat-composer__send').click();

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('.chat-msg__image')).toHaveAttribute(
      'src',
      `/api/images/${imageId}/raw`
    );
  });

  test('★ 字数上限提示是 5000（与常量同源，不是硬编码的旧值）', async ({ page }) => {
    await page.goto(`/chat?channel=${LOBBY}`);
    const hint = page.locator('.chat-composer__hint');
    await expect(hint).toContainText('最多5000字');
    // 键盘说明不该被字数提示顶掉（footerSlot 曾经是整体替换）
    await expect(hint).toContainText('Enter');
  });
});
