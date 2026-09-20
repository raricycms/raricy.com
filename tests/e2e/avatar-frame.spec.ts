// ─────────────────────────────────────────────────────────────────────────────
// avatar-frame.spec.ts —— 头像框真的显示出来了（以及**过期后真的消失**）
//
// 【为什么必须 E2E】这条链路上有两处**只有真浏览器才碰得到**的缺口：
//
//  1. 「DTO 有字段、渲染时却忘了传 prop」。静态守卫（avatar-sites-guard）只能查到
//     「这一处用了 <Avatar>」，查不到 `<Avatar frameUrl={…}>` 里那个 prop 有没有写。
//     后果是那一处**永远没有框** —— 页面照常渲染、没有日志、没有 500。
//  2. 「到期后框不消失」。判定做在服务层（frameUrlFor），但**渲染层有没有真的用它**
//     只有看到 DOM 才算数。漏判的话同样完全静默。
//
// 所以这里的用例按**尺寸**分组覆盖：每个尺寸背后是一条不同的 DTO + 不同的组件
// （20px 博客列表 / 24px 评论 / 32px 顶栏 / 34px 讨论 / 120px 个人主页）。
// 只测一处的话，另外四条路上漏传 prop 都不会被发现。
//
// 【造数纪律】大区是全站共用频道，博客列表也是全站共用 —— 所有定位一律按本轮
// uniqueTag 的哨兵串锚定，**绝不断言「列表里有几条」**（与 chat-avatar-menu 同款）。
//
// 【素材从哪来】tests/.tmp/e2e-frames/<key>.png，由 global-setup 的 seedFrames() 造；
// 两个账号的框由同一处种下（一个永久、一个已过期）。见 seed.ts 的 framed /
// framedExpired。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_FRAME_KEY, SEED_USERS, SEED_BLOG } from './seed';

const FRAME_SRC = `/api/frames/${SEED_FRAME_KEY}`;

/** 本轮造出来的内容，beforeAll 里填。 */
const made = { blogId: '', blogMarker: '', commentMarker: '', chatMarker: '' };

test.beforeAll(async ({ browser }) => {
  const tag = uniqueTag();
  made.blogMarker = `框-博客-${tag}`;
  made.commentMarker = `框-评论-${tag}`;
  made.chatMarker = `框-讨论-${tag}`;

  // 用一个独立的 context 造数，不污染任何用例自己的登录态
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await loginViaApi(page, SEED_USERS.framed.username);

    const blogRes = await page.request.post('/api/blogs', {
      data: {
        title: made.blogMarker,
        description: '头像框用例',
        content: `正文 ${made.blogMarker}`,
        visibility: 'internal',
      },
    });
    expect(blogRes.ok(), `发文失败：${blogRes.status()} ${await blogRes.text()}`).toBeTruthy();
    made.blogId = ((await blogRes.json()) as { blog_id: string }).blog_id;

    const cRes = await page.request.post(`/api/blogs/${made.blogId}/comments`, {
      data: { content: made.commentMarker },
    });
    expect(cRes.status(), `发评论失败：${await cRes.text()}`).toBe(200);

    const mRes = await page.request.post('/api/chat/channels/lobby/messages', {
      data: { content: made.chatMarker },
    });
    expect(mRes.status(), `发消息失败：${await mRes.text()}`).toBe(200);
  } finally {
    await ctx.close();
  }
});

/** 某个盒子里的框贴图。找不到就是「那一处没有框」。 */
const frameIn = (page: Page, box: string) => page.locator(`${box} .avatar__frame`);

