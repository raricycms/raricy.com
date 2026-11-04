// 收藏夹：**操作行为**端到端（真浏览器）
//
// 【本文件原来的定位与现在的取舍】
// 它曾按「布局」验收：星标配色、三颗按钮同一行、胶囊 48px、弹窗两颗创建按钮并排且等宽。
// 按 2026-11-04 前端样式测试清理计划（frontend-style-tests-review §10 / §11 P3-B），
// 这些固定外观与几何值不再由 e2e 钉住 —— 布局改动改由受影响页面与视口的人工检查确认。
// 保留下来的只有操作结果与无障碍语义：
//   · 点赞计数随状态出现 / 消失（为 0 时不显示数字）；
//   · 收藏选择器里「私密 / 站内共享」两个创建入口与页脚管理入口；
//   · 管理菜单展开 / 收起、删除取消回到菜单并归还焦点，窄屏收起时互动区退出交互。
//
// 【本文件在 RESPONSIVE_SPECS 里】窄屏管理菜单的 inert / 焦点行为要按视口分支断言：
// desktop 那一遍验宽屏，mobile 那一遍才是窄屏的正面用例。
//
// 【必须用一次性用户】同 favorite.spec.ts：建收藏夹是按用户计限频的（20/时），
// 两个 project 共用同一个限频桶，用种子号会在第二轮的首条操作上吃 429。

import { test, expect } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

/** 建一篇博客（走真实接口），返回 id。 */
async function createBlog(
  page: import('@playwright/test').Page,
  title: string
): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: { title, description: 'e2e 造数', content: '# 正文' },
  });
  expect(res.status(), `建文章失败：${await res.text()}`).toBe(200);
  return (await res.json()).blog_id as string;
}

test('详情页：点赞计数随状态出现与消失，为 0 时不显示数字', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `点赞计数 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  const like = page.locator('#like-btn');
  await expect(like).toBeVisible();
  // 新文章没有点赞 → 不显示「0」
  await expect(page.locator('#like-count')).toHaveCount(0);

  await like.click();
  await expect(page.locator('#like-count')).toHaveText('1');
  await expect(like).toHaveAttribute('aria-pressed', 'true');

  await like.click();
  await expect(page.locator('#like-count')).toHaveCount(0);
  await expect(like).toHaveAttribute('aria-pressed', 'false');
});

test('操作区：管理菜单展开 / 收起、删除取消回到菜单，焦点归还触发器', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `管理菜单 ${uniqueTag()}`);

  for (const width of [390, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/blog/${blogId}`);
    const controls = page.locator('#read-controls');
    const toggle = controls.locator('#admin-manage-btn');
    const interaction = controls.locator('.read-controls__interaction');
    await toggle.scrollIntoViewIfNeeded();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(interaction).not.toHaveAttribute('inert');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(controls.locator('#blog-manage-menu')).toBeVisible();
    // 窄屏展开管理时互动胶囊整体退出交互（inert），避免管理面板与互动按钮叠着可点。
    if (width <= 768) await expect(interaction).toHaveAttribute('inert', '');

    // 窄屏的最后一项必须能滚动到并打开，不能只是留在被裁掉的 DOM 里 ——
    // Playwright 点击会自动把目标滚进视口，点不开就是真的点不到。
    await controls.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.locator('#deleteConfirmModal.is-open')).toBeVisible();
    await page.locator('#deleteConfirmModal').getByRole('button', { name: '取消', exact: true }).click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // 焦点移出管理菜单 → 菜单收起，互动胶囊恢复可用。
    await controls.getByRole('button', { name: '返回上页', exact: true }).focus();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(interaction).not.toHaveAttribute('inert');
    await expect(controls.locator('#like-btn')).toBeVisible();
  }
});

test('收藏选择器：私密 / 站内共享两个创建入口，页脚可进入管理页', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `选择器入口 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  await page.locator('#favorite-btn').click();
  const modal = page.locator('#favoritePickerModal.is-open');
  await expect(modal).toBeVisible();

  // 私密 / 站内共享两种性质在**创建之前**就要可见（性质一经创建不可修改），
  // 因此两个入口必须都能点到 —— 这里只验入口存在，不固定它们的排版。
  await expect(modal.getByRole('button', { name: '创建私密收藏夹' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '创建站内共享收藏夹' })).toBeVisible();

  // 页脚有通往管理页的入口（否则 /favorite 只能靠手敲 URL）。
  const manage = modal.locator('.favorite-picker__manage');
  await expect(manage).toBeVisible();
  await expect(manage).toHaveAttribute('href', '/favorite');
});
