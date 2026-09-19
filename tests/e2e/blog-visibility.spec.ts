// 文章对外可见性（internal / link / public）—— 第 1 期的对外读口。
//
// 【为什么单独一个文件】这一域此前**没有**任何匿名读口：`/blog/<id>` 一直是 core+ 的
// `requireCoreUser()`。可见性是全站第一个「游客能读到用户内容」的入口，所以它的正反
// 两面都得钉住 —— 既钉「对外可见的确实读得到」，也钉「internal 的确实读不到、而且
// 拒绝的那份响应里不带走标题」。
//
// 【为什么用 API 造数而不是往 seed.ts 加种子】seed.ts 的注释反复强调新种子会打乱
// blog.spec.ts 的 cardOrder 与计数断言；而经 POST /api/blogs 造数顺带把写路径也 e2e
// 了（可见性字段真的能落库），比往库里塞行更接近真实。
//
// 【断言「不存在」才是这里的价值】访客视图的正确性主要不在于「显示了什么」，而在于
// **没显示什么**：评论区、点赞/投喂/收藏/编辑入口、三个计数数字，一个都不该出现。
// 这类断言必须在真浏览器里做 —— 单测渲染不出来。

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi, uniqueTag } from './helpers';

/** 正文哨兵串：只有客户端 marked 真的跑完才会出现在 DOM 里。 */
const BODY_MARKER = 'VISIBILITY-BODY-MARKER-9c41';

/**
 * 以 core+ 身份发一篇指定可见性的文章，返回它的 id。
 * 断言了写路径的响应形状（blog_id），所以可见性字段真落库这件事也在这一条里被覆盖。
 */
async function createBlogWith(page: Page, visibility: string): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: {
      title: `可见性-${visibility}-${uniqueTag()}`,
      description: 'e2e 可见性用例',
      content: `正文开头\n\n${BODY_MARKER}`,
      visibility,
    },
  });
  expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as { blog_id?: string };
  expect(body.blog_id, 'POST /api/blogs 必须回 blog_id').toBeTruthy();
  return body.blog_id!;
}

/** 丢掉会话，变回匿名访客。 */
async function becomeAnonymous(page: Page) {
  await page.context().clearCookies();
}

