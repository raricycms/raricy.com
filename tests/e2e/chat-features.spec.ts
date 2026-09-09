// ─────────────────────────────────────────────────────────────────────────────
// chat-features.spec.ts —— Phase C 新增的前端能力
//   · 链接自动识别（linkify → <a>，只认 http(s)）
//   · 点回复摘要跳到原消息并高亮
//   · 消息搜索 → 命中后跳转并高亮
//   · 日期分隔线
//   · Markdown 正文渲染 + XSS 不执行（原始 HTML / 伪协议）
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 以当前身份在大区发一条消息，返回其 id。 */
async function postLobby(
  page: import('@playwright/test').Page,
  content: string,
  replyTo?: number
): Promise<number> {
  const res = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
    data: replyTo ? { content, reply_to: replyTo } : { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { message: { id: number } };
  return body.message.id;
}

/**
 * 按哨兵串定位消息行。
 * 必须限定在 `.chat-msg__content` 内匹配 —— 回复消息的引用块里也会出现原文，
 * 只按行文本过滤会同时命中「原消息」和「回复消息」两行（strict mode 直接报错）。
 */
function msgRow(page: import('@playwright/test').Page, marker: string) {
  return page.locator('.chat-msg', {
    has: page.locator('.chat-msg__content', { hasText: marker }),
  });
}

test.describe('聊天功能：链接 / 跳转 / 搜索 / 日期分隔', () => {
  test('正文里的 http(s) 链接渲染成可点链接，且带 noopener', async ({ page }) => {
    const marker = `e2e-link-${uniqueTag()}`;
    const url = 'https://example.com/e2e-link-target';
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, `${marker} ${url}`);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const link = row.locator('a.chat-msg__link');
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('点回复摘要 → 跳到原消息并短暂高亮', async ({ page }) => {
    const tag = uniqueTag();
    const orig = `e2e-orig-${tag}`;
    const reply = `e2e-reply-${tag}`;

    await loginViaApi(page, SEED_USERS.admin.username);
    const origId = await postLobby(page, orig);
    await postLobby(page, reply, origId);

    await page.context().clearCookies();
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const replyRow = msgRow(page, reply);
    await expect(replyRow).toBeVisible();
    await replyRow.locator('.chat-msg__reply').click();

    // 高亮类名只挂 2 秒，用 toHaveClass 的自动重试去抓
    await expect(msgRow(page, orig)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });
  });

  test('搜索命中后跳转并高亮该条消息', async ({ page }) => {
    const marker = `e2e-search-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, `${marker} 搜索目标`);

    await page.goto(`/chat?channel=${LOBBY}`);
    await page.locator('.chat-main__search').click();

    const input = page.locator('.chat-new-search');
    await expect(input).toBeVisible();
    await input.fill(marker);

    const hit = page.locator('.chat-search-item', { hasText: marker });
    await expect(hit).toBeVisible({ timeout: 8000 });
    await hit.click();

    await expect(msgRow(page, marker)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });
  });

  test('消息列表带日期分隔线', async ({ page }) => {
    const marker = `e2e-sep-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, marker);

    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(msgRow(page, marker)).toBeVisible();
    // 首条消息之前必定有一条日期分隔（今天/昨天/日期）
    await expect(page.locator('.chat-date-sep').first()).toBeAttached();
  });
});

