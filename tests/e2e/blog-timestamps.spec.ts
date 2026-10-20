import { test, expect, type Locator, type Page } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

async function expectTimesFit(timestamps: Locator) {
  // 列表由 Suspense 流式补上：DOM 计数先成立时，节点可能还在隐藏的待提交片段里。
  await expect(timestamps).toBeVisible();
  const bounds = await timestamps.evaluate((element) => {
    const parent = element.parentElement!.getBoundingClientRect();
    const items = Array.from(element.querySelectorAll('.blog-timestamps__item')).filter((item) => item.getBoundingClientRect().width > 0).map((item) => {
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

async function expectDetail(page: Page, createdAt: string, updatedAt: string) {
  const timestamps = page.locator('.blog-meta .blog-timestamps');
  await expectTimesFit(timestamps);
  const summary = timestamps.locator('summary');
  await expect(summary.locator('time')).toHaveCount(1);
  await expect(summary).toContainText('已编辑');
  await summary.click();
  const panel = timestamps.locator('.blog-timestamps__panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('time')).toHaveCount(2);
  await expect(panel.locator('time').first()).toHaveText(createdAt.slice(0, 19).replace('T', ' '));
  await expect(panel.locator('time').last()).toHaveText(updatedAt.slice(0, 19).replace('T', ' '));
  await expectTimesFit(timestamps);
  await summary.click();
  await expect(panel).toBeHidden();
  await page.mouse.move(0, 0);
}

test('实际编辑后的时间贯通详情、两种列表与个人主页，桌面/手机和深色主题都不溢出', async ({ page }, testInfo) => {
  // 独立作者，避免占用其他 spec 的每日发文配额。
  const author = await registerFreshUser(page, { core: true });
  const data = {
    title: `山间来信：在平凡的日子里，重新学会观察与记录-${uniqueTag().slice(-6)}`,
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
  await expect(page.locator('.blog-meta summary time')).toHaveCount(1);
  await expect(page.locator('.read-hero__author')).toHaveAttribute('href', `/u/${author.id}`);
  const edit = { ...data, description: `${data.description} 已更新。` };
  expect((await page.request.put(`/api/blogs/${id}`, { data: edit })).status()).toBe(200);
  const changed = await read();
  expect(changed.updated_at > initial.updated_at).toBe(true);
  expect(changed.created_at).toBe(initial.created_at);
  expect((await page.request.put(`/api/blogs/${id}`, { data: edit })).status()).toBe(200);
  expect((await read()).updated_at).toBe(changed.updated_at);

  await page.reload();
  const detail = page.locator('.blog-meta .blog-timestamps');
  await expectDetail(page, initial.created_at, changed.updated_at);
  await expect(page.locator('.read-card .read-hero')).toBeVisible();
  await expect(page.locator('.read-card #userContentContainer h1')).toBeVisible();
  await expect(page.locator('.read-hero h1')).toHaveCSS('text-align', 'center');
  const alignment = await page.locator('.blog-meta').evaluate((meta) => {
    const rect = meta.getBoundingClientRect();
    const items = Array.from(meta.children).map((item) => item.getBoundingClientRect());
    return {
      container: rect.left + rect.width / 2,
      content: (Math.min(...items.map((item) => item.left)) + Math.max(...items.map((item) => item.right))) / 2,
    };
  });
  expect(alignment.content).toBeCloseTo(alignment.container, 0);
  await page.locator('.read-card').screenshot({ path: testInfo.outputPath('detail-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expectTimesFit(detail);
  await page.locator('.read-card').screenshot({ path: testInfo.outputPath('detail-dark.png'), animations: 'disabled' });

  await page.goto(`/blog?search=${encodeURIComponent(data.title)}`);
  const card = page.locator(`[id="id${id}"]`);
  await expectTimesFit(card.locator('.blog-timestamps'));
  await expect(card.locator('.blog-timestamps time')).toHaveCount(1);
  await expect(card.locator('.blog-timestamps')).not.toContainText(/发布于|更新于|已编辑/);
  await expect(card.locator('.blog-timestamps time')).toHaveText(/^\d{1,2}月\d{1,2}日$/);
  await card.screenshot({ path: testInfo.outputPath('member-card.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expectTimesFit(card.locator('.blog-timestamps'));
  await card.screenshot({ path: testInfo.outputPath('member-card-dark.png'), animations: 'disabled' });
  await page.goto(`/blog?search=${encodeURIComponent(data.title)}&sort=updated`);
  await expect(card.locator('.blog-timestamps time')).toHaveAttribute('aria-label', /^更新于/);
  await expect(card.locator('.blog-timestamps')).not.toContainText(/发布于|更新于|已编辑/);
  await expect(card.locator('.blog-timestamps time')).toHaveAttribute('datetime', changed.updated_at.replace(/Z$/, '+08:00'));
  await page.goto(`/u/${author.id}`);
  // 个人主页现在是一张「积木墙」：文章以 .bento-card--blog 出现，日期是 <time>。
  const profileCard = page.locator('.bento-card--blog').filter({ hasText: data.title });
  await expect(profileCard).toBeVisible();
  await expect(profileCard.locator('.bento-blog__date')).toHaveCount(1);
  await expect(profileCard.locator('.bento-blog__date')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}$/);
  await profileCard.screenshot({ path: testInfo.outputPath('profile-card.png') });

  await page.context().clearCookies();
  await page.goto(`/blog/${id}`);
  await expectDetail(page, initial.created_at, changed.updated_at);
  await expect(page.locator('#comment-section')).toHaveCount(0);
  await page.locator('.read-hero__author').click();
  await expect(page).toHaveURL(new RegExp(`/u/${author.id}$`));
  // 主页现在对访客是**开放的**（旧版对游客是一片空白）：public 文章应当出现。
  await expect(page.locator('.bento-card--blog').filter({ hasText: data.title })).toHaveCount(1);
  await page.goto(`/explore?search=${encodeURIComponent(data.title)}`);
  const publicCard = page.locator('.blog-item').filter({ hasText: data.title });
  await expectTimesFit(publicCard.locator('.blog-timestamps'));
  await expect(publicCard.locator('.blog-timestamps')).not.toContainText(/发布于|更新于|已编辑/);
  await expect(publicCard.locator('.blog-author-link')).toHaveAttribute('href', `/u/${author.id}`);
  await publicCard.screenshot({ path: testInfo.outputPath('public-card.png') });

  // 极窄屏下长标题、作者与展开后的完整时间也必须留在檐沟内。
  await page.setViewportSize({ width: 320, height: 740 });
  await expectTimesFit(publicCard.locator('.blog-timestamps'));
  await publicCard.screenshot({ path: testInfo.outputPath('public-card-320.png') });
  await page.goto(`/blog/${id}`);
  await expectDetail(page, initial.created_at, changed.updated_at);
  await page.locator('.read-card').screenshot({ path: testInfo.outputPath('detail-320.png'), animations: 'disabled' });
  await page.locator('.blog-timestamps__summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.blog-timestamps__panel')).toBeVisible();
  await expectTimesFit(page.locator('.blog-meta .blog-timestamps'));
  await page.locator('.blog-timestamps__panel').screenshot({ path: testInfo.outputPath('detail-320-expanded.png'), animations: 'disabled' });
});
