import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS, SEED_BLOG, BLOG_BODY_MARKER } from './seed';

// 本地草稿与「提交读到的是最新正文」。
//
// 【为什么要 E2E】草稿的每条失败模式都是**时序**，而且全都不报错：
//   · 发布成功后清草稿的顺序写反 → 待写的定时器把刚发出去的正文写回 localStorage，
//     用户下次进新建页看到一篇已经发布过的旧文；
//   · 提交时读的是**预览**用的防抖状态而不是编辑器里的最新原文 → 最后几个字丢掉；
//   · 编辑态误读新建草稿 → 上个月那篇半成品把正在编辑的已发布文章盖上。
// 这三条只有真打字、真提交、真跳转才暴露得出来（单测只覆盖了 DraftStore 本身）。
//
// 【两个键名沿用 Vditor 时代】`blog-upload-editor` / `clipboard-upload-editor`，
// 且存的都是 Markdown 原文 —— 换名字等于用户上一版留下的草稿静默消失。

const BLOG_DRAFT_KEY = 'blog-upload-editor';
const CLIP_DRAFT_KEY = 'clipboard-upload-editor';

/** 读草稿键的当前值（没有草稿 → null）。 */
function draftOf(page: Page, key: string) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

/** 直连接口建一篇云剪贴板（要编辑态就得先有一篇）。 */
async function createClip(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/clipboard', {
    data: { title, content: '编辑态起点', publicity: true },
  });
  const body = (await res.json()) as { code?: number; id?: string; message?: string };
  expect(body.code, `建剪贴板失败：${JSON.stringify(body)}`).toBe(200);
  return body.id as string;
}

/** 在编辑区里追加一段文字：点进正文 → 到末尾 → 输入。 */
async function appendToEditor(page: Page, editor: string, text: string) {
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

test.describe('博客本地草稿', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  test('新建页：打的字会落进本地草稿，刷新后自动恢复', async ({ page }) => {
    await page.goto('/blog/upload');
    await appendToEditor(page, '#editor', 'e2e 草稿正文');

    // 防抖 500ms 之后才落盘
    await expect.poll(() => draftOf(page, BLOG_DRAFT_KEY), { timeout: 5000 }).toBe('e2e 草稿正文');

    await page.reload();
    // 新建页没有服务端初值，恢复草稿**不问**（这是绝大多数情况），也没有横幅
    await expect(page.locator('#editor .md-editor__draft-banner')).toHaveCount(0);
    await page.locator('#editor').getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#editor .md-editor__preview-body')).toContainText('e2e 草稿正文');
  });

  test('新建页：提交走的是编辑器里的最新原文，发布成功后草稿不再复活', async ({ page }) => {
    await page.goto('/blog/upload');
    await appendToEditor(page, '#editor', '草稿哨兵 E2E-DRAFT-SENTINEL');

    // 不等到防抖落盘就直接提交：这一步同时验证「提交读的是编辑器原文，
    // 不是预览那份防抖状态」——读错了这里提交的正文就是空的，会被必填校验拦下
    await page.fill('#title', `草稿用例-${Date.now().toString(36)}`);
    await page.fill('#description', 'e2e 草稿用例');
    await page.selectOption('#category', { index: 1 });

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/blogs') && r.request().method() === 'POST'
    );
    await page.click('#blogForm button[type=submit]');
    const res = await created;
    expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
    const { blog_id: blogId } = (await res.json()) as { blog_id: string };
    expect(blogId).toBeTruthy();

    // 提交的正文真的是刚打的那一份
    const sent = JSON.parse(res.request().postData() ?? '{}') as { content?: string };
    expect(sent.content, '提交的正文必须是编辑器里的最新原文').toContain('E2E-DRAFT-SENTINEL');

    // 成功那一刻草稿就该没了
    await expect.poll(() => draftOf(page, BLOG_DRAFT_KEY), { timeout: 5000 }).toBeNull();

    // 再等过跳转（新建成功后停 1.5 秒才跳）—— 若清草稿只是「删键」而没停掉
    // 待写的定时器，这一段等待里它会把正文写回来
    await page.waitForURL(new RegExp(`/blog/${blogId}$`), { timeout: 15_000 });
    await page.waitForTimeout(2500);
    expect(await draftOf(page, BLOG_DRAFT_KEY), '发布成功后草稿复活了').toBeNull();
  });

  /**
   * 请求在飞时继续键入 —— 那一段**没被发出去**，所以它必须落进草稿、
   * 而不能被「刚保存成功」这件事当成已保存清掉。
   *
   * 造法：拦下 POST 并**按住不放**，等用户打完第二段再放行。不按住的话请求
   * 几百毫秒就回来了，根本没有「在飞」这个窗口 —— 用例会恒绿，测不到东西。
   */
  test('新建页：请求在飞时继续键入，那一段留在草稿里而不是被当成已保存', async ({ page }) => {
    await page.goto('/blog/upload');
    await appendToEditor(page, '#editor', 'E2E-SENT-ONE');
    await page.fill('#title', `竞态-${Date.now().toString(36)}`);
    await page.fill('#description', 'e2e 竞态用例');
    await page.selectOption('#category', { index: 1 });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/blogs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      await route.continue();
    });

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/blogs') && r.request().method() === 'POST'
    );
    await page.click('#blogForm button[type=submit]');
    // 等请求真的发出去（被 gate 按住），再打第二段
    await page.waitForTimeout(400);
    await appendToEditor(page, '#editor', ' E2E-SENT-TWO');
    release();

    const res = await created;
    expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
    const sent = JSON.parse(res.request().postData() ?? '{}') as { content?: string };
    // ① 发出去的只有按提交那一刻那一份
    expect(sent.content).toContain('E2E-SENT-ONE');
    expect(sent.content, '在飞时打的字不该出现在这一次的请求里').not.toContain('E2E-SENT-TWO');

    // ② 那一段得留下并如实说明 —— 发绿字的同时把草稿清掉，用户以为存好了，实际丢了
    await expect(page.locator('#toast-container')).toContainText('已留在本地草稿里');
    await expect.poll(() => draftOf(page, BLOG_DRAFT_KEY), { timeout: 10_000 }).toContain(
      'E2E-SENT-TWO'
    );
  });

  test('编辑态不读新建草稿：上个月的半成品不会盖掉正在编辑的文章', async ({ page }) => {
    // 先在站内留下一个「新建到一半」的草稿
    await page.goto('/');
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [BLOG_DRAFT_KEY, '半成品草稿 E2E-DRAFT-MUST-NOT-SHOW'] as const
    );

    await page.goto(`/blog/${SEED_BLOG.id}/edit`);
    await expect(page.locator('#editor .md-toolbar')).toBeVisible();
    await expect(page.locator('#editor .md-editor__draft-banner')).toHaveCount(0);

    await page.locator('#editor').getByRole('button', { name: '预览', exact: true }).click();
    const preview = page.locator('#editor .md-editor__preview-body');
    await expect(preview).toContainText(BLOG_BODY_MARKER);
    await expect(preview).not.toContainText('E2E-DRAFT-MUST-NOT-SHOW');
  });
});

