// ─────────────────────────────────────────────────────────────────────────────
// admin-role-buttons.spec.ts —— 用户管理页的角色档位按钮
//
// 【防的回归】
//   1. 站长能把核心用户提拔成管理员（core → admin），也能把管理员降回核心用户
//      （admin → core）—— 这两档以前只能上服务器跑 CLI。
//   2. 对管理员**不再显示「认证」按钮**。旧实现按「是 core 就显取消认证，否则显认证」
//      两分支渲染：管理员落进 else → 卡片上出现一个写着「认证」、点了却调
//      PATCH {role:'core'} 的按钮（把人降级），语义完全反着。
//   3. 管理员看不到这两个按钮（任命管理员是站长专属，见 setRole 的权限分档）。
//
// 【造数纪律】用例会真的改种子用户的角色，改完必须还原 —— 全套 e2e 共用一个库，
// 漏还原会让后面按角色断言的用例莫名其妙地挂。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser } from './helpers';
import { SEED_USERS } from './seed';

/** 打开用户管理页并定位某个用户的卡片。 */
async function openUserCard(page: Page, username: string) {
  await page.goto(`/admin/users?search=${encodeURIComponent(username)}`);
  const card = page.locator('.user-card', { hasText: username }).first();
  await expect(card).toBeVisible();
  return card;
}

/** 走接口改角色（还原用：不经过 UI，避免依赖页面自身还正常）。 */
async function setRoleViaApi(page: Page, userId: string, role: string) {
  const res = await page.request.patch(`/api/admin/users/${userId}`, { data: { role } });
  expect(res.status(), `改角色失败：${await res.text()}`).toBe(200);
}

test.describe('用户管理：角色档位按钮（站长）', () => {
  test('站长可提拔核心用户为管理员，再降回核心用户', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    // 造一个干净的核心用户当靶子（用真实提权接口升到 core）
    const target = await registerFreshUser(page, { core: true });
    await loginViaApi(page, SEED_USERS.owner.username); // 上面把登录态换走了

    try {
      // ── 提拔 ──
      const card = await openUserCard(page, target.username);
      await expect(card.locator('.user-card__role')).toHaveText('核心用户');
      await card.getByRole('button', { name: '提拔管理员' }).click();

      // 操作成功后组件会 router.refresh()（延迟 300ms），等角色标签自己变过来
      await expect(card.locator('.user-card__role')).toHaveText('管理员', { timeout: 10_000 });
      // 已经是管理员了 → 提拔按钮消失，出现降级按钮，且**不该**有「认证」
      await expect(card.getByRole('button', { name: '提拔管理员' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: '认证' })).toHaveCount(0);

      // ── 降级 ──
      await card.getByRole('button', { name: '降为核心用户' }).click();
      await expect(card.locator('.user-card__role')).toHaveText('核心用户', { timeout: 10_000 });
      await expect(card.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: '提拔管理员' })).toBeVisible();
    } finally {
      await setRoleViaApi(page, target.id, 'user');
    }
  });

  test('管理员的卡片上没有「认证」按钮（旧实现会把人降成 core）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);

    const card = await openUserCard(page, SEED_USERS.admin.username);
    await expect(card.locator('.user-card__role')).toHaveText('管理员');
    // 管理员档位只有「降为核心用户」，没有「认证」/「取消认证」这一对
    await expect(card.getByRole('button', { name: '降为核心用户' })).toBeVisible();
    await expect(card.getByRole('button', { name: '认证', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '取消认证' })).toHaveCount(0);
  });

  test('站长自己的卡片上没有角色按钮（不能自己降自己）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.owner.username);
    const card = await openUserCard(page, SEED_USERS.owner.username);
    await expect(card.locator('.user-card__role')).toHaveText('站长');
    await expect(card.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '认证', exact: true })).toHaveCount(0);
  });
});

test.describe('用户管理：角色档位按钮（管理员）', () => {
  test('管理员看不到「提拔管理员」/「降为核心用户」——任命管理员是站长专属', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.admin.username);

    const core = await openUserCard(page, SEED_USERS.core.username);
    await expect(core.locator('.user-card__role')).toHaveText('核心用户');
    await expect(core.getByRole('button', { name: '认证', exact: true })).toHaveCount(0); // 站长专属的那一对
    await expect(core.getByRole('button', { name: '提拔管理员' })).toHaveCount(0);

    const admin = await openUserCard(page, SEED_USERS.admin.username);
    await expect(admin.getByRole('button', { name: '降为核心用户' })).toHaveCount(0);
  });
});
