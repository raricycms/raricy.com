import { test, expect, type Locator } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

async function expectTimesFit(timestamps: Locator) {
  // 列表由 Suspense 流式补上：DOM 计数先成立时，节点可能还在隐藏的待提交片段里。
  await expect(timestamps).toBeVisible();
  await expect(timestamps.locator('time')).toHaveCount(2);
  const bounds = await timestamps.evaluate((element) => {
    const parent = element.parentElement!.getBoundingClientRect();
    const items = Array.from(element.querySelectorAll('.blog-timestamps__item')).map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return { parent: { left: parent.left, right: parent.right }, items, viewport: window.innerWidth };
  });
  for (const item of bounds.items) {
    expect(item.left).toBeGreaterThanOrEqual(Math.max(16, bounds.parent.left) - 1);
    expect(item.right).toBeLessThanOrEqual(Math.min(bounds.viewport - 16, bounds.parent.right) + 1);
  }
  await expect(timestamps.locator('time').first()).toHaveAttribute('datetime', /\+08:00$/);
}

test('实际编辑后的时间贯通详情、两种列表与个人主页，桌面/手机和深色主题都不溢出', async ({ page }, testInfo) => {
  // 独立作者，避免占用其他 spec 的每日发文配额。
  const author = await registerFreshUser(page, { core: true });
  const data = {
    title: `文章时间-${uniqueTag()}`,
    description: '发布与更新清楚可见，阅读从容有序。',
    content: '# 阅读与时间\n\n每一次实际修改，都留下一个清晰的时间。',
    visibility: 'public',
  };
  const created = await page.request.post('/api/blogs', { data });
  expect(created.status(), await created.text()).toBe(200);
  const id = (await created.json()).blog_id as string;
  const read = async () => (await (await page.request.get(`/api/blogs/${id}`)).json()).blog;
  const initial = await read();
  expect(initial.updated_at).toBe(initial.created_at);

  await page.goto(`/blog/${id}`);
  await expect(page.locator('.blog-meta time')).toHaveCount(1);
  const edit = { ...data, description: `${data.description} 已更新。` };
  expect((await page.request.put(`/api/blogs/${id}`, { data: edit })).status()).toBe(200);
  const changed = await read();
  expect(changed.updated_at > initial.updated_at).toBe(true);
  expect(changed.created_at).toBe(initial.created_at);
  expect((await page.request.put(`/api/blogs/${id}`, { data: edit })).status()).toBe(200);
  expect((await read()).updated_at).toBe(changed.updated_at);

  await page.reload();
  const detail = page.locator('.blog-meta .blog-timestamps');
  await expectTimesFit(detail);
  await expect(detail.locator('time').first()).toHaveText(initial.created_at.slice(0, 16).replace('T', ' '));
  await expect(detail.locator('time').last()).toHaveText(changed.updated_at.slice(0, 16).replace('T', ' '));
  await page.locator('.read-hero').screenshot({ path: testInfo.outputPath('detail-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expectTimesFit(detail);
  await page.locator('.read-hero').screenshot({ path: testInfo.outputPath('detail-dark.png') });

  await page.goto(`/blog?search=${encodeURIComponent(data.title)}`);
  const card = page.locator(`[id="id${id}"]`);
  await expectTimesFit(card.locator('.blog-timestamps'));
  await card.screenshot({ path: testInfo.outputPath('member-card.png') });
  await page.goto(`/u/${author.id}`);
  const profileCard = page.locator('.profile-content-item').filter({ hasText: data.title });
  await expectTimesFit(profileCard.locator('.blog-timestamps'));
  await profileCard.screenshot({ path: testInfo.outputPath('profile-card.png') });

  await page.context().clearCookies();
  await page.goto(`/blog/${id}`);
  await expectTimesFit(page.locator('.blog-meta .blog-timestamps'));
  await expect(page.locator('#comment-section')).toHaveCount(0);
  await page.goto(`/explore?search=${encodeURIComponent(data.title)}`);
  const publicCard = page.locator('.blog-item').filter({ hasText: data.title });
  await expectTimesFit(publicCard.locator('.blog-timestamps'));
  await publicCard.screenshot({ path: testInfo.outputPath('public-card.png') });

  // 极窄屏下长用户名与两个日期仍应各自完整折行。
  await page.setViewportSize({ width: 320, height: 740 });
  await expectTimesFit(publicCard.locator('.blog-timestamps'));
  await page.goto(`/blog/${id}`);
  await expectTimesFit(page.locator('.blog-meta .blog-timestamps'));
  await page.locator('.read-hero').screenshot({ path: testInfo.outputPath('detail-320.png') });
});
