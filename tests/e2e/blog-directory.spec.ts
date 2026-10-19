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

test('筛选条的行数、侧栏的高度和真实吸顶位置', async ({ page, isMobile }) => {
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item')).toHaveCount(50);
  await expect(page.locator('.blog-item').first()).toBeVisible();
  const search = (await page.locator('.blog-filters .search-form').boundingBox())!;
  const category = (await page.locator('.blog-category-select').boundingBox())!;
  const sort = (await page.locator('.blog-sort').boundingBox())!;
  if (isMobile) {
    expect(category.y).toBeGreaterThanOrEqual(search.y + search.height);
    expect(Math.abs(category.y - sort.y)).toBeLessThan(4);
    await expect(page.locator('.blog-personal__panel')).toBeHidden();
    expect((await page.locator('.blog-personal').boundingBox())!.width).toBe(64);
  } else {
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
});

test('栏目在同一外壳内展开，二级缩进，选择保留范围/搜索/排序并回第一页', async ({ page }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&sort=updated&page=2`);
  const toggle = page.getByRole('button', { name: '栏目：全部栏目', exact: true });
  await toggle.click();
  const expand = page.getByRole('button', { name: `展开${DIRECTORY_SEED.parent.name}的二级栏目`, exact: true });
  await expand.click();
  const child = page.getByRole('button', { name: DIRECTORY_SEED.child.name, exact: true });
  await expect(child).toBeVisible();
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
  await page.getByRole('link', { name: '我喂过鱼的 1', exact: true }).click();
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const category = (await page.locator('.blog-category-select').boundingBox())!;
    const sort = (await page.locator('.blog-sort').boundingBox())!;
    expect(category.x + category.width).toBeLessThanOrEqual(sort.x);
    expect((await page.getByRole('searchbox', { name: '搜索文章' }).boundingBox())!.width).toBeGreaterThan(100);
  }
});
