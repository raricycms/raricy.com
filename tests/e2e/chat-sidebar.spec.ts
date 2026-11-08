// ─────────────────────────────────────────────────────────────────────────────
// chat-sidebar.spec.ts —— 折叠按钮的行为：桌面写偏好、移动端关抽屉且不写偏好
//
// 【防的回归】移动端（≤900px）侧栏是抽屉，且折叠态被 _chat.scss 显式还原成
// 300px（「折叠状态在移动端不生效」）—— 于是「«」按钮在手机上点下去毫无反馈，
// 是个死按钮。现在抽屉布局下它关闭抽屉，并且**不写折叠偏好**：手机上关一次抽屉，
// 不该让桌面端下次进来直接变成窄栏。
//
// 窄栏宽度（60px）、抽屉位移这些几何属于外观，按仓库纪律不在测试里固定；
// 这里断的是「点了有没有真的生效」与偏好有没有被写脏。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 折叠偏好：localStorage 的 '1'/'0' 与 SSR 镜像 cookie。 */
async function collapsePref(page: import('@playwright/test').Page) {
  return page.evaluate(() => ({
    ls: localStorage.getItem('chat.sidebarCollapsed'),
    cookie: document.cookie.includes('chat_sidebar_collapsed=1'),
  }));
}

test.describe('侧栏折叠 / 移动端抽屉', () => {
  test('桌面端点「«」写折叠偏好；移动端点「«」关闭抽屉且不写偏好', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const sidebar = page.locator('.chat-sidebar');
    const collapse = page.locator('.chat-sidebar__collapse');
    await expect(sidebar).toBeVisible();
    expect(await collapsePref(page)).toEqual({ ls: null, cookie: false });

    if (isMobile) {
      // 默认移出视口，汉堡按钮拉开
      await expect(sidebar).not.toBeInViewport();
      await page.locator('.chat-main__menu').click();
      await expect(sidebar).toBeInViewport();

      await collapse.click();
      await expect(sidebar).not.toBeInViewport();

      // 偏好未被这次点击写脏（否则桌面端下次进来直接是窄栏）
      expect(await collapsePref(page)).toEqual({ ls: null, cookie: false });

      // 按钮仍然可用：再拉开、再关
      await page.locator('.chat-main__menu').click();
      await expect(sidebar).toBeInViewport();
      await collapse.click();
      await expect(sidebar).not.toBeInViewport();
    } else {
      await collapse.click();
      // 折叠态被记住（LS + SSR 可见的 cookie 镜像），刷新后仍是折叠态
      await expect
        .poll(async () => collapsePref(page))
        .toEqual({ ls: '1', cookie: true });
      await page.reload();
      await expect(page.locator('.chat-page')).toHaveClass(/chat-page--collapsed/);

      await collapse.click();
      await expect
        .poll(async () => collapsePref(page))
        .toEqual({ ls: '0', cookie: false });
    }
  });
});