test.describe('文章对外可见性', () => {
  test('public：匿名读得到正文，且页面上没有任何站内 affordance', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'public');
    await becomeAnonymous(page);

    const res = await page.goto(`/blog/${id}`);
    expect(res?.status(), 'public 文章对匿名必须 200').toBe(200);
    await expect(page.locator('.read-hero h1')).toContainText('可见性-public-');
    // 正文是客户端 marked 渲染的，等到它出现才算真的读到了
    await expect(page.getByText(BODY_MARKER)).toBeVisible({ timeout: 10_000 });

    // ── 反向断言：访客视图不该有的东西 ──
    // 点赞 / 投喂 / 收藏 / 编辑 / 管理入口，以及三个计数数字，全挂在 FeedButton 上
    await expect(page.locator('#read-controls'), '访客不该看到点赞/投喂/管理入口').toHaveCount(0);
    await expect(page.locator('#comment-section'), '访客不该看到评论区').toHaveCount(0);
    await expect(page.locator('#comment-form'), '访客不该看到评论输入框').toHaveCount(0);
  });

  test('link：匿名同样读得到（与 public 的差别只在列举与索引）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'link');
    await becomeAnonymous(page);

    const res = await page.goto(`/blog/${id}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByText(BODY_MARKER)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#read-controls')).toHaveCount(0);
  });

  test('internal：匿名落到登录页，且标题不出现在 <title>', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'internal');
    const title = (await (async () => {
      const r = await page.request.get(`/api/blogs/${id}`);
      return ((await r.json()) as { blog: { title: string } }).blog.title;
    })())!;
    await becomeAnonymous(page);

    await page.goto(`/blog/${id}`);
    // internal 的语义是「仅站内 core+」（本站一直以来的样子），不是「不存在」——
    // 所以访客拿到的是登录页，并且带上了回跳目标（登录完能回到这篇文章）。
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fblog%2F${id}`));
    await expect(page.locator('#loginForm')).toBeVisible();
    // metadata 与页面是**两个独立的渲染步**（见 access-control.spec.ts 那条 403 页漏
    // 标题的钉子）—— 被拒绝的响应里不该带走这篇文章的标题。
    await expect(page, '被拒绝的响应里不该带着这篇文章的标题').not.toHaveTitle(new RegExp(title));
  });

  test('internal：已登录但非 core → 403（没顺手把门放宽）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'internal');
    await becomeAnonymous(page);

    await loginViaApi(page, SEED_USERS.plain.username);
    const res = await page.goto(`/blog/${id}`);
    expect(res?.status(), 'role=user 读 internal 文章应原地 403').toBe(403);
    await expect(page.locator('.rainbow-error__code')).toHaveText('403');
  });

  test('core+ 读 public 文章：仍是完整成员视图（公开不等于对站内关掉互动）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'public');

    // **不登出** —— 分叉判据是 isCore 而不是 visibility：作者把文章设为公开，
    // 不该顺手夺走他自己和全站的评论区。
    const res = await page.goto(`/blog/${id}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator('#read-controls')).toHaveCount(1);
    await expect(page.locator('#comment-section')).toHaveCount(1);
  });
});

test.describe('分享卡片（OG）与索引口径', () => {
  test('public：可索引 + 挂 OG 卡片；OG 图 200 且 X-Robots-Tag: all', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'public');
    await becomeAnonymous(page);

    await page.goto(`/blog/${id}`);
    // public 不发 noindex
    await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute('content', /noindex/);
    // og:image 指向本文章的卡片路由（有 metadataBase，所以是绝对地址 —— 断言含路径即可）
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`/api/og/blog/${id}`)
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /可见性-public-/
    );

    const res = await page.request.get(`/api/og/blog/${id}`);
    expect(res.status(), 'OG 图对匿名必须 200').toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    expect(res.headers()['x-robots-tag'], 'public 档的卡片可索引').toBe('all');
    expect(res.headers()['cache-control'], 'OG 图要可缓存（与画报的 no-store 相反）').toContain(
      'public'
    );
    // 真的是一张图，而不是空 body 或错误页
    expect((await res.body()).byteLength).toBeGreaterThan(1000);
  });

  test('link：可读但**不可索引** —— 页面 noindex、卡片 X-Robots-Tag: noindex', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'link');
    await becomeAnonymous(page);

    await page.goto(`/blog/${id}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    // link 也要有卡片（差别在索引，不在能不能分享）
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`/api/og/blog/${id}`)
    );

    const res = await page.request.get(`/api/og/blog/${id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['x-robots-tag'], 'link 档的卡片不许被索引').toBe('noindex');
  });

  test('internal 与不存在：OG 图同为 404，且响应体逐字相同（不确认存在性）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const internalId = await createBlogWith(page, 'internal');
    await becomeAnonymous(page);

    const internalRes = await page.request.get(`/api/og/blog/${internalId}`);
    const missingRes = await page.request.get('/api/og/blog/no-such-blog-id');
    expect(internalRes.status(), 'internal 文章不出卡片').toBe(404);
    expect(missingRes.status()).toBe(404);
    // 「存在但你无权看」与「根本不存在」对外必须**逐字相同** —— 差一个字就是一个
    // 存在性探针（拿一批 id 挨个试，能筛出哪些是真实文章）。
    expect(await internalRes.text()).toBe(await missingRes.text());
  });

  test('作者把文章从 public 改回 internal，匿名立刻读不到（没有按 viewer 缓存住旧结果）', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const id = await createBlogWith(page, 'public');

    await becomeAnonymous(page);
    expect((await page.goto(`/blog/${id}`))?.status()).toBe(200);

    // 变回 core+ 改性质
    await loginViaApi(page, SEED_USERS.core.username);
    const patch = await page.request.put(`/api/blogs/${id}`, {
      data: { title: `改回私密-${uniqueTag()}`, description: 'd', content: 'c', visibility: 'internal' },
    });
    expect(patch.ok(), `改性质失败：${patch.status()} ${await patch.text()}`).toBeTruthy();

    await becomeAnonymous(page);
    await page.goto(`/blog/${id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    expect((await page.request.get(`/api/og/blog/${id}`)).status()).toBe(404);
  });

  test('sitemap 只列 public；robots.txt 的对外开口到位', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const pub = await createBlogWith(page, 'public');
    const link = await createBlogWith(page, 'link');
    const priv = await createBlogWith(page, 'internal');
    await becomeAnonymous(page);

    const sitemap = await (await page.request.get('/sitemap.xml')).text();
    expect(sitemap, 'public 文章要进 sitemap').toContain(`/blog/${pub}`);
    expect(sitemap, 'link 不该被列举').not.toContain(`/blog/${link}`);
    expect(sitemap, 'internal 不该被列举').not.toContain(`/blog/${priv}`);

    const robots = await (await page.request.get('/robots.txt')).text();
    // 这三条是「对外文章可被抓」的全部机关，缺一条就会静默失效：
    //   · /blog/ 放行（压过 disallow: /blog —— RFC 9309 最长匹配优先）
    //   · /login 挡住（否则 internal 文章的 URL 会跟着 307 跳到带 UUID 的 next 参数上）
    //   · /api/og/ 放行（否则 /api/ 整段 disallow 会把分享卡片一起挡掉）
    expect(robots).toContain('Allow: /blog/');
    expect(robots).toContain('Disallow: /login');
    expect(robots).toContain('Allow: /api/og/');
    expect(robots, '/blog 目录页本身仍是 core+，继续挡').toContain('Disallow: /blog');
  });
});
