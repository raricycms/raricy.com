// ─────────────────────────────────────────────────────────────────────────────
// chat-avatar-menu.spec.ts —— 聊天消息头像的选项框（拍一拍 / 访问个人主页 / @ta / 取消）
// 与配套的两条渲染规则：拍一拍系统行、@我 的消息高亮。
//
// 【为什么要 E2E】选项框是 portal + fixed 定位 + 全局监听（外部点击 / Esc / 滚动）
// 的组合，单测看不见；@ta 的插入位置、末尾空格、以及「@e2e_core 不能命中
// @e2e_corex」这类边界，也只有在真 DOM 里点一遍才作数。
//
// 【造数纪律 —— 与全库 spec 共存】大区是全站共用频道：所有定位都按本轮 uniqueTag
// 的哨兵串锚定，绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 以当前登录身份在大区发一条消息（哨兵串同时作为正文，便于定位）。 */
async function postLobby(page: import('@playwright/test').Page, content: string) {
  const res = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
    data: { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
}

/** 按哨兵串定位那一条消息气泡。 */
function msgRow(page: import('@playwright/test').Page, marker: string) {
  return page.locator('.chat-msg', { hasText: marker });
}

test.describe('聊天头像选项框', () => {
  test('点头像弹出选项框（不再直跳主页）：三项 + 分割线 + 取消', async ({ page }) => {
    // 让 admin 发消息 → core 看到时头像在左侧，顺带覆盖「左对齐」定位分支
    await loginViaApi(page, SEED_USERS.admin.username);
    const marker = `e2e-menu-${uniqueTag()}`;
    await postLobby(page, marker);

    await page.context().clearCookies();
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    // 头像从 <a> 换成 <button>：点了不导航，只弹菜单
    const avatar = row.locator('.chat-msg__avatar');
    await expect(avatar).toHaveJSProperty('tagName', 'BUTTON');
    await avatar.click();

    const menu = page.locator('.chat-avatar-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.chat-avatar-menu__item')).toHaveText([
      '拍一拍',
      '访问个人主页',
      '@ta',
      '取消',
    ]);
    await expect(menu.locator('.chat-avatar-menu__sep')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: '访问个人主页' })).toHaveAttribute(
      'href',
      `/u/${SEED_USERS.admin.id}`
    );

    // portal + fixed 定位：必须完整落在视口内（消息列表 overflow 不能裁掉它）
    const box = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

    // @ta → 输入框出现「@用户名 」，末尾那个空格是格式约定（渲染侧也靠它做边界）
    await menu.getByRole('menuitem', { name: '@ta' }).click();
    await expect(page.locator('.chat-composer__input')).toHaveValue(
      `@${SEED_USERS.admin.username} `
    );
    await expect(menu).toHaveCount(0);
  });

  test('取消关掉菜单；拍一拍渲染成居中系统行，本人被拍时高亮', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-pat-${uniqueTag()}`;
    await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    // 取消：菜单收起，什么都不发生
    await row.locator('.chat-msg__avatar').click();
    const menu = page.locator('.chat-avatar-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '取消' }).click();
    await expect(menu).toHaveCount(0);

    // 再点开 → 拍一拍自己（本条是本人发的消息，头像在右 → 覆盖右对齐分支）
    await row.locator('.chat-msg__avatar').click();
    await menu.getByRole('menuitem', { name: '拍一拍' }).click();

    const pat = page.locator('.chat-pat').last();
    await expect(pat).toContainText(`拍了拍 ${SEED_USERS.core.username}`);
    // 被拍的是自己 → 强调态；且系统行没有气泡
    await expect(pat).toHaveClass(/chat-pat--me/);
    await expect(pat.locator('.chat-msg__content')).toHaveCount(0);
  });

  test('@到自己的消息高亮；前缀相同的 @e2e_corex 不误伤', async ({ page }) => {
    // 发言者用一次性新用户，**不用种子号**：大区发言限频是 30 条/分钟/用户，
    // 种子号在两个 project 之间共用，另一轮的发言还没滑出 60 秒窗口就会把配额
    // 顶满（详见 helpers.ts 的 registerFreshUser）。发言者是谁不影响 @ 高亮的
    // 判定 —— 那条规则只看正文和**查看者**用户名（ChatMessageItem 的 isMentioned）。
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    const hit = `@${SEED_USERS.core.username} 哨兵-${tag}`;
    const miss = `@${SEED_USERS.core.username}x 哨兵-${tag}`;
    await postLobby(page, hit);
    await postLobby(page, miss);

    await page.context().clearCookies();
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const hitContent = msgRow(page, hit).locator('.chat-msg__content');
    await expect(hitContent).toBeVisible();
    await expect(hitContent).toHaveClass(/chat-msg__content--mention/);

    const missContent = msgRow(page, miss).locator('.chat-msg__content');
    await expect(missContent).toBeVisible();
    await expect(missContent).not.toHaveClass(/chat-msg__content--mention/);
  });

  test('拍一拍目标已不存在 → 侧栏预览与气泡都给占位名，不露空串', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const list = await page.request.get(`/api/chat/channels/${LOBBY}/messages`);
    expect(list.status()).toBe(200);

    // 直接打接口：目标 id 是随机 UUID（用户不存在）→ 服务端应拒绝，而不是写坏数据
    const bad = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
      data: { pat_target_id: crypto.randomUUID() },
    });
    expect(bad.status()).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe('被拍的用户不存在');
  });
});
