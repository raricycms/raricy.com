// ─────────────────────────────────────────────────────────────────────────────
// saved-messages.spec.ts —— 保存的私聊消息（/chat/saved）
//
// 【守的是三条真浏览器才看得见的链路】
//   1. 消息右键菜单里的「保存」真的把消息写进保存箱（UI → API → DB）；
//   2. 保存箱条目能点回**原消息**并高亮（/chat?channel=&message= → jumpToMessage）；
//   3. 会话被「删除会话」隐藏之后，从保存箱点进去仍然能打开它（reveal 先于 poll）
//      —— 不恢复隐藏的话，poll 列表里没有该频道，页面会静默落到第一个会话。
//
// 【造数纪律】只用一次性 core 用户（发言 / 发起私聊都按用户限频，种子号是两个
// project 共用的桶）。消息用 uniqueTag 哨兵锚定，不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

function msgRow(page: import('@playwright/test').Page, marker: string) {
  return page.locator('.chat-msg', {
    has: page.locator('.chat-msg__content', { hasText: marker }),
  });
}

test.describe('保存的私聊消息', () => {
  test('保存 → 保存箱 → 点回原消息；删除会话后仍能打开', async ({ page }) => {
    // 一次性 core 用户：避免种子号在两个 project 间共用发言 / 建会话的限频桶。
    await registerFreshUser(page, { core: true });

    // 与种子 core 建私聊，用 API 发一条哨兵消息（UI 只测保存箱这条链路）。
    const started = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.core.id },
    });
    expect(started.status(), `建私聊失败：${started.status()} ${await started.text()}`).toBe(200);
    const channelId = ((await started.json()) as { channel: { id: string } }).channel.id;

    const marker = `e2e-saved-${uniqueTag()}`;
    const sent = await page.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: marker },
    });
    expect(sent.status(), `发消息失败：${sent.status()} ${await sent.text()}`).toBe(200);
    const messageId = ((await sent.json()) as { message: { id: number } }).message.id;

    // ── 1. 在聊天页右键 → 操作菜单里点「保存」（消息上没有常驻按钮）──────────
    await page.goto(`/chat?channel=${encodeURIComponent(channelId)}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    const menu = page.locator('.chat-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '保存', exact: true }).click();
    // 菜单项是「已保存」状态的唯一展示处：再开一次确认它真的翻过去了
    await row.click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: '已保存', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // ── 2. 保存箱里出现；点进去回到原消息并短暂高亮 ────────────────────────
    await page.goto('/chat/saved');
    await expect(page.locator('.saved-page__title')).toHaveText('保存的消息');
    const item = page.locator('.saved-msg', { hasText: marker });
    await expect(item).toBeVisible();
    await expect(item).toContainText(`与 ${SEED_USERS.core.username} 的私聊`);
    // 条目必须带着**消息 id** 的深链（不是只回频道）
    await expect(item.locator('.saved-msg__link')).toHaveAttribute(
      'href',
      new RegExp(`[?&]message=${messageId}(&|$)`)
    );

    await item.locator('.saved-msg__link').click();
    // URL 里的 ?message= 会被 ChatApp 的「频道镜像」replace 掉（只保留 channel），
    // 所以只断言频道；跳没跳到由下面的高亮类名负责。
    await expect
      .poll(() => new URL(page.url()).searchParams.get('channel'))
      .toBe(channelId);
    await expect(msgRow(page, marker)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });

    // ── 3. 「删除会话」（隐藏）之后，保存箱仍然能把人带回来 ─────────────────
    const hidden = await page.request.post(`/api/chat/channels/${channelId}/hide`);
    expect(hidden.status(), await hidden.text()).toBe(200);

    await page.goto('/chat/saved');
    const itemAgain = page.locator('.saved-msg', { hasText: marker });
    await expect(itemAgain).toBeVisible();
    await itemAgain.locator('.saved-msg__link').click();
    // 隐藏的频道会被 reveal 恢复，因此 URL 落在目标频道，而不是被回退到 lobby
    await expect
      .poll(() => new URL(page.url()).searchParams.get('channel'))
      .toBe(channelId);
    await expect(msgRow(page, marker)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });

    // ── 4. 取消保存 → 保存箱回到空态 ──────────────────────────────────────
    await page.goto('/chat/saved');
    await page.locator('.saved-msg', { hasText: marker }).locator('.saved-msg__remove').click();
    await expect(page.locator('.saved-msg', { hasText: marker })).toHaveCount(0);
  });
});
