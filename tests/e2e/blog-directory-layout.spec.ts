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

test('文章目录始终单列，互动计数恢复三色胶囊与标题旁的布局', async ({ page, isMobile }) => {
  await page.goto('/blog');
  await expect(page.locator('.blog-item').nth(1)).toBeVisible();
  const boxes = await page.locator('.blog-item').evaluateAll((items) => items.slice(0, 2).map((item) => {
    const r = item.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom };
  }));
  expect(Math.abs(boxes[0].left - boxes[1].left)).toBeLessThan(1);
  expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom);
  const stats = await page.locator('.blog-item').first().evaluate((card) => {
    const title = card.querySelector('.blog-title')!.getBoundingClientRect();
    const counters = ['.blog-likes', '.blog-comments', '.blog-fish'].map((selector) => {
      const el = card.querySelector(selector)!;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { top: rect.top, left: rect.left, color: style.color, background: style.backgroundColor, radius: style.borderRadius };
    });
    return { title: { top: title.top, right: title.right, bottom: title.bottom }, counters };
  });
  expect(new Set(stats.counters.map((c) => c.color)).size).toBe(3);
  for (const c of stats.counters) {
    expect(c.radius).toBe('999px');
    expect(c.background).not.toBe('rgba(0, 0, 0, 0)');
  }
  if (isMobile) expect(stats.counters[0].top).toBeGreaterThan(stats.title.bottom);
  else {
    expect(stats.counters[0].top).toBeCloseTo(stats.title.top, 0);
    expect(stats.counters[0].left).toBeGreaterThan(stats.title.right);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: '创建博客', exact: true })).toBeVisible();
  await expect(page.locator('.blog-directory-heading__text p')).toHaveText('分享思考与见解');
  await expect(page.locator('.blog-directory-scene')).toBeVisible();
});

test('首屏纸页视差随滚动变化，减少动态效果时立即恢复静态插画', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/blog');
  await expect(page.locator('.blogs-hero')).toHaveAttribute('data-scene-ready', 'true');
  const near = page.locator('.blog-directory-scene__layer').last();
  if (!isMobile) {
    const title = page.locator('.blogs-hero h1');
    const before = await title.boundingBox();
    const hero = await page.locator('.blogs-hero').boundingBox();
    await page.mouse.move(hero!.x + hero!.width * 0.9, hero!.y + hero!.height * 0.4);
    await expect.poll(async () => near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e)).toBeGreaterThan(8);
    const after = await title.boundingBox();
    expect(after!.x).toBeCloseTo(before!.x, 1);
    expect(after!.y).toBeCloseTo(before!.y, 1);
    await page.mouse.move(0, 0);
  }
  await page.evaluate(() => window.scrollTo(0, 140));
  await expect.poll(async () => near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f)).toBeLessThan(-15);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(near).toHaveCSS('transform', 'none');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.blog-directory-scene')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索博客' })).toBeVisible();
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
    // WebKit 的 locator.click 会先对 sticky 元素 scrollIntoView，把页面滚回
    // 按钮的原始文档位置。按当前视口坐标真实触屏点击，验证用户实际看到的吸顶栏。
    const box = await toggle.boundingBox();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(input).toBeFocused();
    await expect(toolbar).toHaveClass(/blog-directory-toolbar--stuck/);
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
