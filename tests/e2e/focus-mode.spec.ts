// ─────────────────────────────────────────────────────────────────────────────
// focus-mode.spec.ts —— 专注模式（账号级浏览偏好）
//
// 【功能面】/settings 打开后：博客列表与侧栏隐藏「专注隐藏」栏目及其文章并显示
// 关闭横幅；讨论大区（lobby）侧栏行禁用、无最近一条预览。
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
// 文案从单一来源取，不在这里手抄一遍 —— 手抄的那份会在改文案时静默落后，
// 而症状是「用例红了，红在等待超时上」，指向的是用例自己而不是文案。（seed.ts 同款）
import { FOCUS_MODE_BLOCKED_TITLE as FOCUS_TITLE } from '../../src/lib/focus-mode';

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

  test('设置页开关 → 保存生效、刷新回显开；博客横幅「此处」深链到设置锚点', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    // 设置页 UI 开关（点击 label；input 视觉隐藏）
    await page.goto('/settings');
    await clickFocusToggle(page);
    await expect(page.locator('#focusAlert')).toContainText('已保存');
    // 再关再开：同一机制双向验证
    await clickFocusToggle(page);
    await expect(page.locator('#focusAlert')).toContainText('已保存');
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

  test('讨论：大区行禁用且无最近一条预览；API 直打大区 403；私聊不拦', async ({ page }) => {
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
    const lobbyRow = page.locator('.chat-chan', { hasText: '讨论大区' });
    await expect(lobbyRow).toBeAttached();
    await expect(lobbyRow).toHaveAttribute('aria-disabled', 'true');
    await expect(lobbyRow).toHaveAttribute('title', FOCUS_TITLE);
    await expect(lobbyRow).not.toContainText('大区历史消息-预览哨兵');
    await expect(lobbyRow).toContainText(FOCUS_TITLE);
    await expect(lobbyRow.locator('.chat-chan__mark')).toHaveCount(0);

    // 主区：不得再落在大区 —— ?channel=lobby 必须被改写。落点取决于当时有没有可用
    // 私聊（本套件 desktop 轮次先跑，会在库里留下一条私聊，mobile 复跑时它仍在）：
    // 无私聊 → ChatApp 清 URL 到 /chat、显示专注空态；有私聊 → 有意跳到第一条可用
    // 私聊（见 ChatApp 首载选频道策略注释「退回第一个可用行」）。两种都是正确行为，
    // 共同不变量是：URL 不再指向大区、主区也不渲染大区内容（哨兵消息只在 大区 出现）。
    // ChatApp 水合后的频道跳转可能与 goto 竞态，稳定抛「Navigation interrupted」
    // （触发与否取决于前置用例时序，整轮跑必现、单文件跑不一定 —— 别依赖运气）。
    // 跳转目标正是下面 toHaveURL 要验证的落点，中断本身无害，这里直接吞掉；
    // 产品回归（专注模式下仍可停留大区）会表现为 URL 停在 ?channel=lobby，
    // 由下一行断言兜住。
    await page.goto('/chat?channel=lobby', { waitUntil: 'commit' }).catch(() => {});
    await expect(page).toHaveURL(/\/chat(?:\?channel=(?!lobby)[^&]*)?$/);
    await expect(page.locator('.chat-main')).toBeVisible();
    await expect(page.locator('.chat-main')).not.toContainText('大区历史消息-预览哨兵');

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

  test('练手盘：入口置灰但**不隐藏**，点了不导航；两页 403；四个接口 403', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await setFocus(page, true);

    // 入口：还在、还看得见，但已不是链接 —— 这一条是「置灰不隐藏」的全部意思。
    // 隐藏掉入口会让开着专注模式的人以为练手盘被下线了（CLAUDE.md「入口不跟着藏」）。
    await page.goto('/fish');
    const tradeEntry = page.locator('.fish-card__info-link', { hasText: '鱼干练手盘' });
    const statsEntry = page.locator('.fish-card__info-link', { hasText: '练手盘统计' });
    for (const [name, entry] of [
      ['练手盘', tradeEntry],
      ['练手盘统计', statsEntry],
    ] as const) {
      await expect(entry, name).toBeVisible();
      await expect(entry, name).toHaveAttribute('aria-disabled', 'true');
      await expect(entry, name).toHaveAttribute('title', FOCUS_TITLE);
      // ★ 禁用态必须是「不导航的元素」而不是挂了类名的 <Link>：后者照样会跳走，
      //   灰了却点得动比不灰更糟（见 src/app/fish/TradeEntry.tsx）。
      expect(await entry.getAttribute('href'), `${name} 不该还带着 href`).toBeNull();
    }
    await tradeEntry.click();
    await expect(page).toHaveURL(/\/fish$/, { timeout: 3000 });
    // 上面那条行动条（.fish-card__actions）没被碰过：fish-layout.spec 钉死它恰好 3 颗
    await expect(page.locator('.fish-card__actions > *')).toHaveCount(3);

    // /fish/market 页脚那条入口同理（它是练手盘在 /fish 之外的唯一入口）
    await page.goto('/fish/market');
    const marketEntry = page.locator('.market-foot__link', { hasText: '鱼干练手盘' });
    await expect(marketEntry).toBeVisible();
    await expect(marketEntry).toHaveAttribute('aria-disabled', 'true');
    await expect(marketEntry).toHaveAttribute('title', FOCUS_TITLE);

    // 直连 URL：两页都原地 403（不是跳登录页 —— 他是登录着的）
    for (const p of ['/fish/trade', '/fish/trade/stats']) {
      const res = await page.goto(p);
      expect(res?.status(), p).toBe(403);
    }

    // 接口直打：四个都 403，且文案是专注那句（只看状态码的话，被档位顺手挡住也会绿）
    for (const [name, res] of [
      ['buy', await page.request.post('/api/fish/trade/buy', { data: { symbol: 'BTCUSDT', amount: 10 } })],
      ['sell', await page.request.post('/api/fish/trade/sell', { data: { position_id: 'x' } })],
      ['quote', await page.request.get('/api/fish/trade/quote')],
      [
        'candles',
        await page.request.get('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h'),
      ],
    ] as const) {
      expect(res.status(), `${name} 应 403 —— 漏一处就是专注模式没闸`).toBe(403);
      expect(((await res.json()) as { message: string }).message, name).toBe(FOCUS_TITLE);
    }
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
  });
});
