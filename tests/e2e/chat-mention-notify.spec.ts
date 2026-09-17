// ─────────────────────────────────────────────────────────────────────────────
// chat-mention-notify.spec.ts —— @ 提及通知
//
// 【防的回归】讨论的产品口径是「收到消息不打扰，被 @ 才打扰」：
//   · 普通讨论消息**不**进通知列表（未读走顶栏徽标，见 chat-unread-mark.spec）；
//   · 每条 @ 我 的消息产生一条通知，通知里带「查看讨论」回到该会话；
//   · 在别人的私聊里被 @、专注模式下在大区被 @ —— 都不该收到通知；
//   · 读到该会话（进频道 / 在里面看新消息）→ 那条 @ 自动已读（铃铛归零，条目留在
//     列表里以已读态）；用例走接口推进已读，不等客户端 —— 无头环境下客户端已读
//     要求 document.hasFocus()，不可靠（同 chat-unread-mark.spec 的注释）；
//   · **正在看这个会话**时被 @ → 连条目都不产生（客户端 /viewing 报到 + 服务端
//     判「在看」，见 src/lib/chat-presence.ts）。
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
  return body.notifications.filter((n) => n.action === '讨论提及').length;
}

/**
 * 以指定身份发一条消息（可以是别的浏览器上下文，用来制造「别人在说话」）。
 *
 * ⚠️ 调用方传的是 SEED_USERS.admin —— 种子号在大区发言的限频桶（120 条/分钟）
 * 是两个 project 共用的。本文件目前每个用例只发 1~3 条，离上限还很远；但若哪天
 * 加用例把发帖量堆上去，务必改用 registerFreshUser 的一次性用户，
 * 理由详见 helpers.ts 的 registerFreshUser（已踩过一次 429）。
 */
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

        // 通知列表页：类型、正文预览与「查看讨论」入口
        await page.goto('/notifications');
        const card = page.locator('.notification-card', { hasText: '讨论提及' }).first();
        await expect(card).toBeVisible();
        await expect(card.locator('.notification-content')).toContainText(tag);
        await expect(card.locator('.notification-content')).toContainText('讨论大区');
        const link = card.locator('a', { hasText: '查看讨论' });
        await expect(link).toHaveAttribute('href', `/chat?channel=${LOBBY}`);
      } finally {
        await mentionCtx.close();
      }
    } finally {
      await plainCtx.close();
    }
  });

  test('读到该会话 → 那条 @ 通知自动已读（铃铛归零，条目仍在列表里）', async ({ page, browser }) => {
    const me = await registerFreshUser(page, { core: true });

    const ctx = await post(
      browser,
      SEED_USERS.admin.username,
      LOBBY,
      `@${me.username} 自动已读 ${uniqueTag()}`
    );
    try {
      expect(await mentionCount(page), '@ 一次应当收到一条').toBe(1);
      const bellCount = async () => {
        const res = await page.request.get('/api/notifications/count');
        expect(res.status()).toBe(200);
        return ((await res.json()) as { count: number }).count;
      };
      expect(await bellCount(), '铃铛上应当挂着这条未读').toBe(1);

      // 读到该会话。网页端进大区 / 在大区里看新消息时会自己发这个请求（ChatApp.markRead），
      // 这里直接打接口 —— 无头环境下客户端已读要求 document.hasFocus()，不可靠
      // （同 chat-unread-mark.spec.ts 的注释）。
      const read = await page.request.post(`/api/chat/channels/${LOBBY}/read`);
      expect(read.status()).toBe(200);
      expect(await bellCount(), '读到该会话 = 那条 @ 已看见，铃铛归零').toBe(0);

      // 清的是「未读」不是「条目」：通知还在列表里（已读态），没有被删掉
      await page.goto('/notifications');
      await expect(page.locator('.notification-card', { hasText: '讨论提及' }).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('正在看这个会话 → @ 我根本不产生通知（客户端报到 + 服务端判「在看」）', async ({ page, browser }) => {
    const me = await registerFreshUser(page, { core: true });

    // 停在讨论大区。客户端一进来就会 POST /viewing 报到「我正在看这个会话」——
    // 等这次**响应**回来再发消息：服务端已经记下了，抑制判定才是确定性的
    //（等请求发出不够，那只证明浏览器发得出去）。
    const reported = page.waitForResponse(
      (r) => r.url().includes('/viewing') && r.request().method() === 'POST'
    );
    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(page.locator('.chat-main')).toBeVisible();
    await reported;

    const ctx = await post(
      browser,
      SEED_USERS.admin.username,
      LOBBY,
      `@${me.username} 我在看着呢 ${uniqueTag()}`
    );
    try {
      // 判据是**列表里有没有这条**，不是铃铛数字 —— 数字归零有两种成因（没产生 /
      // 产生了又被自动已读），只有「列表里数不出条目」才证明是抑制生效。
      expect(await mentionCount(page), '人就在大区里看着，不该再有这条通知').toBe(0);
    } finally {
      await ctx.close();
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