test.describe('Markdown 渲染', () => {
  test('正文按 Markdown 渲染（粗体 / 行内代码 / 列表 / 引用）', async ({ page }) => {
    const marker = `e2e-md-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(
      page,
      [
        marker,
        '',
        '**粗体标记** 和 `行内代码`',
        '',
        '- 列表项一',
        '- 列表项二',
        '',
        '> 引用块',
      ].join('\n')
    );

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const md = row.locator('.chat-msg__md');
    await expect(md.locator('strong')).toHaveText('粗体标记');
    await expect(md.locator('code')).toHaveText('行内代码');
    await expect(md.locator('ul > li')).toHaveCount(2);
    await expect(md.locator('blockquote')).toHaveText('引用块');
    // Markdown 语法符号本身不该出现在可见文本里
    await expect(md).not.toContainText('**粗体标记**');
  });

  test('原始 HTML / 伪协议一律不执行（XSS）', async ({ page }) => {
    const marker = `e2e-xss-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(
      page,
      [
        marker,
        '<img src=x onerror="window.__xssImg=1">',
        '<script>window.__xssScript=1</script>',
        '[点我](javascript:window.__xssLink=1)',
        // marked 的 inRawBlock 裸文本通道：畸形标签（属性间缺空格）曾直出成真元素
        'x<code><input type="password"y></code>请输入密码',
      ].join('\n')
    );

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const md = row.locator('.chat-msg__md');
    await expect(md.locator('script')).toHaveCount(0);
    await expect(md.locator('img')).toHaveCount(0);
    // 畸形标签不得渲染出真表单控件（含 GFM 任务列表之外的任何 input）
    await expect(md.locator('input')).toHaveCount(0);
    // 危险链接保留文字但摘掉 href（点了也不会执行）
    await expect(md.locator('a', { hasText: '点我' })).not.toHaveAttribute('href');

    // 真·执行探测：onerror / <script> / javascript: href 只要有一个生效，
    // 这几个全局变量就会被赋值。
    const executed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return [w.__xssImg, w.__xssScript, w.__xssLink].filter((v) => v !== undefined);
    });
    expect(executed).toEqual([]);
  });
});

test.describe('会话偏好（静音 / 删除会话）', () => {
  /** 私聊行 = 带头像（.chat-chan__avatar）而非大区图标（.chat-chan__icon）的行。 */
  function dmRow(page: import('@playwright/test').Page, peer: string) {
    return page
      .locator('.chat-chan-wrap', { hasText: peer })
      .filter({ hasNot: page.locator('.chat-chan__icon') })
      .first();
  }

  /** 移动端侧栏是抽屉（默认移出视口）→ 先点汉堡按钮拉开。 */
  async function openSidebarIfMobile(page: import('@playwright/test').Page, isMobile: boolean) {
    if (isMobile) await page.locator('.chat-main__menu').click();
  }

  test('「⋯」菜单可以静音会话，静音后行内出现静音标记', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    // 确保与 admin 的私聊存在（重复发起会复用同一个频道）
    const created = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.admin.id },
    });
    expect(created.status()).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
    // 空会话不进侧栏（1.6）——先发一条消息把它变成真实会话，否则侧栏里根本没有这一行
    await page.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: `e2e-mute-${uniqueTag()}` },
    });

    await page.goto('/chat');
    await openSidebarIfMobile(page, isMobile);
    const row = dmRow(page, SEED_USERS.admin.username);
    await expect(row).toBeVisible();

    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-avatar-menu__item', { hasText: '静音' }).click();

    await expect(row.locator('.chat-chan__muted')).toBeAttached({ timeout: 5000 });

    // 还原：取消静音（避免影响同库的其他用例）
    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-avatar-menu__item', { hasText: '取消静音' }).click();
    await expect(row.locator('.chat-chan__muted')).toHaveCount(0);
  });

  test('删除会话后该行从侧栏消失（对方再发消息会重新出现）', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const created = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.owner.id },
    });
    expect(created.status()).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
    // desktop 与 mobile 共用同一个 e2e 库：上一轮可能已把这个会话隐藏过，
    // 发一条新消息让它重新出现（这本身也是「新消息即复现」的行为验证）。
    await page.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: `e2e-unhide-${uniqueTag()}` },
    });

    await page.goto('/chat');
    await openSidebarIfMobile(page, isMobile);
    const row = dmRow(page, SEED_USERS.owner.username);
    await expect(row).toBeVisible();

    page.on('dialog', (d) => void d.accept()); // 删除前有 confirm
    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-avatar-menu__item', { hasText: '删除会话' }).click();

    await expect(row).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('发起私聊', () => {
  /** 私聊行 = 带头像（.chat-chan__avatar）而非大区图标（.chat-chan__icon）的行。 */
  function dmRow(page: import('@playwright/test').Page, peer: string) {
    return page
      .locator('.chat-chan-wrap', { hasText: peer })
      .filter({ hasNot: page.locator('.chat-chan__icon') })
      .first();
  }

  /**
   * 点一次就进会话、且这一行要留得住。
   *
   * 【为什么是 admin ↔ owner】这条用例要的是「双方都还没发过消息」的空会话 ——
   * 服务端列表刻意不返回空会话（防骚扰），正是这条用例要防的回归面。全套用例里
   * 只有 core↔admin、core↔owner 被用过，admin↔owner 始终是空的。
   *
   * 【防的回归】URL 里的 ?channel= 是应用自己写的镜像。旧实现把它放在「首次加载」
   * effect 的依赖里：发起私聊 → router.replace → effect 重跑 → 拉回不含空会话的
   * 服务端列表整表替换 → 刚建的私聊被冲掉、选中态退回大区。于是「发起私聊要点
   * 两次才成功」（第二次 URL 没变、effect 不重跑，才侥幸留下）。
   */
  test('点一次就进入会话，且对账后该行仍在侧栏', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/chat');
    if (isMobile) await page.locator('.chat-main__menu').click();

    await page.locator('.chat-new-btn').click();
    await page.locator('.chat-new-item', { hasText: SEED_USERS.owner.username }).click();

    // 弹窗关闭 + 直接进入该会话
    await expect(page.locator('.chat-new-modal')).toHaveCount(0);
    await expect(page.locator('.chat-main__title')).toHaveText(SEED_USERS.owner.username);

    // 窗口重新聚焦 → 触发一次对账（整表替换 channels）。空会话必须被补回来。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    // 移动端侧栏是抽屉，进会话时被关掉了 → 再拉开
    if (isMobile) await page.locator('.chat-main__menu').click();

    await expect(dmRow(page, SEED_USERS.owner.username)).toBeVisible();
    await expect(page.locator('.chat-main__title')).toHaveText(SEED_USERS.owner.username);
  });
});

