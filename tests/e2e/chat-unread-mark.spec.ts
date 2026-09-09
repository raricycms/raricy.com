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

  return { me, speaker, close: () => speakerCtx.close() };
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
