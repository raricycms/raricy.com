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
 *
 * `extra` 用来往正文里追加内容（引用用例）；正文开头那个哨兵串始终保留。
 */
async function createBlogWith(page: Page, visibility: string, extra = ''): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: {
      title: `可见性-${visibility}-${uniqueTag()}`,
      description: 'e2e 可见性用例',
      content: `正文开头\n\n${BODY_MARKER}${extra ? `\n\n${extra}` : ''}`,
      visibility,
    },
  });
  expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as { blog_id?: string };
  expect(body.blog_id, 'POST /api/blogs 必须回 blog_id').toBeTruthy();
  return body.blog_id!;
}

/** 1×1 合法 PNG（服务端按 magic bytes 嗅探，且要过 sharp 压缩，必须得是真图）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 合法的 MP3 帧头 + 填充（服务端要嗅出 MPEG1 Layer III，光有 0xFF 打头不算）。 */
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);

/** 走接口传一张图 / 一段音频，返回各自的 id。 */
async function uploadImageViaApi(page: Page): Promise<string> {
  const res = await page.request.post('/api/images', {
    multipart: { file: { name: 'e2e.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(res.status(), `传图失败：${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function uploadAudioViaApi(page: Page): Promise<string> {
  const res = await page.request.post('/api/audio', {
    multipart: { file: { name: 'e2e.mp3', mimeType: 'audio/mpeg', buffer: MP3_FRAME } },
  });
  expect(res.status(), `传音频失败：${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** 走接口建一条剪贴板（公开 / 私有由 publicity 决定），返回其 8 位 id。 */
async function createClipViaApi(page: Page, content: string, publicity: boolean): Promise<string> {
  const res = await page.request.post('/api/clipboard', {
    data: { title: `可见性用例-${uniqueTag()}`, content, publicity },
  });
  expect(res.status(), `建剪贴板失败：${await res.text()}`).toBe(200);
  const json = (await res.json()) as { id?: string; clip?: { id: string } };
  const id = json.id ?? json.clip?.id;
  expect(typeof id, '剪贴板接口没给出 id').toBe('string');
  return id!;
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

  // 对外视图的 `[@…]` 引用展开**到哪一档**：图 / 音频 / 公开剪贴板出得来，投票与
  // 私有剪贴板保留字面量。判据是「这条引用的读口匿名本来就取得到吗」——
  // 图与音频的字节路由是匿名可达、逐条判档的；剪贴板的公开档由**服务端**判完随
  // payload 下发（匿名去请求 core+ 接口只会吃 401）；投票与收藏夹的读口一律 core+。
  //
  // 【为什么非 E2E 不可】这条链路上有三段是单测够不到的：页面真把 externalClips
  // 传下去了吗、真浏览器里 `<audio>` / `<img>` 有没有被渲染出来、以及**私有的那条
  // 确实没跟着进来**（后者判错的形态是「公开文章里多出别人的私有正文」，页面不会
  // 报任何错）。单测那边（tests/unit/blog-ref-render.test.ts）钉的是同一套判据的
  // 客户端一半，服务端那一半在 tests/service/clipboard-refs.test.ts。
  test('public：访客读得到正文里的图 / 音频 / 公开剪贴板，读不到投票与私有剪贴板', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    const imageId = await uploadImageViaApi(page);
    const audioId = await uploadAudioViaApi(page);
    const publicClipId = await createClipViaApi(page, '公开剪贴板正文-OPEN-7f21', true);
    const privateClipId = await createClipViaApi(page, '私有剪贴板正文-SECRET-7f21', false);
    const voteRes = await page.request.post('/api/votes', {
      data: { title: `可见性投票-${uniqueTag()}`, options: ['甲', '乙'] },
    });
    expect(voteRes.status(), await voteRes.text()).toBe(200);
    const voteId = ((await voteRes.json()) as { data: { id: string } }).data.id;

    const id = await createBlogWith(
      page,
      'public',
      [
        `图：[@${imageId}]`,
        `音：[@音频/${audioId}]`,
        `公开剪贴板：[@${publicClipId}]`,
        `私有剪贴板：[@${privateClipId}]`,
        `投票：[@${voteId}]`,
      ].join('\n\n')
    );

    await becomeAnonymous(page);
    const res = await page.goto(`/blog/${id}`);
    expect(res?.status(), 'public 文章对匿名必须 200').toBe(200);

    const body = page.locator('#userContentContainer');
    // 先等正文真的渲染出来（客户端 marked 跑完的标志）
    await expect(body.getByText(BODY_MARKER)).toBeVisible({ timeout: 10_000 });

    // ── 该出来的 ──
    await expect(body.locator(`img[src="/api/images/${imageId}/raw"]`)).toHaveCount(1);
    await expect(body.locator(`audio[src="/api/audio/${audioId}/raw"]`)).toHaveCount(1);
    await expect(body, '公开剪贴板的正文要内联进来').toContainText('公开剪贴板正文-OPEN-7f21');

    // ── 不该出来的 ──
    await expect(body, '私有剪贴板保持字面量').toContainText(`[@${privateClipId}]`);
    await expect(body, '私有剪贴板正文一个字都不该出现').not.toContainText('私有剪贴板正文-SECRET-7f21');
    await expect(body, '投票在对外视图里保留字面量').toContainText(`[@${voteId}]`);
    await expect(body.locator('.vote-embed'), '对外视图不建投票嵌入位').toHaveCount(0);
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
