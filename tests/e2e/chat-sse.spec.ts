// ─────────────────────────────────────────────────────────────────────────────
// chat-sse.spec.ts —— 聊天实时推送（SSE）端到端
//
// 【为什么要 E2E】SSE 是「流式响应 + 长连接 + 浏览器 EventSource 自动重连」的组合：
//   · 响应头错一个（比如少了 Cache-Control: no-transform）→ next start 的压缩中间件
//     会把事件攒到流结束才发，单测完全看不见（实测过：4 条事件在 +1241ms 一次性到达）；
//   · EventSource 只在真浏览器里跑，订阅注册表与浏览器的连接生命周期要对得上；
//   · 「不刷新页面就能看到对方发的消息」是用户能感知的最终行为。
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 用另一个浏览器上下文（= 另一个登录用户）在指定频道发消息。 */
async function postAs(
  browser: import('@playwright/test').Browser,
  username: string,
  channelId: string,
  content: string
) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaApi(page, username);
  const res = await page.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
  return ctx;
}

test.describe('聊天 SSE 实时推送', () => {
  test('响应头必须带 no-transform（否则 next start 的压缩会攒帧）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const headers = await page.evaluate(async () => {
      const ac = new AbortController();
      const res = await fetch('/api/chat/stream', { signal: ac.signal });
      const h = {
        contentType: res.headers.get('content-type'),
        cacheControl: res.headers.get('cache-control'),
      };
      ac.abort(); // 只看响应头，立刻断掉，别留一条空连接
      return h;
    });

    expect(headers.contentType).toContain('text/event-stream');
    expect(headers.cacheControl).toContain('no-transform');
  });

  test('对方在大区发消息 → 本端不刷新即出现（对账轮询是 60 秒，能秒到就是 SSE）', async ({
    page,
    browser,
  }) => {
    const marker = `e2e-sse-${uniqueTag()}`;

    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(page.locator('.chat-main')).toBeVisible();

    const speakerCtx = await postAs(browser, SEED_USERS.admin.username, LOBBY, marker);
    try {
      await expect(page.locator('.chat-msg', { hasText: marker })).toBeVisible({ timeout: 8000 });
    } finally {
      await speakerCtx.close();
    }
  });

  // 【为什么值得一条用例】自己发的消息会走两条链路回到客户端：POST 响应 + SSE 回声
  // （回声是给同账号的其他标签页用的，不能省）。两条链路谁先到都可能 —— 早先只有 SSE
  // 那一侧按 id 去重，POST 响应侧无脑 append，于是同一 id 渲染成两个气泡（React key
  // 也撞）。这条用例钉死「一次 Enter = 一个气泡 + 一次 POST」。
  test('自己发消息 → 只出现一个气泡（POST 响应与 SSE 回声按 id 去重）', async ({
    page,
    isMobile,
  }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/chat\/channels\/[^/]+\/messages$/.test(r.url())) {
        posts.push(r.url());
      }
    });

    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(page.locator('.chat-main')).toBeVisible();

    const ta = page.locator('.chat-composer__input');
    // 连发几轮：POST 响应与 SSE 回声的先后是时序竞争，单轮碰不上不代表没 bug
    for (let i = 0; i < 3; i++) {
      const marker = `e2e-sse-echo-${uniqueTag()}-${i}`;
      const before = posts.length;
      await ta.fill(marker);
      // 触屏设备的虚拟键盘没有 Shift，Enter 只能承担换行，发送交给按钮
      //（ChatComposer 的 useCoarsePointer）。两种输入方式走的是同一条 send()。
      if (isMobile) await page.locator('.chat-composer__send').click();
      else await ta.press('Enter');
      await expect(page.locator('.chat-msg', { hasText: marker }).first()).toBeVisible({
        timeout: 8000,
      });
      // 等回声那条链路也跑完（否则可能在重复气泡出现之前就断言了）
      await page.waitForTimeout(500);
      expect(posts.length - before, `第 ${i} 轮发了不止一次 POST`).toBe(1);
      const bubbles = page.locator('.chat-msg', { hasText: marker });
      await expect(bubbles, `第 ${i} 轮出现了重复气泡`).toHaveCount(1);
    }
  });

  test('私聊消息推到非活动频道 → 侧栏未读徽标即时出现（含别人新发起的会话）', async ({
    page,
    browser,
  }) => {
    const marker = `e2e-sse-dm-${uniqueTag()}`;

    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(page.locator('.chat-main')).toBeVisible();

    // 对方（admin）先发起与本用户的私聊，再发消息 —— 会话是页面加载之后才出现的
    const speakerCtx = await browser.newContext();
    const speaker = await speakerCtx.newPage();
    await loginViaApi(speaker, SEED_USERS.admin.username);
    const created = await speaker.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.core.id },
    });
    expect(created.status()).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
    await speaker.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: marker },
    });

    try {
      // 用本轮唯一的哨兵串定位私聊行 —— 不能按对方用户名过滤：大区行的预览里
      // 也会出现「e2e_admin：…」（大区是全站共用频道，别的用例刚发过消息）。
      const row = page.locator('.chat-chan', { hasText: marker }).first();
      await expect(row).toBeAttached({ timeout: 8000 });
      // 只断言「有未读且是正数」：desktop / mobile 两个 project 共用同一个 e2e 库，
      // 私聊频道会被复用，角标数不是固定的 1。
      // 角标挂在图标右上角（.chat-chan__mark--num 里的数字），见 chat-unread-mark.spec.ts。
      await expect(row.locator('.chat-chan__mark-num')).toHaveText(/^[1-9]\d*$/, { timeout: 8000 });
    } finally {
      await speakerCtx.close();
    }
  });
});
