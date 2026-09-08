// ─────────────────────────────────────────────────────────────────────────────
// chat-features.spec.ts —— Phase C 新增的前端能力
//   · 链接自动识别（linkify → <a>，只认 http(s)）
//   · 点回复摘要跳到原消息并高亮
//   · 消息搜索 → 命中后跳转并高亮
//   · 日期分隔线
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
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
