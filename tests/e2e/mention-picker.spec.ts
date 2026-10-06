import { expect, test } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_BLOG, SEED_USERS } from './seed';

test('评论选人支持键盘，保留光标两边正文，提示框在视口内', async ({ page }, info) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);
  const input = page.locator('.comment-composer__input');
  await input.fill('前文 @e2e_ad 后文');
  // 真正移动光标，覆盖浏览器的 selectionchange（手发 select 不会触发 React onSelect）。
  await input.press('ArrowLeft');
  await input.press('ArrowLeft');
  await input.press('ArrowLeft');
  const option = page.getByRole('option', { name: '@e2e_admin', exact: true });
  await expect(option).toBeVisible();
  const box = await page.locator('.mention-picker').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `tests/.tmp/mention-picker-${info.project.name}.png` });
  await input.press('Enter');
  await expect(input).toHaveValue('前文 @e2e_admin 后文');
  await expect(page.getByRole('listbox', { name: '提及用户' })).toHaveCount(0);

  await input.fill('@e2e_');
  await expect(page.getByRole('option', { name: '@e2e_admin', exact: true })).toBeVisible();
  const second = await page.getByRole('option').nth(1).innerText();
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toHaveValue(`${second} `);
});

test('点选后匿名发表评论，收件人收到提及通知且可以打开文章', async ({ page, browser, isMobile }) => {
  const recipientContext = await browser.newContext();
  try {
    const recipientPage = await recipientContext.newPage();
    const target = await registerFreshUser(recipientPage, { core: true });
    const sender = await registerFreshUser(page, { core: true });
    await page.goto(`/blog/${SEED_BLOG.id}`);
    const input = page.locator('.comment-composer__input');
    await input.fill(`@${target.username.slice(0, -2)}`);
    const option = page.getByRole('option', { name: `@${target.username}`, exact: true });
    if (isMobile) await option.tap();
    else await option.click();
    await expect(input).toHaveValue(`@${target.username} `);
    const marker = uniqueTag();
    await input.press('End');
    await input.pressSequentially(marker);
    await page.locator('.comment-composer__anon input').check();
    await page.locator('.comment-composer__send').click();
    await expect(input).toHaveValue('');
    const response = await recipientPage.request.get('/api/notifications');
    const body = await response.json();
    const mentions = body.notifications.filter((n: { action: string }) => n.action === '评论提及');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].actor.id).toBeNull();
    expect(mentions[0].detail).toContain('匿名读者「');
    expect(JSON.stringify(mentions[0])).not.toContain(sender.username);
    await recipientPage.goto('/notifications');
    const card = recipientPage.locator('.notification-card', { hasText: '评论提及' });
    await expect(card.locator(`a[href="/blog/${SEED_BLOG.id}"]`)).toBeVisible();
  } finally { await recipientContext.close(); }
});

test('讨论大区提示排除专注账号，私聊只提示对方，切换会话不会保留旧结果', async ({ page }, info) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto('/chat?channel=lobby');
  const input = page.locator('.chat-composer__input');
  await input.fill('@e2e_');
  await expect(page.getByRole('option', { name: '@e2e_admin', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '@e2e_focus', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `tests/.tmp/mention-chat-${info.project.name}.png` });
  await input.fill('@e2e_owner');
  await expect(page.getByRole('option', { name: '@e2e_owner', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('@e2e_owner ');

  const response = await page.request.post('/api/chat/channels', { data: { user_id: SEED_USERS.focus.id } });
  expect(response.status()).toBe(200);
  const { channel } = await response.json();
  // 空私聊刻意不进 poll 的侧栏列表；先发一条，再通过 URL 切到这个会话。
  const message = await page.request.post(`/api/chat/channels/${channel.id}/messages`, {
    data: { content: `选人提示测试 ${uniqueTag()}` },
  });
  expect(message.status()).toBe(200);
  await page.goto(`/chat?channel=${channel.id}`);
  await input.fill('@e2e_');
  await expect(page.getByRole('option', { name: '@e2e_focus', exact: true })).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: '@e2e_focus', exact: true }).click();
  await expect(input).toHaveValue('@e2e_focus ');
});

test('Escape 关闭提示，邮件与名片不弹提示，中文输入法确认不会选人或发送', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);
  const input = page.locator('.comment-composer__input');
  await input.fill('@e2e_admin');
  await expect(page.getByRole('option', { name: '@e2e_admin', exact: true })).toBeVisible();
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('@e2e_admin');
  await input.dispatchEvent('compositionend');
  await expect(page.getByRole('option', { name: '@e2e_admin', exact: true })).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('.mention-picker')).toHaveCount(0);
  await expect(input).toHaveValue('@e2e_admin');
  for (const text of ['mail@e2e_admin', '[@用户/e2e_admin]']) {
    await input.fill(text);
    await expect(page.locator('.mention-picker')).toHaveCount(0);
  }
});

test('较早的搜索响应不能覆盖新前缀的结果', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);
  await page.route('**/api/mentions/users?**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'old') await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ json: { users: [{ id: query, username: query }] } });
  });
  const input = page.locator('.comment-composer__input');
  const oldRequest = page.waitForRequest((r) => r.url().includes('q=old'));
  await input.fill('@old');
  await oldRequest;
  await input.fill('@new');
  await expect(page.getByRole('option', { name: '@new', exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole('option', { name: '@new', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '@old', exact: true })).toHaveCount(0);
});

test('键盘选择长候选列表的末项会滚入提示框，正文保留在草稿中', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);
  await page.route('**/api/mentions/users?**', (route) => route.fulfill({ json: {
    users: Array.from({ length: 8 }, (_, i) => ({ id: `user-${i}`, username: `candidate_${i}` })),
  } }));
  const input = page.locator('.comment-composer__input');
  await input.fill('@candidate');
  await expect(page.getByRole('option')).toHaveCount(8);
  await input.press('ArrowUp');
  const last = page.getByRole('option', { name: '@candidate_7', exact: true });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => {
    const option = await last.boundingBox(), picker = await page.locator('.mention-picker').boundingBox();
    return !!option && !!picker && option.y >= picker.y && option.y + option.height <= picker.y + picker.height + 1;
  }).toBe(true);
  await input.press('Enter');
  await expect(input).toHaveValue('@candidate_7 ');
});
