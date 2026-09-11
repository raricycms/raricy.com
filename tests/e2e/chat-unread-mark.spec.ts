// ─────────────────────────────────────────────────────────────────────────────
// chat-unread-mark.spec.ts —— 未读角标（图标右上角）+ 移动端汉堡红点
//
// 【防的回归】
//   1. 大区只有被 @ 才亮红点：普通新消息不打扰（大区是全站最吵的频道，
//      老实现「任何未读都计数」会让大区行永远挂着徽标）。
//   2. 角标挂在**图标右上角**，不是行右侧 —— 折叠轨道（60px）与移动端抽屉里
//      都还看得见（旧实现在折叠态直接 display: none，等于没有提示）。
//   3. 手机端侧栏是抽屉：关着时唯一的未读信号是汉堡上的红点；拉开抽屉后隐藏
//      （列表里已经看得见角标）。
//
// 【造数纪律】大区是全站共用频道，别的用例也在往里发消息：
//   · 只断言「我这个全新用户」的行，绝不数行数；
//   · 每个用例注册全新 core 用户 —— 大区基线 = 首屏 poll 时的最大消息 id，
//     未读从 0 起算，不受历史消息影响。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 以 page 当前登录身份发一条消息，返回消息 id。 */
async function postMessage(page: Page, channelId: string, content: string): Promise<number> {
  const res = await page.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { message: { id: number } }).message.id;
}

/**
 * 造一个「大区不是当前频道」的干净场景。
 *
 * 【为什么要落到私聊】大区若是当前频道，新消息会被合并进列表并立即已读 ——
 * 未读角标根本来不及出现。落到私聊后大区变成非活动频道，新消息走 SSE 的
 * 本地累加分支（正是角标要验的那条链路）。
 *
 * 私聊的未读用**接口**推进读游标：客户端 markRead 要求 document.hasFocus()，
 * 无头多上下文下页面未必持有焦点，靠它清零会随机残留未读、污染汉堡红点断言。
 */
async function setupUserOffLobby(page: Page, browser: Browser) {
  const me = await registerFreshUser(page, { core: true });

  const speakerCtx = await browser.newContext();
  const speaker = await speakerCtx.newPage();
  await loginViaApi(speaker, SEED_USERS.admin.username);
  const created = await speaker.request.post('/api/chat/channels', {
    data: { user_id: me.id },
  });
  expect(created.status()).toBe(200);
  const dmId = ((await created.json()) as { channel: { id: string } }).channel.id;
  const dmMsgId = await postMessage(speaker, dmId, `e2e-dm-${uniqueTag()}`);
  const read = await page.request.post(`/api/chat/channels/${dmId}/read`, {
    data: { message_id: dmMsgId },
  });
  expect(read.status()).toBe(200);

  await page.goto(`/chat?channel=${dmId}`);
  await expect(page.locator('.chat-main')).toBeVisible();
  // 【必须等首屏频道列表落地，别删】大区成员行由 listChannelsForUser **懒建**，
  // 基线 = 建行那一刻的最大消息 id（历史不算未读）。若不等它完成就发大区消息，
  // 建行可能落在那条消息之后 → 它被当成「历史」不算未读，chatUnread 于是为 false
  // ——而 @ 的通知在发送时就已落库，铃铛照样显 1。症状是「铃铛有数字、聊天红点不亮」
  // 的假失败（mobile 那一轮跑在整套最后，慢一点就踩中）。
  // 大区行出现 = 池子已建好，此后的大区消息必被算作未读。
  await expect(page.locator('.chat-chan', { hasText: '聊天大区' }).first()).toBeAttached();

  return { me, speaker, dmId, close: () => speakerCtx.close() };
}

test.describe('未读角标：大区只认 @', () => {
  test('大区普通消息不亮红点，被 @ 才亮（红点，不带数字）', async ({ page, browser }) => {
    const { me, speaker, close } = await setupUserOffLobby(page, browser);
    try {
      const lobbyRow = page.locator('.chat-chan', { hasText: '聊天大区' }).first();
      await expect(lobbyRow).toBeAttached();
      await expect(lobbyRow.locator('.chat-chan__mark')).toHaveCount(0);

      // 普通消息：预览更新即证明 SSE 已处理这条消息 —— 但红点不该出现
      const plain = `e2e-plain-${uniqueTag()}`;
      await postMessage(speaker, LOBBY, plain);
      await expect(lobbyRow.locator('.chat-chan__preview')).toContainText(plain);
      await expect(lobbyRow.locator('.chat-chan__mark')).toHaveCount(0);
      await expect(lobbyRow).not.toHaveClass(/has-unread/);

      // @ 我：红点亮起，且大区只亮红点（不显示数字 —— 公共频道里的条数没有意义）
      await postMessage(speaker, LOBBY, `@${me.username} 看这里`);
      await expect(lobbyRow.locator('.chat-chan__mark')).toHaveCount(1);
      await expect(lobbyRow.locator('.chat-chan__mark--num')).toHaveCount(0);
      await expect(lobbyRow).toHaveClass(/has-unread/);
    } finally {
      await close();
    }
  });
});

