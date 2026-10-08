import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser, publishBlog, uniqueTag } from './helpers';

// 「保存之后这一页归谁」——两张表单（博客 / 云剪贴板）的**跳转与并发提交**。
//
// 【为什么必须 E2E】这几条的失败方式都是**页面自己动了**，而单测里没有真的导航：
//   · 保存成功后排了一个延迟跳转，用户还在敲 —— 跳走等于把刚敲的那一段丢掉，
//     只留下一句一闪而过的提示；
//   · 前一笔的待跳转定时器在**下一笔还在飞**的时候把页面抢走 —— 第二笔的结果
//     用户根本看不到（它回来时页面已经换了）；
//   · 两笔提交叠着发 —— 新建态就是**两篇内容一样的文章 / 剪贴板**，页面只跳去其中一篇。
// 判据只能是「真点、真等、看 URL 与编辑区里的字」。
//
// 【竞态是造出来的，不是碰运气】两处用手动放行的 `page.route` 把请求**按住**，
// 让「在飞」这个窗口长到用例能插手；不按的话本机几十毫秒就回来了，用例恒绿。

const BLOG_DRAFT_KEY = 'blog-upload-editor';

/** 在编辑区末尾追加一段（真键盘，与用户敲的同一路）。 */
async function appendToEditor(page: Page, editor: string, text: string) {
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

function draftOf(page: Page, key: string) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

test.describe('博客：保存成功后这一页归谁', () => {
  test.beforeEach(async ({ page }) => {
    await registerFreshUser(page, { core: true });
  });

  test('★ 编辑态：跳转窗口里改了标题 → 不跳，改动留在页面上 ★', async ({ page }) => {
    const tag = uniqueTag();
    const id = await publishBlog(page);
    await page.goto(`/blog/${id}/edit`);
    await expect(page.locator('#editor .md-toolbar')).toBeVisible();

    await page.fill('#title', `编辑标题-${tag}-甲`);
    await appendToEditor(page, '#editor', `编辑正文-${tag}`);

    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/blogs/${id}`)
    );
    await page.click('#blogForm button[type=submit]');
    await saved;

    // ★ 就是这里 ★ 响应落地之后、那 800ms 跳转窗口**之内**再改一次标题。
    // 旧版只弹一句提示、然后照样 window.location.href —— 改的这一版随跳转一起消失。
    await page.fill('#title', `编辑标题-${tag}-乙`);
    await expect(page.locator('#toast-container'), '窗口里的改动没有被如实说出来').toContainText(
      '你又改了'
    );

    // 等过那个窗口：还留在编辑页，且输入框里仍是刚改的那一版（保住改动，不是只弹提示）
    await page.waitForTimeout(1500);
    expect(page.url(), '改了标题还是在窗口过后被跳走了').toContain(`/blog/${id}/edit`);
    await expect(page.locator('#title')).toHaveValue(`编辑标题-${tag}-乙`);
  });

  test('★ 新建态：跳转窗口里改了正文 → 不跳，正文留在编辑区与本地草稿里；再提交走 PUT 那一篇 ★', async ({
    page,
  }) => {
    const tag = uniqueTag();
    await page.goto('/blog/upload');
    await page.fill('#title', `新建标题-${tag}`);
    await page.fill('#description', 'e2e 摘要');
    await page.selectOption('#category', { index: 1 });
    await appendToEditor(page, '#editor', `新建正文-${tag}`);

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/blogs')
    );
    await page.click('#blogForm button[type=submit]');
    const res = await created;
    expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
    const { blog_id: blogId } = (await res.json()) as { blog_id: string };

    // 1.5 秒的窗口里接着敲 —— 这一版没发出去
    await appendToEditor(page, '#editor', ` 窗口里追加-${tag}`);
    await expect(page.locator('#toast-container')).toContainText('你又改了');

    await page.waitForTimeout(2000);
    expect(page.url(), '窗口里的改动被跳转带走了').toContain('/blog/upload');
    await expect(page.locator('#editor .cm-content')).toContainText(`窗口里追加-${tag}`);
    // 新建页的草稿接得住正文那一版（标题 / 摘要接不住，所以人必须留在这一页）
    await expect
      .poll(() => draftOf(page, BLOG_DRAFT_KEY), { timeout: 5000 })
      .toContain(`窗口里追加-${tag}`);

    // 再点一次：**更新刚建出来的那一篇**，不会再发一篇
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT') puts.push(r.url());
    });
    const updated = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/blogs/${blogId}`)
    );
    await page.click('#blogForm button[type=submit]');
    const updatedRes = await updated;
    expect(puts.length, '第二次提交没有更新这一篇（又新建了一篇）').toBe(1);
    expect(puts[0].endsWith(`/api/blogs/${blogId}`), `更新的不是刚建出来的那一篇：${puts[0]}`).toBe(
      true
    );
    // 这一笔发的是**窗口里追加过**的那一版
    const body = JSON.parse(updatedRes.request().postData() ?? '{}') as { content?: string };
    expect(body.content).toContain(`窗口里追加-${tag}`);

    // 没有未保存的改动了 → 这才跳转
    await page.waitForURL(new RegExp(`/blog/${blogId}$`), { timeout: 15_000 });
  });

  test('★ 新建态：新一笔开始时取消上一笔的待跳转定时器 —— 旧定时器不许在新请求期间抢走页面 ★', async ({
    page,
  }) => {
    const tag = uniqueTag();
    await page.goto('/blog/upload');
    await page.fill('#title', `定时器标题-${tag}`);
    await page.fill('#description', 'e2e 摘要');
    await page.selectOption('#category', { index: 1 });
    await appendToEditor(page, '#editor', `定时器正文-${tag}`);

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/blogs')
    );
    await page.click('#blogForm button[type=submit]');
    const res = await created;
    expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
    const { blog_id: blogId } = (await res.json()) as { blog_id: string };
    const armedAt = Date.now();

    // 把**第二笔**按住：它要在第一笔排的那个 1.5 秒到点时仍然在飞。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = 0;
    await page.route(`**/api/blogs/${blogId}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      held += 1;
      await gate;
      await route.continue();
    });

    await page.click('#blogForm button[type=submit]'); // 第二笔（内容没改，就是再存一次）
    await expect.poll(() => held, { timeout: 5000 }).toBe(1);

    // 第一笔的窗口到点：此刻第二笔还在飞 —— 页面**必须还在原地**
    await page.waitForTimeout(Math.max(0, 1800 - (Date.now() - armedAt)));
    expect(
      page.url(),
      '上一笔的待跳转定时器在第二笔还在飞的时候把页面抢走了 —— 第二笔的结果再也看不到'
    ).toContain('/blog/upload');

    // 放行第二笔：它落地之后才轮到新的那个窗口，然后正常跳走
    release();
    await page.waitForURL(new RegExp(`/blog/${blogId}$`), { timeout: 15_000 });
  });
});

test.describe('云剪贴板：提交的并发', () => {
  test('★ 第一笔还悬着时连点提交：只发一笔 POST，不会留下两篇 ★', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/clipboard')) posts.push(r.url());
    });
    await page.route('**/api/clipboard', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      await route.continue();
    });

    await page.goto('/clipboard/upload');
    await page.fill('#title', `并发剪贴板-${tag}`);
    await appendToEditor(page, '#clipboard-editor', `并发正文-${tag}`);

    await page.click('#uploadForm button[type=submit]');
    await expect.poll(() => posts.length, { timeout: 5000 }).toBe(1);

    // 第一笔还没回来 —— 用户等不及，又点了两下（表单里那颗按钮不会禁用）
    await page.click('#uploadForm button[type=submit]');
    await page.click('#uploadForm button[type=submit]');
    await page.waitForTimeout(300);
    expect(posts, '第一笔还悬着就叠了第二笔 POST').toHaveLength(1);

    release();
    // 等待者落地后不许各自补发：新建态补发一笔就是**多一篇剪贴板**
    await page.waitForURL(/\/clipboard\/[A-Za-z0-9]+$/, { timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(posts, '第一笔落地后排队的那两下各自补发了一笔').toHaveLength(1);
  });
});
