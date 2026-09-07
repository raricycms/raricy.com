// ─────────────────────────────────────────────────────────────────────────────
// focus-mode.spec.ts —— 专注模式（账号级浏览偏好）
//
// 【功能面】/settings 打开后：博客列表与侧栏隐藏「专注隐藏」栏目及其文章并显示
// 关闭横幅；聊天大区（lobby）侧栏行禁用、无最近一条预览；「玩具」（/game）导航
// 与首页卡片禁用、/game 菜单页锁屏；游戏子页可直达。
//
// 【造数纪律 —— 与全库 spec 共存】
//   • 动态幂等：被标记栏目用 uniqueTag 的 slug 现场建（owner API），文章走
//     POST /api/blogs（core，无 vditor 依赖）。绝不 PATCH e2e-cat、不挪 SEED_BLOG。
//   • 每个用例 afterEach 把 focusMode 复位 false（两个 project 共用一个库，
//     残留 focus 会让后续 blog.spec 带着过滤跑）。
//   • 该 spec 文件名序（f）在 admin-categories（a）/ blog（b）之后，
//     残留的被标记栏目 + 文章只影响自己（blog.spec 无全局计数断言，已核实）。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_USERS, BLOG_BODY_MARKER } from './seed';
import { loginViaApi, uniqueTag } from './helpers';

const FOCUS_TITLE = '已开启专注模式，无法使用该功能';

/** 开/关当前登录用户的专注模式（走真实 PATCH /api/users/me）。 */
async function setFocus(page: import('@playwright/test').Page, on: boolean) {
  const res = await page.request.patch('/api/users/me', { data: { focusMode: on } });
  expect(res.status()).toBe(200);
}

/** 建「专注隐藏」栏目：栏目管理 API 仅站长可用 → 切 owner 会话建，建完换回 core。 */
async function createFlaggedCategory(page: import('@playwright/test').Page) {
  const tag = uniqueTag();
  const slug = `focus-cat-${tag}`;
  await loginViaApi(page, SEED_USERS.owner.username);
  const res = await page.request.post('/api/admin/categories', {
    data: { name: `专注水区 ${tag}`, slug, focusHidden: true },
  });
  await loginViaApi(page, SEED_USERS.core.username);
  expect(res.status(), `建栏目失败: ${JSON.stringify(await res.json().catch(() => ({})))}`).toBe(200);
  const body = (await res.json()) as { category: { id: number } };
  return { id: body.category.id, slug };
}

/** 点击专注开关：input 视觉隐藏（opacity:0），要点的其实是包着它的 label。 */
async function clickFocusToggle(page: import('@playwright/test').Page) {
  await page
    .locator('label.settings-toggle', { has: page.locator('#toggleFocus') })
    .click();
}

/** core 用户发一篇博客到指定栏目（POST /api/blogs → { blog_id }）。 */
async function createBlogIn(page: import('@playwright/test').Page, categoryId: number | null) {
  const tag = uniqueTag();
  const title = `专注过滤文 ${tag}`;
  const res = await page.request.post('/api/blogs', {
    data: {
      title,
      description: '专注模式 e2e 用',
      content: `# 正文\n\n${BLOG_BODY_MARKER}\n\n专注关键词-${tag}`,
      category_id: categoryId,
    },
  });
  const body = (await res.json()) as { code?: number; blog_id?: string };
  expect(res.status(), `发文失败: ${JSON.stringify(body)}`).toBe(200);
  return { title, id: body.blog_id ?? '' };
}

