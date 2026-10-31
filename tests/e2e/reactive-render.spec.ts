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
  test('reactive 发布后阅读页默认可交互，引用 / 脚注 / 软换行都在', async ({
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
    await expect(container).toHaveAttribute('data-content-renderer', 'reactive');

    // SSR 先给静态首屏，水合后组件可操作：滑杆是真实 input，初始值 2。
    await expect(container.locator('.local-slider input')).toHaveCount(1);
    await expect(container.locator('.local-slider input')).toHaveValue('2');

    // 站点统一软换行规则：Markdown 与 Reactive 都把单换行渲染成 <br>，
    // 这样 Markdown 追加组件、format 自动升级后排版不变。
    await expect(container.locator('p br')).not.toHaveCount(0);
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

  test('markdown 文档也走统一引擎，加粗与正文正常', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const blogId = await createBlogViaApi(page, {
      content: '## 普通标题\n\n正文 **加粗**',
      format: 'markdown',
    });

    await page.goto(`/blog/${blogId}`);
    await expect(page.locator('#userContentContainer[data-content-renderer="reactive"]')).toHaveCount(1);
    await expect(page.locator('#userContentContainer strong')).toHaveText('加粗');
    await expect(page.locator('.reactive-document')).toHaveCount(1);
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
    expect(((await res.json()) as { message: string }).message).toContain('无法编译渲染');

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
    await expect(container).toHaveAttribute('data-content-renderer', 'reactive');
    await expect(container.locator('h1')).toContainText('无 JS 标题');
    await expect(container.locator('.local-footnote-ref a')).toHaveCount(1);
    await expect(container).toContainText('正文段落。');
    await context.close();
  });
});


test.describe('统一管线的兼容与保存边界', () => {
  test('有效增强语法写成 markdown → 具名 400；未知普通标签仍可保存', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const mismatch = await page.request.post('/api/blogs', {
      data: {
        title: `mismatch-${uniqueTag()}`,
        description: 'mismatch',
        content: '<counter bind="n" label="N" initial="1" />',
        visibility: 'internal',
        format: 'markdown',
      },
    });
    expect(mismatch.status()).toBe(400);
    expect((await mismatch.json()) as { error_code: string }).toMatchObject({
      error_code: 'content_format_mismatch',
    });

    const legacy = await page.request.post('/api/blogs', {
      data: {
        title: `legacy-${uniqueTag()}`,
        description: 'legacy',
        content: `<TAB>教程占位</TAB>

普通正文`,
        visibility: 'internal',
        format: 'markdown',
      },
    });
    expect(legacy.status(), await legacy.text()).toBe(200);
  });

  test('★ 普通多行 MD 追加组件后保存重开：<br> / 公式 / 引用都不变 ★', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const clipId = await createClipViaApi(page, '被引用的剪贴板正文');
    const base = [
      '第一行',
      '第二行',
      '',
      '公式 $x_1 + y_2$ 与引用 [@' + clipId + ']。',
      '',
      '[链接](https://example.com) 结束',
    ].join('\n');
    const blogId = await createBlogViaApi(page, { content: base, format: 'markdown' });

    const updated = await page.request.put(`/api/blogs/${blogId}`, {
      data: {
        title: `mixed-${uniqueTag()}`,
        description: 'mixed',
        content: `${base}

<counter bind="n" label="N" initial="1" />`,
        visibility: 'internal',
        format: 'reactive',
      },
    });
    expect(updated.status(), await updated.text()).toBe(200);

    await page.goto(`/blog/${blogId}`);
    const container = page.locator('#userContentContainer');
    await expect(container).toHaveAttribute('data-content-renderer', 'reactive');
    // 折行必须是真实 <br>，不能只看 textContent。
    await expect(container.locator('p br')).not.toHaveCount(0);
    await expect(container).toContainText('第一行');
    await expect(container).toContainText('第二行');
    await expect(container.locator('.local-math-inline, .local-math-display').first()).toBeVisible({ timeout: 15_000 });
    await expect(container.locator('.site-embed-clipboard-inline')).toContainText('被引用的剪贴板正文');
    await page.reload();
    await expect(page.locator('#userContentContainer p br')).not.toHaveCount(0);
  });

  test('历史 data 位图在真实浏览器里显示为 <img>（>8KB 也不回退源码）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';
    const padded = `${png}${'A'.repeat(9000)}`;
    const dataUrl = `data:image/png;base64,${padded.slice(0, padded.length - (padded.length % 4))}`;
    const blogId = await createBlogViaApi(page, {
      content: `前面

<img src="${dataUrl}" alt="历史位图">

后面`,
      format: 'markdown',
    });
    await page.goto(`/blog/${blogId}`);
    const image = page.locator('#userContentContainer img[alt="历史位图"]');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    const rendered = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    expect(rendered).toBeGreaterThan(0);
    await expect(page.locator('#userContentContainer')).not.toContainText('base64');
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
