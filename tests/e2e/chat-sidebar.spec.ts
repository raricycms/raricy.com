// ─────────────────────────────────────────────────────────────────────────────
// chat-sidebar.spec.ts —— 侧栏折叠：桌面端窄栏 ↔ 移动端抽屉
//
// 【防的回归】移动端（≤900px）侧栏是抽屉，且折叠态被 _chat.scss 显式还原成
// 300px（「折叠状态在移动端不生效」）—— 于是「«」按钮在手机上点下去毫无反馈，
// 是个死按钮。现在抽屉布局下它关闭抽屉，并且**不写折叠偏好**：手机上关一次抽屉，
// 不该让桌面端下次进来直接变成窄栏。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

test.describe('侧栏折叠 / 移动端抽屉', () => {
  test('桌面端点「«」收窄侧栏；移动端点「«」关闭抽屉', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const sidebar = page.locator('.chat-sidebar');
    const collapse = page.locator('.chat-sidebar__collapse');
    await expect(sidebar).toBeVisible();

    if (isMobile) {
      /** 抽屉左边界：关闭态 = translateX(-100%) → x ≈ -300。 */
      const drawerX = async () => (await sidebar.boundingBox())?.x ?? 0;

      // 默认移出视口，汉堡按钮拉开
      await expect.poll(drawerX).toBeLessThan(0);
      await page.locator('.chat-main__menu').click();
      await expect(sidebar).toBeInViewport();

      await collapse.click();
      await expect.poll(drawerX).toBeLessThan(0);

      // 偏好未被这次点击写脏（否则桌面端下次进来直接是窄栏）
      const pref = await page.evaluate(() => ({
        ls: localStorage.getItem('chat.sidebarCollapsed'),
        cookie: document.cookie.includes('chat_sidebar_collapsed=1'),
      }));
      expect(pref).toEqual({ ls: null, cookie: false });

      // 按钮仍然可用：再拉开、再关
      await page.locator('.chat-main__menu').click();
      await expect(sidebar).toBeInViewport();
      await collapse.click();
      await expect.poll(drawerX).toBeLessThan(0);
    } else {
      const width = async () => (await sidebar.boundingBox())?.width ?? 0;
      const before = await width();
      await collapse.click();
      // 折叠态是 60px 窄栏（不是消失）
      await expect.poll(width).toBeLessThanOrEqual(61);
      await collapse.click();
      await expect.poll(width).toBeGreaterThanOrEqual(before - 1);
    }
  });
});