test.describe('云剪贴板保存与草稿', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  test('新建页：Ctrl+S 保存最新正文并清草稿，接着写仍会攒新草稿', async ({ page }) => {
    await page.goto('/clipboard/upload');
    await page.fill('#title', `剪贴板草稿-${Date.now().toString(36)}`);
    await appendToEditor(page, '#clipboard-editor', '第一段 E2E-CLIP-ONE');

    await expect.poll(() => draftOf(page, CLIP_DRAFT_KEY), { timeout: 5000 }).toContain(
      'E2E-CLIP-ONE'
    );

    // Ctrl+S 是**表单**那一层监听的（CM6 的 keymap 刻意不绑，两边都绑会存两篇）
    let posted = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/clipboard') && r.method() === 'POST') posted += 1;
    });
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/clipboard') && r.request().method() === 'POST'
    );
    await page.keyboard.press('Control+s');
    const res = await saved;
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ code: 200 });
    await expect(page.locator('#toast-container .toast__body')).toContainText('保存成功');

    // 存的确实是最新原文，不是预览那份防抖状态
    const sent = JSON.parse(res.request().postData() ?? '{}') as { content?: string };
    expect(sent.content).toContain('E2E-CLIP-ONE');

    // 而且**只存了一篇**：一次按键若两个监听器都跑，这里会是两次请求。
    // 等一小会儿再数 —— 第二次请求可能比第一次晚一拍。
    await page.waitForTimeout(600);
    expect(posted, '一次 Ctrl+S 只能发一次保存请求').toBe(1);

    await expect.poll(() => draftOf(page, CLIP_DRAFT_KEY), { timeout: 5000 }).toBeNull();

    // 清完接着写仍会攒新草稿（保存后并不离开页面，这是新建页的主路径）
    await appendToEditor(page, '#clipboard-editor', ' 第二段 E2E-CLIP-TWO');
    await expect.poll(() => draftOf(page, CLIP_DRAFT_KEY), { timeout: 5000 }).toContain(
      'E2E-CLIP-TWO'
    );
  });

  test('提交失败不清草稿（内容还在本地留着）', async ({ page }) => {
    await page.goto('/clipboard/upload');
    await appendToEditor(page, '#clipboard-editor', 'E2E-CLIP-KEEP');

    // 用一个「前端自己就拦得下」的失败：标题超长。**不要用「标题留空」**——
    // 那个 input 带 `required`，浏览器会在 submit 之前就拦下，React 的 onSubmit
    // 根本不会跑，于是既没有提示、也没有请求，用例只会看起来「什么都没发生」。
    await page.fill('#title', 'x'.repeat(31));
    let posted = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/clipboard') && r.method() === 'POST') posted += 1;
    });
    await page.locator('#uploadForm button[type=submit]').click();
    await expect(page.locator('#toast-container .toast__body')).toContainText('不能超过30个字符');
    expect(posted).toBe(0);

    // 失败之后草稿必须还在 —— 这时它正是「内容没丢」的唯一凭据
    await expect.poll(() => draftOf(page, CLIP_DRAFT_KEY), { timeout: 5000 }).toContain(
      'E2E-CLIP-KEEP'
    );
  });

  test('新建页：Ctrl+S 在飞时继续键入，那一段留在草稿里并如实提示', async ({ page }) => {
    await page.goto('/clipboard/upload');
    await page.fill('#title', `剪贴板竞态-${Date.now().toString(36)}`);
    await appendToEditor(page, '#clipboard-editor', 'E2E-CLIP-SENT-ONE');

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/clipboard', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      await route.continue();
    });

    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/clipboard') && r.request().method() === 'POST'
    );
    await page.keyboard.press('Control+s');
    // 请求已被按住 —— 现在打的字**没进这一次的正文**
    await page.waitForTimeout(400);
    await appendToEditor(page, '#clipboard-editor', ' E2E-CLIP-SENT-TWO');
    release();

    const res = await saved;
    expect(res.status()).toBe(200);
    const sent = JSON.parse(res.request().postData() ?? '{}') as { content?: string };
    expect(sent.content).toContain('E2E-CLIP-SENT-ONE');
    expect(sent.content, '在飞时打的字不该出现在这一次的请求里').not.toContain(
      'E2E-CLIP-SENT-TWO'
    );

    // 绿字说的只是「刚才那一份存下来了」，不能把之后敲的一并说成已保存；那一段必须留在草稿里
    await expect(page.locator('#toast-container')).toContainText('之后的改动还在本地草稿里');
    await expect.poll(() => draftOf(page, CLIP_DRAFT_KEY), { timeout: 5000 }).toContain(
      'E2E-CLIP-SENT-TWO'
    );
  });

  /**
   * 「停顿自动保存」是编辑态独有的：新建页靠草稿 + Ctrl+S，编辑页没有草稿键，
   * 勾上这个开关才有人替你按保存。它每分钟才响一次 —— 用真等，不上 page.clock
   * （替换 Date 与定时器会和 Next 水合、CM6 的测量循环搅在一起，风险大于收益）。
   *
   * 【为什么非要有这条】它唯一的失败方式是**静默的**：定时器跑起来了、请求也发了，
   * 但存的是别的东西（空正文 / 编辑器起不来时的兜底 textarea / 上一版内容）。
   * 这里断言的是「存上去的是**此刻**编辑器里的正文」，也就是这个功能存在的理由。
   */
  test('编辑态：勾上「自动保存」后，停手一分钟会把最新正文存上去', async ({ page }) => {
    test.setTimeout(120_000);
    const id = await createClip(page, `自动保存-${Date.now().toString(36)}`);
    await page.goto(`/clipboard/${id}/edit`);
    await expect(page.locator('#clipboard-editor .md-toolbar')).toBeVisible();

    await page.check('#autoSaveToggle');
    await expect(page.locator('#autoSaveToggle')).toBeChecked();
    await appendToEditor(page, '#clipboard-editor', ' E2E-AUTOSAVE-ONE');

    // 60 秒的间隔：给它 90 秒的余量（CI 上慢一些）
    const res = await page.waitForResponse(
      (r) => r.url().endsWith(`/api/clipboard/${id}`) && r.request().method() === 'PUT',
      { timeout: 90_000 }
    );
    expect(res.status()).toBe(200);
    const sent = JSON.parse(res.request().postData() ?? '{}') as { content?: string };
    expect(sent.content, '自动保存存的必须是最新正文').toContain('E2E-AUTOSAVE-ONE');
    // stayOnPage 那一支会给一句绿字（它不是偷偷存的）
    await expect(page.locator('#toast-container .toast__body')).toContainText('保存成功');
  });
});
