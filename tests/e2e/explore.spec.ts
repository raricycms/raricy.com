// 对外公开列表 `/explore` —— 第 2 期的对外入口。
//
// 【为什么单独一个文件】第 1 期把「单篇读得到」打开了，但访客读完就是死胡同。
// `/explore` 是第一条「不拿链接也能找到文章」的路径，它同时承载三件事：只列 public、
// 可被搜索引擎列举、以及给作者一个「公开出去之后别人看到的是什么」的样张。
//
// 【断言「不存在」才是这里的价值】与 blog-visibility.spec.ts 同一条理由：列表的正确性
// 主要不在于显示了什么，而在于**没显示什么** —— link 与 private 的标题一个都不该出现，
// 卡片上不该有计数，作者名不该是链接。这类断言必须在真浏览器里做。
//
// 【为什么用「共享前缀 + 唯一 tag」而不是直接断言第 1 页】e2e 库是 desktop 与 mobile
// 两轮**共用**的（workers: 1，但两个 project 都跑），公开文章会累积；直接断言第 1 页
// 会随「全站此刻有多少篇公开文章」漂移，变成一条时绿时红的用例。用搜索把这一组钉出来，
// 既确定又精确。
//
// 【不登记进 RESPONSIVE_SPECS】playwright.config.ts 的判据是「用例是否碰布局」——
// 本文件只 goto 页面再断言内容，不碰折叠/抽屉/视口尺寸，所以不双跑。

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';

/** 正文哨兵串：只有正文里才有它，用来证明「搜索不碰正文」。 */
const BODY_MARKER = 'EXPLORE-BODY-ONLY-7f31';

/** 丢掉会话，变回匿名访客。 */
async function becomeAnonymous(page: Page) {
  await page.context().clearCookies();
}

/**
 * 本文件**专属**的发文账号（core+），第一次用到时现注册。
 *
 * ⚠️ 别改回 `SEED_USERS.core`。发文有 `BLOG_DAILY_LIMIT = 20` 的**按账号**日限额，
 * 而这个 e2e 库是整轮共用、desktop + mobile 两轮共用的：
 *   · blog-visibility.spec.ts 已经用 e2e_core 发掉 12 篇
 *   · focus-mode.spec.ts 再发 2 篇
 * 本文件原先也用 e2e_core 发 12 篇 —— 合计 26 > 20，于是**别的 spec 开始拿到 429**，
 * 报错还指向它们自己那句 `expect(res.status()).toBe(200)`（实测：focus-mode 有两条
 * 用例因此变红，而单跑它时全绿）。这种「A 把 B 的额度吃光」的耦合极难从报错里看出来，
 * 所以宁可多花一次注册，也要一个自带额度的号。
 *
 * 缓存成模块级变量：本文件在同一个 worker 里串行跑完，注册一次够 12 篇用。
 */
let sharedAuthor: { id: string; username: string } | null = null;

/** 切到本文件专属的发文账号（首次调用时注册并提权），返回它。 */
async function ensureAuthor(page: Page): Promise<{ id: string; username: string }> {
  if (!sharedAuthor) sharedAuthor = await registerFreshUser(page, { core: true });
  else await loginViaApi(page, sharedAuthor.username);
  return sharedAuthor;
}