test.describe('戴着永久框的账号：各尺寸的落点都真的画出了框', () => {
  test('32px · 顶栏（每一页都有，走 SafeUser 那条路）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framed.username);
    await page.goto('/');

    const frame = frameIn(page, '.site-user-avatar');
    await expect(frame).toHaveCount(1);
    // 断言 src 而不只是「有个元素」：这样连 URL 口径都一起验了
    await expect(frame).toHaveAttribute('src', FRAME_SRC);
    // 纯装饰，不该被屏读器念出来
    await expect(frame).toHaveAttribute('aria-hidden', 'true');
  });

  test('120px · 个人主页（全站最大的头像）', async ({ page }) => {
    // 个人主页是匿名可达的，不需要登录 —— 用游客身份看反而更接近真实场景
    await page.goto(`/u/${SEED_USERS.framed.id}`);
    await expect(frameIn(page, '.profile-hero__avatar')).toHaveAttribute('src', FRAME_SRC);
  });

  test('20px · 博客列表的作者头像', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framed.username);
    await page.goto('/blog');

    // 按本轮哨兵串锚定那一张卡片，绝不断言列表总数
    const card = page.locator('.blog-item', { hasText: made.blogMarker });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.blog-author .avatar__frame')).toHaveAttribute('src', FRAME_SRC);
  });

  test('20px · 文章详情页的作者头像', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framed.username);
    await page.goto(`/blog/${made.blogId}`);
    await expect(page.locator('.blog-meta .blog-author .avatar__frame')).toHaveAttribute(
      'src',
      FRAME_SRC
    );
  });

  test('24px · 评论作者头像（客户端组件那条路，DTO 走 comment-service）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framed.username);
    await page.goto(`/blog/${made.blogId}`);

    // 评论是客户端拉取后渲染的，用哨兵串锚定到那一条
    const item = page.locator('.comment-item', { hasText: made.commentMarker });
    await expect(item).toHaveCount(1);
    // 框贴图是头像 img 的**后一个兄弟**（同一个 .avatar 盒子里）
    await expect(item.locator('.comment-author-avatar ~ .avatar__frame')).toHaveAttribute(
      'src',
      FRAME_SRC
    );
  });

  test('34px · 讨论消息作者头像（chat-service 的 DTO）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framed.username);
    await page.goto('/chat');

    const row = page.locator('.chat-msg', { hasText: made.chatMarker });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.chat-msg__avatar .avatar__frame')).toHaveAttribute('src', FRAME_SRC);
  });
});

test.describe('★ 已过期的框：一处都不该出现（这是那个静默失效唯一的自动化防线）', () => {
  test('顶栏没有框', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.framedExpired.username);
    await page.goto('/');

    // 头像本身要在（否则「没有框」可能只是因为整块没渲染）
    await expect(page.locator('.site-user-avatar .avatar__img')).toHaveCount(1);
    await expect(frameIn(page, '.site-user-avatar')).toHaveCount(0);
  });

  test('个人主页没有框', async ({ page }) => {
    await page.goto(`/u/${SEED_USERS.framedExpired.id}`);
    await expect(page.locator('.profile-hero__avatar .avatar__img')).toHaveCount(1);
    await expect(frameIn(page, '.profile-hero__avatar')).toHaveCount(0);
  });

  test('★ 对照：同一页面下，戴永久框的那个账号**有**框', async ({ page }) => {
    // 这条是为了排除「整站都没有框」导致的假绿 —— 上面两条的 toHaveCount(0)
    // 若因为别的原因（比如素材没种上）成立，这条会当场红。
    await page.goto(`/u/${SEED_USERS.framed.id}`);
    await expect(frameIn(page, '.profile-hero__avatar')).toHaveCount(1);
  });
});

test.describe('没有框的账号：一个框元素都不该渲染', () => {
  test('core 账号（没戴框）的头像照常显示，但不带框元素', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/');

    await expect(page.locator('.site-user-avatar .avatar__img')).toHaveCount(1);
    await expect(frameIn(page, '.site-user-avatar')).toHaveCount(0);
    // 框素材本身是可取的（不存在「素材没了所以没框」这种混淆）
    expect((await page.request.get(FRAME_SRC)).status()).toBe(200);
  });

  test('文章详情：作者头像照常在，但不带框元素', async ({ page }) => {
    // /blog/<id> 是 core+ 档，匿名访客会被重定向到登录页 —— 这里用 core 看
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/blog/${SEED_BLOG.id}`);
    await expect(page.locator('.blog-meta .blog-author .avatar__img')).toHaveCount(1);
    await expect(page.locator('.blog-meta .blog-author .avatar__frame')).toHaveCount(0);
  });
});
