import { expect, test } from '@playwright/test';
import { registerFreshUser, loginViaApi, publishBlog, uniqueTag } from './helpers';
import { fmtFish } from '../../src/lib/fish-amount';

// 走已有 core+ 签到与转账筹资，测试也不直接改余额。
test('商城租赁 → 设置装备 → 历史消息及跨标签页同步 → 恢复默认', async ({ page, context }) => {
  test.slow(); // 四次真实注册/签到/转账后再走跨标签页链路。
  const user = await registerFreshUser(page, { core: true });
  for (let i = 0; i < 4; i++) {
    await registerFreshUser(page, { core: true });
    await publishBlog(page);
    expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);
    const transfer = await page.request.post('/api/fish/market/transfer', { data: { to_username: user.username, amount: 3 } });
    expect(transfer.status(), await transfer.text()).toBe(200);
  }
  await loginViaApi(page, user.username);
  const marker = `bubble-${uniqueTag()}`;
  const sent = await page.request.post('/api/chat/channels/lobby/messages', { data: { content: `${marker}\n\n\`\`\`ts\n${'long_code_'.repeat(30)}\n\`\`\`` } });
  expect(sent.status(), await sent.text()).toBe(200);

  await page.goto('/fish/market#shop');
  await page.getByRole('button', { name: '聊天气泡', exact: true }).click();
  const item = page.locator('.market-card[data-bubble="blue-square"]');
  await expect(item.locator('.market-shop__price')).toHaveText(`${fmtFish(10)} 鱼干 / 月`);
  await expect(item.locator('.market-shop__submit')).toBeEnabled();
  await item.locator('.market-shop__item').screenshot({ path: 'tests/.tmp/bubble-demo.png' });
  await page.screenshot({ path: 'tests/.tmp/bubble-shop.png', fullPage: true });
  await item.locator('.market-shop__submit').click();
  const confirm = page.locator('#market-shop-confirm-bubble-blue-square');
  await expect(confirm).toContainText('1 个月');
  await confirm.locator('.market-confirm__ok').click();
  await expect(confirm).toHaveCount(0);
  await expect(item.locator('.market-shop__owned')).toContainText('当前持有到');
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(2);
  const tx = await (await page.request.get('/api/fish/transactions?type=shop_all')).json();
  expect(tx.transactions).toEqual([expect.objectContaining({ type: 'bubble_rent', amount: -10, reference_id: 'blue-square' })]);

  const chat = await context.newPage();
  await chat.goto('/chat?channel=lobby');
  const message = chat.locator('.chat-msg', { hasText: marker });
  await expect(message).toBeVisible();
  await expect(message.locator('.chat-msg__content')).not.toHaveAttribute('data-bubble');
  await page.goto('/settings#chat-bubble');
  const owned = page.locator('[data-bubble-item="blue-square"]');
  await owned.getByRole('button', { name: '使用', exact: true }).click();
  await expect(owned.getByRole('button', { name: '使用中', exact: true })).toBeDisabled();
  // 秒级更新，验证是 SSE 装备刷新；60 秒快照不是这条用例的成功条件。
  await expect(message.locator('.chat-msg__content')).toHaveAttribute('data-bubble', 'blue-square', { timeout: 8000 });
  expect(await message.locator('.chat-msg__content').evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');
  await chat.setViewportSize({ width: 390, height: 844 });
  await chat.evaluate(() => document.documentElement.dataset.theme = 'dark');
  // 主题颜色有过渡，等正文完成变色后再验深色可读性并截图。
  await expect(message.locator('.chat-msg__md > p').first()).toHaveCSS('color', 'rgb(241, 245, 249)');
  expect(await chat.locator('.chat-list').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await chat.screenshot({ path: 'tests/.tmp/bubble-chat-dark-mobile.png', fullPage: true });
  await page.screenshot({ path: 'tests/.tmp/bubble-settings.png', fullPage: true });
  await page.locator('#chat-bubble').getByRole('button', { name: '恢复默认' }).click();
  await expect(message.locator('.chat-msg__content')).not.toHaveAttribute('data-bubble', { timeout: 8000 });
  await chat.close();
});

test('余额不足时气泡不可买，服务端也拒绝且不授予', async ({ page }) => {
  await registerFreshUser(page);
  await page.goto('/fish/market#shop');
  await page.getByRole('button', { name: '聊天气泡', exact: true }).click();
  const item = page.locator('.market-card[data-bubble="blue-square"]');
  await expect(item.locator('.market-shop__submit')).toBeDisabled();
  const res = await page.request.post('/api/fish/market/bubble-rent', { data: { bubble_key: 'blue-square', count: 1 } });
  expect(res.status()).toBe(400);
  expect((await (await page.request.get('/api/users/me/bubble')).json()).bubbles).toEqual([]);
});