/** 以 core+ 身份发一篇文章，返回 { id, title }。 */
async function createBlog(
  page: Page,
  visibility: string,
  title: string,
  content = `正文开头\n\n${BODY_MARKER}`
): Promise<{ id: string; title: string }> {
  const res = await page.request.post('/api/blogs', {
    data: { title, description: 'e2e 对外列表用例', content, visibility },
  });
  expect(res.ok(), `发文失败：${res.status()} ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as { blog_id?: string };
  expect(body.blog_id, 'POST /api/blogs 必须回 blog_id').toBeTruthy();
  return { id: body.blog_id!, title };
}

test.describe('对外列表 /explore', () => {
  test('匿名打得开；只列 public —— link 与 private 都不在', async ({ page }) => {
    // 三篇共用一个**唯一前缀**，于是「搜这个前缀」恰好圈出这三篇：
    // 其中只有 public 那篇该出现，另外两篇的缺席才是这条用例的价值。
    const tag = uniqueTag();
    const prefix = `探索资格-${tag}`;
    await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `${prefix}-public`);
    const link = await createBlog(page, 'link', `${prefix}-link`);
    const priv = await createBlog(page, 'private', `${prefix}-private`);
    await becomeAnonymous(page);

    const res = await page.goto(`/explore?search=${encodeURIComponent(prefix)}`);
    expect(res?.status(), '/explore 对匿名必须 200').toBe(200);
    await expect(page.locator('.blogs-hero h1')).toHaveText('博客');

    const list = page.locator('.blog-list');
    await expect(list).toContainText(pub.title);
    await expect(list, 'link 不该被列举（读得到 ≠ 该被列举）').not.toContainText(link.title);
    await expect(list, 'private 更不该被列举').not.toContainText(priv.title);
  });

  test('裸 /explore 打得开（不依赖搜索也能用）', async ({ page }) => {
    await becomeAnonymous(page);
    const res = await page.goto('/explore');
    expect(res?.status()).toBe(200);
    await expect(page.locator('.blogs-hero h1')).toHaveText('博客');
    // 侧栏与搜索框都该在（这是页面结构，不是「有没有内容」）
    await expect(page.locator('.sidebar-title')).toHaveCount(1);
    await expect(page.locator('.search-form')).toHaveCount(1);
    // 对外列表没有「精选」—— 那是站内的编辑口径，回答的是「站长推荐了哪几篇」。
    // 按 href 断言而不是按文案：栏目名里出现「精选」二字是合法的，那样断会误伤。
    await expect(page.locator('a[href*="featured=1"]'), '对外列表不该有精选筛选').toHaveCount(0);
  });

  test('卡片上没有计数、作者名不是链接（对外视图没有评论区）', async ({ page }) => {
    const tag = uniqueTag();
    const author = await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索卡片-${tag}`);
    await becomeAnonymous(page);

    await page.goto(`/explore?search=${encodeURIComponent(`探索卡片-${tag}`)}`);
    const card = page.locator('.blog-item').first();
    await expect(card).toContainText(pub.title);

    // 三个计数全挂在 .blog-stats 上 —— 整个块不该被渲染（第 1 期已定：对外视图无评论区，
    // 写着「评论 12」却翻不到评论是自相矛盾的）
    await expect(card.locator('.blog-stats'), '卡片上不该有任何计数').toHaveCount(0);
    // 作者名显示但不链接 —— 第 2 期刻意不做作者页对外
    await expect(card.locator('.blog-author a'), '作者名不许是链接').toHaveCount(0);
    await expect(card.locator('.blog-author')).toContainText(author.username);
  });

  test('搜索命中标题与作者名，**绝不命中正文**', async ({ page }) => {
    const tag = uniqueTag();
    const author = await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索搜索-${tag}`);
    await becomeAnonymous(page);

    // 正文里的哨兵串搜不到 —— 这是「对外搜索不碰正文」的行为侧保证，
    // 结构侧的保证在 blog-service 的 PublicSearchField = Exclude<SearchField, 'content'>
    await page.goto(`/explore?search=${encodeURIComponent(BODY_MARKER)}`);
    await expect(page.locator('.no-blogs'), '正文里的词必须搜不到').toBeVisible();

    // 标题搜得到
    await page.goto(`/explore?search=${encodeURIComponent(`探索搜索-${tag}`)}`);
    await expect(page.locator('.blog-list')).toContainText(pub.title);

    // 作者名搜得到（站外读者已经在卡片与详情页看到作者名了，搜它不泄露新东西）
    await page.goto(`/explore?search=${encodeURIComponent(author.username)}`);
    await expect(page.locator('.blog-list')).toContainText(pub.title);
  });
});

test.describe('对外列表 / 索引口径', () => {
  test('搜索结果页恒 noindex（那是无穷多组参数的薄页面）', async ({ page }) => {
    await becomeAnonymous(page);
    await page.goto('/explore?search=anything');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('canonical 指向**自身**，不是第 1 页（否则后几页会被当成第 1 页的副本）', async ({
    page,
  }) => {
    await becomeAnonymous(page);
    await page.goto('/explore?page=2');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/explore\?page=2$/
    );
  });

  test('JSON-LD：public 文章有且解析得出，link 文章没有', async ({ page }) => {
    const tag = uniqueTag();
    await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索结构-${tag}`);
    const link = await createBlog(page, 'link', `探索结构-${tag}-link`);
    await becomeAnonymous(page);

    await page.goto(`/blog/${pub.id}`);
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    expect(raw, 'public 文章必须输出结构化数据').toBeTruthy();
    const data = JSON.parse(raw!) as Record<string, unknown>;
    expect(data['@type']).toBe('BlogPosting');
    expect(data.headline).toBe(pub.title);
    // 时间戳必须带**真实偏移**：库内是「UTC+8 墙上时间贴 Z」，裸 toISOString() 会让
    // 机器以为它晚了 8 小时发布。这条断言是那个修复的端到端验证。
    expect(String(data.datePublished), 'datePublished 要带 +08:00').toMatch(/\+08:00$/);
    expect(() => new Date(String(data.datePublished)), '且必须是个合法时刻').not.toThrow();

    // link 档 noindex，挂 JSON-LD 没有意义 —— 搜索引擎根本不会读它
    await page.goto(`/blog/${link.id}`);
    await expect(
      page.locator('script[type="application/ld+json"]'),
      'link 档不该输出结构化数据'
    ).toHaveCount(0);
  });

  test('sitemap 含 /explore 与 public 文章；link / private 都不进', async ({ page }) => {
    const tag = uniqueTag();
    await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索站点图-${tag}`);
    const link = await createBlog(page, 'link', `探索站点图-${tag}-link`);
    const priv = await createBlog(page, 'private', `探索站点图-${tag}-private`);
    await becomeAnonymous(page);

    const sitemap = await (await page.request.get('/sitemap.xml')).text();
    expect(sitemap, '有公开文章时 /explore 自己也要进 sitemap').toContain('/explore');
    expect(sitemap, 'public 文章要进').toContain(`/blog/${pub.id}`);
    expect(sitemap, 'link 不该被列举').not.toContain(`/blog/${link.id}`);
    expect(sitemap, 'private 不该被列举').not.toContain(`/blog/${priv.id}`);
  });
});

test.describe('两条导航边（访客的闭环）', () => {
  test('顶栏与首页卡：匿名去 /explore，core+ 去 /blog', async ({ page }) => {
    await becomeAnonymous(page);
    await page.goto('/');
    // 匿名：两条「博客」入口都指向对外列表 —— 否则点了是一张登录页
    await expect(page.locator('.site-nav a[href="/explore"]')).toHaveCount(1);
    await expect(page.locator('.site-nav a[href="/blog"]'), '匿名不该被指向 core+ 的列表').toHaveCount(0);
    await expect(page.locator('a.card-blog')).toHaveAttribute('href', '/explore');

    // core+：回到站内全量列表（入口照旧渲染，只是通向该去的地方）
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/');
    await expect(page.locator('.site-nav a[href="/blog"]')).toHaveCount(1);
    await expect(page.locator('.site-nav a[href="/explore"]')).toHaveCount(0);
    await expect(page.locator('a.card-blog')).toHaveAttribute('href', '/blog');
  });

  test('访客读完一篇能回到 /explore（站外点进来的人没过导航）', async ({ page }) => {
    const tag = uniqueTag();
    await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索闭环-${tag}`);
    await becomeAnonymous(page);

    await page.goto(`/blog/${pub.id}`);
    // ⚠️ 必须限定在正文区里数。匿名访客的**顶栏**「博客」此刻也指向 /explore
    // （这正是上一条用例钉的），全局数会得到 2 —— 那条断言就成了「页面里恰好有两个
    // 指向 /explore 的链接」这种与意图无关的话。
    const back = page.locator('.blog-detail a[href="/explore"]');
    await expect(back, '访客视图底部要有回公开列表的入口').toHaveCount(1);
    await expect(back).toContainText('更多文章');
    // 它不属于「读者交互区」—— 那条红线由 blog-visibility.spec.ts 按 id 钉着
    await expect(page.locator('#read-controls')).toHaveCount(0);

    await back.click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.locator('.blogs-hero h1')).toHaveText('博客');
  });

  test('core+ 读同一篇：仍是完整成员视图，**没有**那条对外出口', async ({ page }) => {
    const tag = uniqueTag();
    await ensureAuthor(page);
    const pub = await createBlog(page, 'public', `探索成员-${tag}`);

    await page.goto(`/blog/${pub.id}`);
    await expect(page.locator('#read-controls')).toHaveCount(1);
    // 成员有顶栏与站内列表，多这一条反而碍事 —— 它只给访客。
    // （成员的顶栏「博客」指向 /blog，所以这里连顶栏一起数也是 0，但断言仍限定在正文区，
    // 免得将来页脚加了个站外入口就莫名其妙地红。）
    await expect(page.locator('.blog-detail a[href="/explore"]'), '成员视图不该有这条出口').toHaveCount(0);
  });
});
