// ─────────────────────────────────────────────────────────────────────────────
// chat-mention-notify.spec.ts —— @ 提及通知
//
// 【防的回归】聊天的产品口径是「收到消息不打扰，被 @ 才打扰」：
//   · 普通聊天消息**不**进通知列表（未读走顶栏徽标，见 chat-unread-mark.spec）；
//   · 每条 @ 我 的消息产生一条通知，通知里带「查看聊天」回到该会话；
//   · 在别人的私聊里被 @、专注模式下在大区被 @ —— 都不该收到通知。
//
// 【造数纪律】大区是全站共用频道：只断言「我这个全新用户」的通知，不数总数。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 当前登录身份收到的 @ 通知条数（走通知接口，与页面渲染同一份数据）。 */
async function mentionCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications?page=1');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { notifications: { action: string }[] };
  return body.notifications.filter((n) => n.action === '聊天提及').length;
}

/** 以指定身份发一条消息（可以是别的浏览器上下文，用来制造「别人在说话」）。 */
async function post(browser: Browser, username: string, channelId: string, content: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaApi(page, username);
  const res = await page.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
  return ctx;
}

test.describe('@ 提及通知', () => {
  test('普通消息不打扰，被 @ 时收到一条通知，且能跳回会话', async ({ page, browser }) => {
    const me = await registerFreshUser(page, { core: true });
    expect(await mentionCount(page), '刚注册不该有任何通知').toBe(0);

    const plainCtx = await post(browser, SEED_USERS.admin.username, LOBBY, `e2e-plain-${uniqueTag()}`);
    try {
      expect(await mentionCount(page), '大区普通消息不该产生通知').toBe(0);

      const tag = uniqueTag();
      // @ 用户名后面必须紧跟空白（与前端高亮、红点计数同一口径）→ 正文里带 tag
      // 只能放在 @ 之后，所以这里把 tag 放在「你好」后面：@me 你好 e2e-xxx
      const mentionCtx = await post(
        browser,
        SEED_USERS.admin.username,
        LOBBY,
        `@${me.username} 你好 ${tag}`
      );
      try {
        expect(await mentionCount(page), '@ 一次应当收到一条').toBe(1);

        // 通知列表页：类型、正文预览与「查看聊天」入口
        await page.goto('/notifications');
        const card = page.locator('.notification-card', { hasText: '聊天提及' }).first();
        await expect(card).toBeVisible();
        await expect(card.locator('.notification-content')).toContainText(tag);
        await expect(card.locator('.notification-content')).toContainText('聊天大区');
        const link = card.locator('a', { hasText: '查看聊天' });
        await expect(link).toHaveAttribute('href', `/chat?channel=${LOBBY}`);
      } finally {
        await mentionCtx.close();
      }
    } finally {
      await plainCtx.close();
    }
  });

  test('在别人的私聊里被 @ 不会收到通知', async ({ page, browser }) => {
    // 我起一个私聊对象；另外两人另起一个私聊，在里面 @ 我 → 我看不到那条消息，就不该有通知
    const me = await registerFreshUser(page, { core: true });

    const ctx = await browser.newContext();
    const stranger = await ctx.newPage();
    await loginViaApi(stranger, SEED_USERS.core.username);
    const started = await stranger.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.admin.id },
    });
    expect(started.status()).toBe(200);
    const theirChannel = ((await started.json()) as { channel: { id: string } }).channel.id;

    const res = await stranger.request.post(`/api/chat/channels/${theirChannel}/messages`, {
      data: { content: `@${me.username} 借一步说话 ${uniqueTag()}` },
    });
    expect(res.status()).toBe(200);

    expect(await mentionCount(page), '别人私聊里的 @ 不该发通知').toBe(0);
    await ctx.close();
  });

  test('专注模式下在大区被 @ 不会收到通知', async ({ page, browser }) => {
    // 种子里的 e2e_focus 开着专注模式（见 seed.ts）—— 大区对他不可见
    await loginViaApi(page, 'e2e_focus');
    const before = await mentionCount(page);

    const ctx = await post(
      browser,
      SEED_USERS.admin.username,
      LOBBY,
      `@e2e_focus 在吗 ${uniqueTag()}`
    );
    try {
      expect(await mentionCount(page), '专注模式下大区的 @ 不该发通知').toBe(before);
    } finally {
      await ctx.close();
    }
  });
});
