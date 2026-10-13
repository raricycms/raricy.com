import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEED_BLOG, SEED_CATEGORY, SEED_PASSWORD, SEED_USERS } from './seed';

let cookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];
// 登录是布局测试的前置条件：每个 worker 真实登录一次，后续新 context 复用会话，
// 避免目录用例集中消耗同一账号的密码校验配额。登录行为本身由 auth 用例覆盖。
test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/auth/login', { data: { username: SEED_USERS.core.username, password: SEED_PASSWORD } });
  expect(response.status()).toBe(200);
  cookies = (await request.storageState()).cookies;
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test('文章目录宽屏双列、窄屏单列，长标题与作者信息不横向溢出', async ({ page, isMobile }) => {
  await page.goto('/blog');
  await expect(page.locator('.blog-item').nth(1)).toBeVisible();
  const boxes = await page.locator('.blog-item').evaluateAll((items) => items.slice(0, 2).map((item) => {
    const r = item.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom };
  }));
  if (isMobile) {
    expect(Math.abs(boxes[0].left - boxes[1].left)).toBeLessThan(1);
    expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom);
  } else {
    expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThan(1);
    expect(boxes[1].left).toBeGreaterThan(boxes[0].left);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: '创建博客', exact: true })).toBeVisible();
});

test('滚动后搜索与创建留在顶栏下方，手机收拢也保留未提交的搜索词', async ({ page, isMobile }) => {
  await page.goto('/blog');
  const toolbar = page.locator('.blog-directory-toolbar');
  await expect(toolbar).toHaveAttribute('data-ready', 'true');
  const input = page.getByRole('searchbox', { name: '搜索博客' });
  await input.fill('尚未提交的搜索词');
  await page.locator('.blogs-hero h1').click();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect(toolbar).toHaveClass(/blog-directory-toolbar--stuck/);
  const geometry = await toolbar.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    navbarBottom: document.querySelector('.site-navbar')!.getBoundingClientRect().bottom,
  }));
  expect(Math.abs(geometry.top - geometry.navbarBottom)).toBeLessThan(2);
  await expect(page.getByRole('link', { name: '创建博客', exact: true })).toBeVisible();
  if (isMobile) {
    await expect(input).not.toBeVisible();
    const toggle = page.getByRole('button', { name: '展开搜索与筛选' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(input).toBeFocused();
  }
  await expect(input).toHaveValue('尚未提交的搜索词');
});

test('输入中滚动不会隐藏字段或丢失焦点', async ({ page }) => {
  await page.goto('/blog');
  await expect(page.locator('.blog-directory-toolbar')).toHaveAttribute('data-ready', 'true');
  const input = page.getByRole('searchbox', { name: '搜索博客' });
  await input.fill('输入中');
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect(page.locator('.blog-directory-toolbar')).toHaveClass(/blog-directory-toolbar--stuck/);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('输入中');
});

test('分类、搜索与清除条件保留非精选三态和排序', async ({ page }) => {
  await page.goto('/blog?featured=0&sort=updated');
  await expect(page.locator('.blog-directory-toolbar')).toHaveAttribute('data-ready', 'true');
  await page.locator('.blog-category-filter summary').click();
  await page.locator('.blog-category-panel').getByRole('link', { name: SEED_CATEGORY.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`category=${SEED_CATEGORY.slug}`));
  const input = page.getByRole('searchbox', { name: '搜索博客' });
  await input.fill(SEED_BLOG.title);
  await input.press('Enter');
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(params.get('featured')).toBe('0');
  expect(params.get('sort')).toBe('updated');
  expect(params.get('category')).toBe(SEED_CATEGORY.slug);
  await page.getByRole('link', { name: `清除搜索：${SEED_BLOG.title}`, exact: true }).click();
  await expect(page).not.toHaveURL(/search=/);
  expect(new URL(page.url()).searchParams.get('featured')).toBe('0');
  expect(new URL(page.url()).searchParams.get('category')).toBe(SEED_CATEGORY.slug);
});

test('分类浮层支持 Escape 关闭，减少动态效果偏好关闭收拢过渡', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/blog');
  await expect(page.locator('.blog-directory-toolbar')).toHaveAttribute('data-ready', 'true');
  const summary = page.locator('.blog-category-filter summary');
  await summary.click();
  await expect(page.locator('.blog-category-panel')).toBeVisible();
  const panelBounds = await page.locator('.blog-category-panel').evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }));
  expect(panelBounds.bottom).toBeLessThanOrEqual(panelBounds.viewport - 12);
  await page.keyboard.press('Escape');
  await expect(page.locator('.blog-category-panel')).not.toBeVisible();
  await expect(summary).toBeFocused();
  expect(await page.locator('.blog-directory-toolbar').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
});

test('访客目录沿用新版布局，不显示站内创建与精选入口', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/explore');
  await expect(page.locator('.blogs-hero h1')).toHaveText('博客');
  await expect(page.getByRole('searchbox', { name: '搜索博客' })).toHaveAttribute('placeholder', '搜索标题、作者、简介');
  await expect(page.getByRole('link', { name: '创建博客', exact: true })).toHaveCount(0);
  await expect(page.locator('.blog-directory-scopes')).toHaveCount(0);
  await expect(page.locator('.blog-stats')).toHaveCount(0);
});