test.describe('专注模式（设置 → 各处生效）', () => {
  test.afterEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await setFocus(page, false);
  });

  test('设置页开关开 → 刷新回显开；博客横幅「此处」深链到设置锚点', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    // 设置页 UI 开关（点击 label；input 视觉隐藏）
    await page.goto('/settings');
    await clickFocusToggle(page);
    await expect(page.locator('#focusAlert')).toContainText('已保存');
    await page.goto('/settings');
    await expect(page.locator('#toggleFocus')).toBeChecked();

    // 博客横幅 + 「此处」→ /settings#focus-mode 锚点卡片可见
    await page.goto('/blog');
    const banner = page.locator('.focus-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('您已开启专注模式');
    const here = banner.locator('a[href="/settings#focus-mode"]');
    await expect(here).toContainText('此处');
    await here.click();
    await expect(page).toHaveURL(/\/settings#focus-mode$/);
    await expect(page.locator('#focus-mode')).toBeVisible();
    await expect(page.locator('#toggleFocus')).toBeChecked();
  });

  test('博客：被标记栏目文章在列表/侧栏/搜索/直达过滤，详情可直达', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    // 造数：被标记栏目 + 其中一篇文章 + 一篇未分类对照
    const { id: catId, slug } = await createFlaggedCategory(page);
    const flagged = await createBlogIn(page, catId);
    const plainTitle = `对照文 ${uniqueTag()}`;
    await page.request.post('/api/blogs', {
      data: { title: plainTitle, description: 'd', content: '# x', category_id: null },
    });

    await setFocus(page, true);
    await page.goto('/blog');
    // 列表：被过滤文不出现、对照文在
    await expect(page.locator(`.blog-item:has-text("${flagged.title}")`)).toHaveCount(0);
    await expect(page.locator(`.blog-item:has-text("${plainTitle}")`)).toHaveCount(1);
    // 侧栏：整组入口消失（含「专注水区」根）
    await expect(page.locator(`.category-link:has-text("专注水区")`)).toHaveCount(0);
    // 搜索命中关键词也不出现
    await page.goto(`/blog?search=${encodeURIComponent('专注关键词')}`);
    await expect(page.locator(`.blog-item:has-text("${flagged.title}")`)).toHaveCount(0);
    // 分类直达被标记栏目 → 空态（无 no-results 卡片；用列表区无该文且提示存在验证）
    await page.goto(`/blog?category=${slug}`);
    await expect(page.locator(`.blog-item`)).toHaveCount(0);
    // 详情页可直达（正文 marker 由客户端 marked 渲染后出现）
    await page.goto(`/blog/${flagged.id}`);
    await expect(page.locator('body')).toContainText(BLOG_BODY_MARKER, { timeout: 15_000 });
  });

  test('聊天：大区行禁用且无最近一条预览；API 直打大区 403；私聊不拦', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    // 先在专注前于大区留一条消息（focus 后它不该出现在预览里）
    const pre = await page.request.post('/api/chat/channels/lobby/messages', {
      data: { content: '大区历史消息-预览哨兵' },
    });
    expect(pre.status()).toBe(200);

    await setFocus(page, true);

    // 侧栏大区行：存在但禁用、title/预览为专注文案、无最近一条预览内容
    // （移动端侧栏是抽屉，DOM 存在但可能不可见 → 用 toBeAttached 而非 toBeVisible）
    await page.goto('/chat');
    const lobbyRow = page.locator('.chat-chan', { hasText: '聊天大区' });
    await expect(lobbyRow).toBeAttached();
    await expect(lobbyRow).toHaveAttribute('aria-disabled', 'true');
    await expect(lobbyRow).toHaveAttribute('title', FOCUS_TITLE);
    await expect(lobbyRow).not.toContainText('大区历史消息-预览哨兵');
    await expect(lobbyRow).toContainText(FOCUS_TITLE);
    await expect(lobbyRow.locator('.chat-chan__badge')).toHaveCount(0);

    // 主区：专注空态而非大区内容（无 URL ?channel=lobby 残留）
    await page.goto('/chat?channel=lobby');
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.chat-main__empty')).toContainText('已开启专注模式');

    // API 直打大区被服务端拦
    const send = await page.request.post('/api/chat/channels/lobby/messages', {
      data: { content: '越权发言' },
    });
    expect(send.status()).toBe(403);
    expect(((await send.json()) as { message: string }).message).toBe(FOCUS_TITLE);
    const list = await page.request.get('/api/chat/channels/lobby/messages');
    expect(list.status()).toBe(403);

    // 私聊不受影响（与 core 用户 admin 开一条）
    const dm = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.admin.id },
    });
    expect(dm.status()).toBe(200);
    const dmBody = (await dm.json()) as { channel: { id: string } };
    const msg = await page.request.post(`/api/chat/channels/${dmBody.channel.id}/messages`, {
      data: { content: '私聊可用' },
    });
    expect(msg.status()).toBe(200);
  });

  test('玩具：导航/首页卡片禁用带 title；/game 菜单页锁屏；子页直达', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await setFocus(page, true);

    // 导航「玩具」变 span（无链接）带 title
    await page.goto('/');
    await expect(page.locator('a.site-link[href="/game"]')).toHaveCount(0);
    const navToy = page.locator('span.site-link.is-disabled', { hasText: '玩具' });
    await expect(navToy).toHaveAttribute('title', FOCUS_TITLE);
    await expect(navToy).toHaveAttribute('aria-disabled', 'true');

    // 首页「进入玩具区」卡片禁用（div 而非链接）
    const gameCard = page.locator('.feature-card.card-game.is-disabled');
    await expect(gameCard).toHaveCount(1);
    await expect(gameCard).toHaveAttribute('title', FOCUS_TITLE);
    await expect(page.locator('a.feature-card.card-game[href="/game"]')).toHaveCount(0);

    // /game 菜单页锁屏
    await page.goto('/game');
    await expect(page.locator('h1', { hasText: '玩具' })).toBeVisible();
    await expect(page.locator('.game-card--focus-lock')).toContainText('已开启专注模式');
    await expect(page.locator('a[href="/settings#focus-mode"]')).toBeVisible();
    // 九个游戏卡不渲染
    await expect(page.locator('a.game-card:not([href="/photowall"])')).toHaveCount(0);

    // 子页直达不受影响（RSC 内嵌 payload 会含导航 title 文案，故断言真实 UI 而非 body 全文）
    await page.goto('/game/gomoku');
    await expect(page.locator('h1', { hasText: '五子棋' })).toBeVisible();
    await expect(page.locator('.game-card--focus-lock')).toHaveCount(0);
  });

  test('关闭后全部恢复', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const { id: catId } = await createFlaggedCategory(page);
    const flagged = await createBlogIn(page, catId);

    await setFocus(page, true);
    await page.goto('/blog');
    await expect(page.locator(`.blog-item:has-text("${flagged.title}")`)).toHaveCount(0);

    await setFocus(page, false);
    await page.goto('/blog');
    await expect(page.locator(`.blog-item:has-text("${flagged.title}")`)).toHaveCount(1);
    await expect(page.locator('.focus-banner')).toHaveCount(0);
    // 导航恢复可点
    await expect(page.locator('a.site-link[href="/game"]')).toHaveCount(1);
    await expect(page.locator('span.site-link.is-disabled')).toHaveCount(0);
  });
});
