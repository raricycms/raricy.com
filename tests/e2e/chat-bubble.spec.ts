import { expect, test } from '@playwright/test';
import { registerFreshUser, loginViaApi, publishBlog, uniqueTag } from './helpers';
import { fmtFish } from '../../src/lib/fish-amount';

const DEMOS = [
  { key: 'blue-square', label: '蓝底直角', outline: false },
  { key: 'blue-outline-square', label: '蓝色直角', outline: true },
];

// 走已有 core+ 签到与转账筹资，测试也不直接改余额。
// 同一人购买两款，复用筹资前置步骤，避免 desktop/mobile 的重复提权耗尽管理员登录配额。
test('两款气泡：商城租赁 → 切换装备 → 两种主题及跨标签页同步 → 恢复默认', async ({ page, context }) => {
  test.slow(); // 七次真实注册/签到/转账后再走跨标签页链路。
  const user = await registerFreshUser(page, { core: true });
  for (let i = 0; i < 7; i++) {
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
  const emoji = await page.request.post('/api/chat/channels/lobby/messages', { data: { content: '[@黄脸/微笑]' } });
  expect(emoji.status(), await emoji.text()).toBe(200);
  const mention = await page.request.post('/api/chat/channels/lobby/messages', { data: { content: `@${user.username} 请看这条消息` } });
  expect(mention.status(), await mention.text()).toBe(200);

  await page.goto('/fish/shop?category=bubble#shop');
  await page.getByRole('button', { name: '聊天气泡', exact: true }).click();
  await expect(page.locator('.market-card[data-bubble="blue-square"]')).toContainText('蓝底直角');
  await expect(page.locator('.market-card[data-bubble="blue-outline-square"]')).toContainText('蓝色直角');
  let balance = 21;
  for (const { key } of DEMOS) {
    const item = page.locator(`.market-card[data-bubble="${key}"]`);
    await expect(item.locator('.market-shop__price')).toHaveText(`${fmtFish(10)} 鱼干 / 月`);
    await expect(item.locator('.market-shop__submit')).toBeEnabled();
    await item.locator('.market-shop__item').screenshot({ path: `tests/.tmp/${key}-demo.png` });
    await item.locator('.market-shop__submit').click();
    const confirm = page.locator(`#market-shop-confirm-bubble-${key}`);
    await expect(confirm).toContainText('1 个月');
    await confirm.locator('.market-confirm__ok').click();
    await expect(confirm).toHaveCount(0);
    await expect(item.locator('.market-shop__owned')).toContainText('当前持有到');
    balance -= 10;
    expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(balance);
  }
  await page.screenshot({ path: 'tests/.tmp/bubble-shop.png', fullPage: true });
  const tx = await (await page.request.get('/api/fish/transactions?type=shop_all')).json();
  expect(tx.transactions).toHaveLength(2);
  expect(tx.transactions).toEqual(expect.arrayContaining(DEMOS.map(({ key }) =>
    expect.objectContaining({ type: 'bubble_rent', amount: -10, reference_id: key }))));

  const chat = await context.newPage();
  await chat.goto('/chat?channel=lobby');
  const message = chat.locator('.chat-msg', { hasText: marker });
  await expect(message).toBeVisible();
  await expect(message.locator('.chat-msg__content')).not.toHaveAttribute('data-bubble');
  await page.goto('/settings#chat-bubble');
  for (const { key, label, outline } of DEMOS) {
    const owned = page.locator(`[data-bubble-item="${key}"]`);
    await expect(owned).toContainText(label);
    await owned.getByRole('button', { name: '使用', exact: true }).click();
    await expect(owned.getByRole('button', { name: '使用中', exact: true })).toBeDisabled();
    // 秒级更新，验证是 SSE 装备刷新；60 秒快照不是这条用例的成功条件。
    const bubble = message.locator('.chat-msg__content');
    await expect(bubble).toHaveAttribute('data-bubble', key, { timeout: 8000 });
    await expect(bubble).toHaveCSS('border-radius', '0px');
    await expect(bubble).toHaveCSS('border-top-width', outline ? '1px' : '0px');
    const soloImage = chat.locator('.chat-msg__content', { has: chat.locator('.chat-msg__md--single-image') }).last();
    await expect(soloImage).toHaveAttribute('data-bubble', key);
    await expect(soloImage).toHaveCSS('border-top-width', '0px');
    await expect(soloImage).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const mentionedBubble = chat.locator(`.chat-msg__content--mention[data-bubble="${key}"]`).last();
    await expect(mentionedBubble).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await chat.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      // 主题颜色有过渡，等正文完成变色后再量配色。
      await expect(message.locator('.chat-msg__md > p').first()).toHaveCSS('color', theme === 'light' ? 'rgb(15, 23, 42)' : 'rgb(241, 245, 249)');
      if (outline) {
        const canvasColor = await chat.locator('.chat-main').evaluate((el) => getComputedStyle(el).backgroundColor);
        await expect(bubble).toHaveCSS('background-color', canvasColor);
        await expect(bubble).toHaveCSS('border-top-color', theme === 'light' ? 'rgb(37, 99, 235)' : 'rgb(35, 165, 255)');
        await expect(mentionedBubble).toHaveCSS('background-color', canvasColor);
        await expect(mentionedBubble).toHaveCSS('border-top-width', '2px');
      }
      await bubble.screenshot({ path: `tests/.tmp/${key}-chat-${theme}.png` });
    }
    await chat.setViewportSize({ width: 390, height: 844 });
    expect(await chat.locator('.chat-list').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await chat.screenshot({ path: `tests/.tmp/${key}-chat-dark-mobile.png`, fullPage: true });
    await page.screenshot({ path: `tests/.tmp/${key}-settings.png`, fullPage: true });
  }
  await page.locator('#chat-bubble').getByRole('button', { name: '恢复默认' }).click();
  await expect(message.locator('.chat-msg__content')).not.toHaveAttribute('data-bubble', { timeout: 8000 });
  await chat.close();
});

test('余额不足时气泡不可买，服务端也拒绝且不授予', async ({ page }) => {
  await registerFreshUser(page);
  await page.goto('/fish/shop?category=bubble#shop');
  await page.getByRole('button', { name: '聊天气泡', exact: true }).click();
  for (const { key } of DEMOS) {
    const item = page.locator(`.market-card[data-bubble="${key}"]`);
    await expect(item.locator('.market-shop__submit')).toBeDisabled();
    const res = await page.request.post('/api/fish/market/bubble-rent', { data: { bubble_key: key, count: 1 } });
    expect(res.status()).toBe(400);
  }
  expect((await (await page.request.get('/api/users/me/bubble')).json()).bubbles).toEqual([]);
});