test.describe('顶栏「聊天」链接红点：聊天未读不进铃铛', () => {
  // 聊天消息不进通知列表（唯一进列表的是 @ 提及，见 chat-service），所以聊天未读
  // 绝不能计进铃铛数字 —— 线上就这样：铃铛写着 3，点进 /notifications 只有 1 条。
  // 现在两条各归各的（/api/notifications/count 返回 { count, chatUnread }）：
  // 铃铛数字 = 通知列表；私聊未读 / 大区被 @ → 「聊天」链接右上角的小红点。
  //
  // 红点开关是 base.js 写的**行内 display**，故断言走 toHaveCSS 而不是 toBeVisible：
  // 移动端整个顶栏折叠成 max-height:0（_header.scss），被裁掉的元素在 Playwright
  // 眼里仍「有包围盒 = 可见」，toBeVisible 会在被裁的情况下照样放行。

  const dot = (page: Page) => page.locator('#chatUnreadDot');

  test('私聊新消息 → 只亮「聊天」红点，铃铛毫不动静', async ({ page, browser }) => {
    const { speaker, dmId, close } = await setupUserOffLobby(page, browser);
    try {
      const badge = page.locator('#notificationBadge');
      // 私聊已读、大区无 @、没有站内通知 → 两个提示都不在
      await expect(badge).toBeHidden();
      await expect(dot(page)).toHaveCSS('display', 'none');

      // 切到大区：私聊变成非活动频道，新消息才会留下未读（活动频道会被自动已读）
      await page.goto(`/chat?channel=${LOBBY}`);
      await expect(page.locator('.chat-main')).toBeVisible();

      await postMessage(speaker, dmId, `e2e-badge-${uniqueTag()}`);
      // 徽标刷新是 2s 尾沿节流 + 一次收尾预约（见 ChatApp.refreshTopbarBadge），
      // 默认 5s 断言超时在慢机器上贴着边 —— 给足一整个节流窗口 + 余量
      await expect(dot(page)).toHaveCSS('display', 'block', { timeout: 12_000 });
      // 【回归】这条私聊绝不能把铃铛顶出个数字：通知列表里根本数不出它
      await expect(badge).toBeHidden();

      // 读掉这条私聊 → 整页重载后红点熄灭
      const read = await page.request.post(`/api/chat/channels/${dmId}/read`);
      expect(read.status()).toBe(200);
      await page.goto(`/chat?channel=${LOBBY}`);
      await expect(dot(page)).toHaveCSS('display', 'none');
    } finally {
      await close();
    }
  });

  test('大区 @ 我 → 通知进铃铛显条数，「聊天」红点同时亮', async ({ page, browser }) => {
    const { me, speaker, close } = await setupUserOffLobby(page, browser);
    try {
      const badge = page.locator('#notificationBadge');
      await expect(badge).toBeHidden();

      // setup 停在私聊上 → 大区是非活动频道，@ 消息不会被自动读掉
      await postMessage(speaker, LOBBY, `@${me.username} 顶栏红点`);
      // @ 是聊天里唯一进通知列表的东西（见 chat-service.notifyChannelMentions），
      // 所以铃铛显数字；大区那条未读同时点亮聊天红点 —— 两个指示器互不干扰
      await expect(badge).toHaveText('1', { timeout: 12_000 });
      await expect(badge).toBeVisible();
      await expect(dot(page)).toHaveCSS('display', 'block');
    } finally {
      await close();
    }
  });

  test('通知读掉、大区那条 @ 仍未读 → 铃铛归零，红点仍亮', async ({ page, browser }) => {
    const { me, speaker, close } = await setupUserOffLobby(page, browser);
    try {
      const badge = page.locator('#notificationBadge');
      await postMessage(speaker, LOBBY, `@${me.username} 红点`);
      await expect(badge).toHaveText('1', { timeout: 12_000 });

      // 把通知全标已读 → 铃铛必须整个消失（旧实现这里会退化成一个小红点，等于
      // 用红点暗示「通知列表里有东西」，可列表已经空了）。聊天未读不受影响。
      const readAll = await page.request.post('/api/notifications/read-all');
      expect(readAll.status()).toBe(200);
      await page.goto('/notifications'); // 整页加载 → 顶栏两个提示一起重算
      await expect(badge).toBeHidden();
      await expect(dot(page)).toHaveCSS('display', 'block');
    } finally {
      await close();
    }
  });
});

test.describe('移动端汉堡红点', () => {
  test('抽屉关着时汉堡标红点，拉开后隐藏', async ({ page, browser, isMobile }) => {
    test.skip(!isMobile, '汉堡按钮只在 ≤900px 的抽屉布局里出现');
    const { me, speaker, close } = await setupUserOffLobby(page, browser);
    try {
      const dot = page.locator('.chat-main__menu-dot');
      // 私聊已读、大区暂无 @ → 不该有红点
      await expect(dot).toHaveCount(0);

      await postMessage(speaker, LOBBY, `@${me.username} 在吗`);
      await expect(dot).toBeVisible();

      await page.locator('.chat-main__menu').click(); // 拉开抽屉
      await expect(page.locator('.chat-sidebar')).toBeInViewport();
      await expect(dot).toHaveCount(0);

      // 收起抽屉走「«」而不是汉堡：抽屉(z-index 30)盖住了头部左侧，
      // 汉堡在拉开状态下点不到（这也是既有行为，见 chat-sidebar.spec.ts）
      await page.locator('.chat-sidebar__collapse').click();
      await expect(page.locator('.chat-sidebar')).not.toBeInViewport();
      await expect(dot).toBeVisible();
    } finally {
      await close();
    }
  });
});