test.describe('聊天页布局', () => {
  /**
   * 聊天区是满屏工作台（.chat-page 高 calc(100vh - 62px)），站点页脚在它下面
   * 会把文档撑过一屏 —— 多出整页滚动条，滚一下连输入框都被顶出视野。
   * 断言落在「页脚不存在」+「文档没有溢出」两条上：只断言前者的话，将来若换成
   * 用 CSS 隐藏（display:none 之外的写法）仍可能留下高度。
   */
  test('/chat 不渲染站点页脚，且整页没有滚动条', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/chat');
    await expect(page.locator('.chat-page')).toBeVisible();

    await expect(page.locator('footer.site-footer')).toHaveCount(0);

    // 移动端 viewport 高度在 Playwright 里是固定的，理论上同样成立；
    // 但移动端还有地址栏/抽屉等变量，只对桌面端断言高度。
    if (!isMobile) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight
      );
      expect(overflow, '聊天页不应出现整页滚动条').toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 进入频道后的滚动位置
//
// 【为什么必须降速跑】旧写法在 messages 落库后的 rAF 里滚到底。React 的提交走调度器
// （并发渲染会分片让出主线程），rAF 完全可能早于提交执行 —— 那一刻列表还是空的，
// scrollTo 到旧的 scrollHeight 等于没滚，进来就停在顶部。桌面全速下两者顺序通常
// 恰好是对的（用例会假绿），把 CPU 降到 1/4（手机的真实情形）才稳定复现。
// 降速靠 CDP，故只在 Chromium 跑。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('进入聊天区停在最新消息', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CPU 降速依赖 CDP（仅 Chromium）');
  test.use({ viewport: { width: 390, height: 844 } });

  test('首屏停在底部，而不是顶部', async ({ page, context }) => {
    await registerFreshUser(page, { core: true }); // 新用户：独占发言限频额度
    const tag = uniqueTag();
    for (let i = 0; i < 25; i++) {
      const res = await page.request.post('/api/chat/channels/lobby/messages', {
        data: { content: `e2e-scroll-${tag}-${i} 稍长一点的内容，用来把列表撑过一屏。` },
      });
      expect(res.status(), await res.text()).toBe(200);
    }

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto('/chat?channel=lobby');
    await expect(page.locator('.chat-msg').last()).toBeVisible();

    const list = page.locator('.chat-list');
    // 前提：列表确实超出一屏 —— 否则「停在底部」这件事没有意义（断言会假绿）
    expect(
      await list.evaluate((el) => el.scrollHeight - el.clientHeight),
      '列表没有超出一屏，本用例失去意义'
    ).toBeGreaterThan(300);

    // 距底部 <40px 即视为「在最新消息处」（浏览器亚像素/缩放留一点余量）
    await expect
      .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40);
  });
});
