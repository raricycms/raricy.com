// ─────────────────────────────────────────────────────────────────────────────
// reactive-render.spec.ts — ReactiveMD 的**发布 → 阅读**闭环（flag=off 的默认线上口径）
//
// 为什么这条必须在真浏览器里：静态正文由客户端组件的 `mode="static"` 做 SSR，
// 「无 JS 也有正文」「快照读得出来」「reactive 源码没有掉进旧 Markdown 解析器」
// 三件事单测都盖不住。
//
// 数据用 API 造（顺带覆盖写入闸门）：reactive 发布前必须编译成功并与快照同事务落库；
// flag=off 时阅读页应展示 reactive-static，而不是 legacy 的 Markdown 产物。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi, uniqueTag } from './helpers';

/** 合法的 1×1 PNG（服务端按 magic bytes 嗅探，且要过 sharp）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadImageViaApi(page: Page): Promise<string> {
  const res = await page.request.post('/api/images', {
    multipart: { file: { name: 'reactive.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(res.status(), `传图失败：${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function createClipViaApi(page: Page, content: string): Promise<string> {
  const res = await page.request.post('/api/clipboard', {
    data: { title: `reactive-${uniqueTag()}`, content, publicity: true },
  });
  expect(res.status(), `建剪贴板失败：${await res.text()}`).toBe(200);
  const json = (await res.json()) as { id?: string; clip?: { id: string } };
  const id = json.id ?? json.clip?.id;
  expect(typeof id).toBe('string');
  return id!;
}

async function createBlogViaApi(
  page: Page,
  options: { content: string; format: 'markdown' | 'reactive'; visibility?: string }
): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: {
      title: `reactive-${uniqueTag()}`,
      description: 'reactive e2e',
      content: options.content,
      visibility: options.visibility ?? 'internal',
      format: options.format,
    },
  });
  expect(res.status(), `发文失败：${await res.text()}`).toBe(200);
  return ((await res.json()) as { blog_id: string }).blog_id;
}

test.describe('ReactiveMD 发布与阅读', () => {
  test('reactive 发布后（flag=off）阅读页是静态正文，引用 / 脚注 / 软换行都在', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const imageId = await uploadImageViaApi(page);
    const clipId = await createClipViaApi(page, '剪贴板里的公开正文');

    const content = [
      '# Reactive 标题',
      '',
      '第一行',
      '第二行',
      '',
      '<panel title="调整">',
      '<slider bind="n" label="人数" initial="2" min="1" max="5">',
      '</panel>',
      '',
      '人数 {{ n }} 人。',
      '',
      `![图](/api/images/${imageId}/raw)`,
      '',
      `[@${clipId}]`,
      '',
      // 作者伪造的宿主标签：适配器必须转义成字面量，绝不当成真组件。
      '<site-embed kind="vote" ref="Abc123456" />',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '脚注[^1]',
      '',
      '[^1]: 脚注内容',
    ].join('\n');

    const blogId = await createBlogViaApi(page, { content, format: 'reactive' });

    await page.goto(`/blog/${blogId}`);
    const container = page.locator('#userContentContainer');
    await expect(container).toHaveAttribute('data-content-renderer', 'reactive-static');

    // 静态正文 + 静态控件值（不是输入框）
    await expect(container.locator('.md-document.local-static')).toBeVisible();
    await expect(container.locator('.local-static-value')).toHaveText('2');
    await expect(container.locator('.local-slider input')).toHaveCount(0);

    // reactive 文档保持 CommonMark 的软换行语义（不插 <br>）；软换行兼容是给
    // 「Markdown 文档走新渲染器」那一档的，不是给 reactive 源码的。
    await expect(container.locator('p br')).toHaveCount(0);
    await expect(container).toContainText('第一行');
    await expect(container).toContainText('第二行');

    // 五类引用：图片内联、公开剪贴板是链接卡片、伪造宿主标签只是文字
    await expect(container.locator(`img[src*="/api/images/${imageId}/raw"]`)).toHaveCount(1);
    await expect(container.locator(`.site-embed-clipboard[href="/clipboard/${clipId}"]`)).toHaveCount(1);
    await expect(container.locator('.vote-embed')).toHaveCount(0);
    await expect(container).toContainText('<site-embed kind="vote"');

    // 脚注可跳、代码高亮还在；reactive 源码没有以字面量漏出来
    await expect(container.locator('.local-footnote-ref a')).toHaveCount(1);
    await expect(container.locator('pre code.hljs')).toHaveCount(1);
    await expect(container).not.toContainText('{{ n }}');
    await expect(container).not.toContainText('<panel');
  });

  test('markdown 文档（flag=off）仍然走 legacy 渲染器，页面行为逐字不变', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const blogId = await createBlogViaApi(page, {
      content: '## 普通标题\n\n正文 **加粗**',
      format: 'markdown',
    });

    await page.goto(`/blog/${blogId}`);
    await expect(page.locator('[data-content-renderer="legacy"] #userContentContainer')).toHaveCount(1);
    await expect(page.locator('#userContentContainer strong')).toHaveText('加粗');
    await expect(page.locator('.md-document')).toHaveCount(0);
  });

  test('无法编译的 reactive 发布被整笔拒绝，且库里不出现半篇文章', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const before = await page.request.get('/api/blogs?limit=1');

    const res = await page.request.post('/api/blogs', {
      data: {
        title: `broken-${uniqueTag()}`,
        description: 'broken reactive',
        content: '<panel title="未闭合">',
        visibility: 'internal',
        format: 'reactive',
      },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('无法编译');

    const after = await page.request.get('/api/blogs?limit=1');
    expect(after.status()).toBe(before.status());
  });

  test('无 JS：public reactive 文章的静态正文与脚注仍可读', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // 造数要 JS 关掉之前先用另一个 context 登录（API 请求不依赖页面 JS）。
    const authorContext = await browser.newContext();
    const authorPage = await authorContext.newPage();
    await loginViaApi(authorPage, SEED_USERS.core.username);
    const blogId = await createBlogViaApi(authorPage, {
      content: '# 无 JS 标题\n\n正文段落。\n\n脚注[^1]\n\n[^1]: 脚注内容',
      format: 'reactive',
      visibility: 'public',
    });
    await authorContext.close();

    await page.goto(`/blog/${blogId}`);
    const container = page.locator('#userContentContainer');
    await expect(container).toHaveAttribute('data-content-renderer', 'reactive-static');
    await expect(container.locator('h1')).toContainText('无 JS 标题');
    await expect(container.locator('.local-footnote-ref a')).toHaveCount(1);
    await expect(container).toContainText('正文段落。');
    await context.close();
  });
});

test.describe('ReactiveMD 编辑器预览', () => {
  test('reactive 格式的预览走 ReactivePreview（组件可交互、无编译错误）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/blog/upload');
    await page.selectOption('#format', 'reactive');

    await page.locator('#editor .cm-content').click();
    // 一次性插入整篇：逐行 `type` 会触发 CM6 的标签自动闭合，凭空多出 `</slider>`，
    // 而 ReactiveMD 的控件是自闭合标签 —— 那份源码会直接编译失败。
    await page.keyboard.insertText(
      [
        '# 预览标题',
        '',
        '<panel title="调整">',
        '<slider bind="n" label="人数" initial="2" min="1" max="5">',
        '</panel>',
        '',
        '人数 {{ n }} 人。',
      ].join('\n')
    );

    await page.locator('.md-editor__mode', { hasText: '预览' }).click();
    const preview = page.locator('.md-editor__preview-body');

    await expect(preview.locator('.reactive-preview .md-document')).toBeVisible({
      timeout: 20_000,
    });
    // preview 是交互模式：原生控件在，但站点嵌入组件（这里没有）会按只读态渲染。
    await expect(preview.locator('.local-slider input')).toHaveCount(1);
    await expect(preview.locator('.reactive-preview__errors')).toHaveCount(0);
    await expect(preview).not.toContainText('{{ n }}');
  });
});
