import { expect, test, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { DIRECTORY_SEED, SEED_USERS } from './seed';

test.beforeEach(async ({ page }) => {
  await loginViaApi(page, SEED_USERS.directory.username);
});

async function openPersonal(page: Page) {
  const toggle = page.getByRole('button', { name: '展开我的博客', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

test('筛选条的行数、侧栏的高度和真实吸顶位置', async ({ page, isMobile }, testInfo) => {
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item')).toHaveCount(50);
  await expect(page.locator('.blog-item').first()).toBeVisible();
  const search = (await page.locator('.blog-filters .search-form').boundingBox())!;
  const category = (await page.locator('.blog-category-select').boundingBox())!;
  const sort = (await page.locator('.blog-sort').boundingBox())!;
  const controls = await page.locator('.blog-filters').evaluate((el) => [
    '.search-input', '.blog-category-select__toggle', '.segmented',
  ].map((selector) => el.querySelector(selector)!.getBoundingClientRect().height));
  expect(Math.max(...controls) - Math.min(...controls)).toBeLessThan(1);
  await expect(page.locator('.blogs-hero .upload-button')).toHaveCount(0);
  await expect(page.locator('.blog-personal__create')).toHaveAttribute('href', '/blog/upload');
  await expect(page.locator('.blog-personal .avatar')).toHaveCount(1);
  if (isMobile) {
    expect(category.y).toBeGreaterThanOrEqual(search.y + search.height);
    expect(Math.abs(category.y - sort.y)).toBeLessThan(4);
    await expect(page.locator('.blog-personal__panel')).toBeHidden();
    expect((await page.locator('.blog-personal').boundingBox())!.width).toBe(64);
  } else {
    const filters = page.locator('.blog-filters');
    const radius = await filters.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
    expect(radius).toBeGreaterThanOrEqual((await filters.boundingBox())!.height / 2);
    expect(Math.abs(category.y - search.y)).toBeLessThan(4);
    expect(Math.abs(category.y - sort.y)).toBeLessThan(4);
    expect((await page.locator('.blog-personal').boundingBox())!.width).toBe(280);
    expect((await page.locator('.blog-personal').boundingBox())!.height).toBeLessThan(500);
  }
  await page.evaluate(() => window.scrollTo(0, 650));
  // 手机视觉视口可相对布局视口平移；两者都用浏览器测量值，以顶栏下沿为基准。
  await expect.poll(async () => {
    const header = (await page.locator('.site-navbar').boundingBox())!;
    return Math.round((await page.locator('.blog-filters').boundingBox())!.y - header.y - header.height);
  }).toBe(isMobile ? 8 : 12);
  if (!isMobile) {
    await expect.poll(async () => Math.round((await page.locator('.blog-personal').boundingBox())!.y)).toBe(74);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const mask = await page.locator('.blog-filters').evaluate((el) => {
      const style = getComputedStyle(el, '::before');
      return { left: el.getBoundingClientRect().left + parseFloat(style.left), width: parseFloat(style.width), viewport: document.documentElement.clientWidth, background: style.backgroundImage, page: getComputedStyle(document.documentElement).getPropertyValue('--color-background-page').trim(), pointerEvents: style.pointerEvents };
    });
    expect(Math.abs(mask.left)).toBeLessThan(1);
    expect(mask.width).toBe(mask.viewport);
    expect(mask.background).toContain('linear-gradient');
    expect(mask.background).toContain(theme === 'light' ? '248, 250, 252' : '19, 21, 23');
    expect(mask.pointerEvents).toBe('none');
    await page.screenshot({ path: testInfo.outputPath(`sticky-mask-${theme}.png`), animations: 'disabled' });
  }
});

test('栏目在同一外壳内展开，二级缩进，选择保留范围/搜索/排序并回第一页', async ({ page }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&sort=updated&page=2`);
  const toggle = page.getByRole('button', { name: '栏目：全部栏目', exact: true });
  await toggle.click();
  const shell = page.locator('.blog-category-select__shell');
  expect(await shell.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('width');
  await expect.poll(async () => (await shell.boundingBox())!.width).toBeGreaterThan(140);
  const collapsedWidth = (await shell.boundingBox())!.width;
  const expand = page.getByRole('button', { name: `展开${DIRECTORY_SEED.parent.name}的二级栏目`, exact: true });
  await expand.click();
  const child = page.getByRole('button', { name: DIRECTORY_SEED.child.name, exact: true });
  await expect(child).toBeVisible();
  await expect.poll(async () => (await shell.boundingBox())!.width).toBeGreaterThan(collapsedWidth + 20);
  // 等宽度动画结束后，最长文本仍完整显示，父按钮的底色也覆盖箭头区域。
  await expect.poll(async () => child.locator('span').evaluate((el) => el.clientWidth >= el.scrollWidth)).toBe(true);
  const parent = page.locator('.blog-category-select__parent').filter({ has: page.getByRole('button', { name: DIRECTORY_SEED.parent.name, exact: true }) });
  await parent.hover();
  await expect.poll(async () => parent.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const childPadding = await child.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  const parentPadding = await page.getByRole('button', { name: DIRECTORY_SEED.parent.name, exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(childPadding).toBeGreaterThan(parentPadding);
  await child.click();
  await expect(page).toHaveURL(/category=e2e-directory-child/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('scope')).toBe('mine');
  expect(params.get('search')).toBe(DIRECTORY_SEED.titlePrefix);
  expect(params.get('sort')).toBe('updated');
  expect(params.has('page')).toBe(false);
  await expect(page.locator('.blog-item')).toHaveCount(50);
  await page.getByRole('button', { name: `栏目：${DIRECTORY_SEED.child.name}`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.blog-category-select__panel')).toHaveAttribute('inert', '');
});

test('个人面板使用统计胶囊，窄屏由同一个头像连续移动展开', async ({ page, isMobile }, testInfo) => {
  await page.goto('/blog?scope=mine');
  if (isMobile) {
    const motion = await page.locator('.blog-personal').evaluate(async (host) => {
      const avatar = host.querySelector('.blog-personal__avatar')!;
      const start = avatar.getBoundingClientRect().toJSON();
      (host.querySelector('.blog-personal__toggle') as HTMLButtonElement).click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = host.getAnimations({ subtree: true });
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 210; });
      const middle = avatar.getBoundingClientRect().toJSON();
      animations.forEach((animation) => animation.finish());
      const end = avatar.getBoundingClientRect().toJSON();
      return { start, middle, end, same: avatar === host.querySelector('.blog-personal__avatar'), avatars: host.querySelectorAll('.avatar').length };
    });
    expect(motion.same).toBe(true);
    expect(motion.avatars).toBe(1);
    expect(motion.start.width).toBe(40);
    expect(motion.middle.width).toBeGreaterThan(motion.start.width);
    expect(motion.middle.width).toBeLessThan(motion.end.width);
    expect(motion.end.width).toBe(48);
    expect(motion.middle.y).toBeLessThan(motion.start.y);
    expect(motion.middle.y).toBeGreaterThan(motion.end.y);
    await expect(page.getByRole('button', { name: '收起我的博客', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('personal-avatar-expanded.png') });
  }
  const stats = page.locator('.blog-personal__stats');
  await expect(stats).toContainText('获赞');
  await expect(stats).toContainText('收获鱼干');
  expect(await stats.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await expect(stats.locator('.blog-likes')).toBeVisible();
  await expect(stats.locator('.blog-fish')).toBeVisible();
  await expect(page.locator('.blog-personal').getByRole('link', { name: '创建', exact: true })).toBeVisible();
});

test('四个范围使用同一列表，空状态清掉筛选后保留当前范围', async ({ page, isMobile }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&category=${DIRECTORY_SEED.child.slug}&sort=updated&page=2`);
  await openPersonal(page);
  await expect(page.getByRole('link', { name: '我发布的 51', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '我赞过的 1', exact: true }).click();
  await expect(page.locator('.no-blogs')).toContainText('「我赞过的」中没有匹配的文章');
  expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  await page.getByRole('link', { name: '清掉筛选', exact: true }).click();
  await expect(page.locator(`#id${DIRECTORY_SEED.likedId}`)).toBeVisible();
  await expect(page.locator('.blog-item')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('scope')).toBe('liked');
  expect(new URL(page.url()).searchParams.has('search')).toBe(false);
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
  await openPersonal(page);
  await page.getByRole('link', { name: '我投喂过的 1', exact: true }).click();
  await expect(page.locator(`#id${DIRECTORY_SEED.fedId}`)).toBeVisible();
  await expect(page.locator('.blog-item')).toHaveCount(1);
  await openPersonal(page);
  await page.getByRole('link', { name: /^全部文章 / }).click();
  await expect(page.locator('.blog-directory__scope')).toHaveText('全部文章');
  expect(new URL(page.url()).searchParams.has('scope')).toBe(false);
  if (isMobile) await expect(page.locator('.blog-personal__panel')).toHaveAttribute('inert', '');
});

test('范围内分页保留筛选，第二页显示实际的剩余文章', async ({ page }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&category=${DIRECTORY_SEED.child.slug}&sort=updated`);
  await page.getByRole('link', { name: '2', exact: true }).click();
  await expect(page.locator('.blog-item')).toHaveCount(1);
  await expect(page.locator('#ide2e-directory-50')).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ scope: 'mine', category: DIRECTORY_SEED.child.slug, search: DIRECTORY_SEED.titlePrefix, sort: 'updated', page: '2' });
});

test('浅色/深色及浮层的视觉检查，减少动态效果时直接切换', async ({ page, isMobile }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item')).toHaveCount(50);
  await expect(page.locator('.blog-item').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('directory-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.getByRole('button', { name: '栏目：全部栏目', exact: true }).click();
  const duration = await page.locator('.blog-category-select__panel').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration).toBe('0s');
  await page.screenshot({ path: testInfo.outputPath('directory-dark-categories.png') });
  await page.keyboard.press('Escape');
  if (isMobile) {
    await openPersonal(page);
    await expect(page.getByRole('link', { name: '我发布的 51', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('directory-dark-personal.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '展开我的博客', exact: true })).toBeFocused();
  }
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    const category = (await page.locator('.blog-category-select').boundingBox())!;
    const sort = (await page.locator('.blog-sort').boundingBox())!;
    expect(category.x + category.width).toBeLessThanOrEqual(sort.x);
    expect((await page.getByRole('searchbox', { name: '搜索文章' }).boundingBox())!.width).toBeGreaterThan(100);
  }
});
