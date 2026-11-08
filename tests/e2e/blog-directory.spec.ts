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

test('栏目选择保留范围/搜索/排序并回第一页，关闭后恢复 inert', async ({ page }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&sort=updated&page=2`);
  const toggle = page.getByRole('button', { name: '栏目：全部栏目', exact: true });
  await toggle.click();
  const expand = page.getByRole('button', { name: `展开${DIRECTORY_SEED.parent.name}的二级栏目`, exact: true });
  await expand.click();
  const child = page.getByRole('button', { name: DIRECTORY_SEED.child.name, exact: true });
  await expect(child).toBeVisible();
  // 最长栏目文字完整显示（不被截断）；具体宽度与缩进属于视觉设计。
  await expect.poll(async () => child.locator('span').evaluate((el) => el.clientWidth >= el.scrollWidth)).toBe(true);
  await child.click();
  await expect(page).toHaveURL(/category=e2e-directory-child/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('scope')).toBe('mine');
  expect(params.get('search')).toBe(DIRECTORY_SEED.titlePrefix);
  expect(params.get('sort')).toBe('updated');
  expect(params.has('page')).toBe(false);
  await page.getByRole('button', { name: `栏目：${DIRECTORY_SEED.child.name}`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.blog-category-select__panel')).toHaveAttribute('inert', '');
});

test('个人面板展开后显示统计胶囊与创建入口', async ({ page, isMobile }) => {
  await page.goto('/blog?scope=mine');
  if (isMobile) {
    await page.getByRole('button', { name: '展开我的博客', exact: true }).click();
    await expect(page.locator('.blog-personal__panel')).toBeVisible();
    await expect(page.locator('.blog-personal')).toHaveClass(/is-settled/);
    await expect(page.getByRole('button', { name: '收起我的博客', exact: true })).toBeVisible();
  }
  const stats = page.locator('.blog-personal__stats');
  await expect(stats).toContainText('获赞');
  await expect(stats).toContainText('收获鱼干');
  const pillTexts = await stats.locator('dd').evaluateAll((els) => els.map((el) => el.textContent));
  expect(pillTexts).toEqual(['+0', '+1', '+0']);
  await expect(stats.locator('.blog-likes')).toBeVisible();
  await expect(stats.locator('.blog-fish')).toBeVisible();
  await expect(stats.locator('.blog-comments')).toBeVisible();
  await expect(page.locator('.blog-personal').getByRole('link', { name: '创建', exact: true })).toBeVisible();
});

test('手机端胶囊：加号直达创建，点头像展开面板', async ({ page, isMobile }) => {
  test.skip(!isMobile, '胶囊只在 ≤992px 的悬浮入口出现');
  await page.goto('/blog?scope=mine');
  const capsule = page.locator('.blog-personal');
  const plus = page.locator('.blog-personal__create');
  await expect(plus).toHaveAttribute('href', '/blog/upload');
  await expect(plus).toHaveAccessibleName('创建');

  // 点头像（收起态的热区就是这颗头像）展开；用 tap 保留真实触屏路径。
  await page.getByRole('button', { name: '展开我的博客', exact: true }).tap();
  await expect(page.locator('.blog-personal__panel')).toBeVisible();
  await expect(capsule).toHaveClass(/is-settled/);
  await expect(page.getByRole('link', { name: '创建', exact: true })).toBeVisible();

  // 收起后点加号直达创建页，不经过面板。
  await page.getByRole('button', { name: '收起我的博客', exact: true }).click();
  await expect(page.locator('.blog-personal__panel')).toBeHidden();
  await plus.click();
  await expect(page).toHaveURL('/blog/upload');
});

test('手机端展开个人面板时蒙版低于顶栏且点蒙版收起', async ({ page, isMobile }) => {
  test.skip(!isMobile, '蒙版只在 ≤992px 的悬浮入口出现');
  await page.goto('/blog?scope=mine');
  const backdrop = page.locator('.blog-personal__backdrop');
  const panel = page.locator('.blog-personal__panel');

  // 收起态：元素在（≤992px 才 display:block），但不接收点击。
  // ⚠️ 判据不能用 toBeHidden：透明元素在 Playwright 里仍算 visible。
  await expect(backdrop).toHaveCSS('pointer-events', 'none');

  await page.getByRole('button', { name: '展开我的博客', exact: true }).tap();
  await expect(panel).toBeVisible();
  await expect(backdrop).toHaveCSS('pointer-events', 'auto');

  // 层级**低于固定顶栏**：顶栏不参与变暗、照常可点；同时高于页面内容。
  const layout = await page.evaluate(() => {
    const navbar = document.querySelector('.site-navbar')!;
    const navRect = navbar.getBoundingClientRect();
    const navHit = document.elementFromPoint(navRect.width / 2, navRect.height / 2);
    return {
      navbar: Number(getComputedStyle(navbar).zIndex),
      host: Number(getComputedStyle(document.querySelector('.blog-personal')!).zIndex),
      filters: Number(getComputedStyle(document.querySelector('.blog-filters')!).zIndex),
      // 命中测试：顶栏那条区域里最上层仍是顶栏自己；页面内容那一点最上层是蒙版。
      navbarOnTop: navHit !== null && navbar.contains(navHit),
      scrimOnTop: document.elementFromPoint(12, 220) === document.querySelector('.blog-personal__backdrop'),
    };
  });
  expect(layout.host).toBeLessThan(layout.navbar);
  expect(layout.host).toBeGreaterThan(layout.filters);
  expect(layout.navbarOnTop).toBe(true);
  expect(layout.scrimOnTop).toBe(true);

  // 点左上角空白处收起（右下角那块是展开的面板本身，避开它），走触屏路径。
  // 收回挂在 click 上（见下一条用例）：pointerdown 会在松手前就把蒙版变成
  // pointer-events: none，这一下点击就会穿透到下面的文章卡。
  await backdrop.tap({ position: { x: 12, y: 220 } });
  await expect(panel).toBeHidden();
  await expect(backdrop).toHaveCSS('pointer-events', 'none');
});

test('手机端面板：点外部不穿透进文章页，展开时锁住页面滚动', async ({ page, isMobile }) => {
  test.skip(!isMobile, '悬浮入口与蒙版只在 ≤992px 出现');
  await page.goto('/blog?scope=mine');
  const panel = page.locator('.blog-personal__panel');

  // 选点判据：面板收起时这一点必须真的落在某张博客卡的整卡拉伸链接（.blog-item）上，
  // 否则「没有导航」什么也证明不了 —— 点在一片空白上本来就进不去文章页。
  // x 固定 40：展开后外壳左沿在 94（390 - 16 - 280），这一点在面板之外、卡片之内。
  const point = await page.evaluate(() => {
    const box = document.querySelector('.blog-item')!.getBoundingClientRect();
    const x = 40;
    const y = Math.round(box.top + Math.min(60, box.height / 2));
    const hit = document.elementFromPoint(x, y);
    return { x, y, onCard: !!hit?.closest('.blog-item') };
  });
  expect(point.onCard).toBe(true);

  const before = page.url();
  await page.getByRole('button', { name: '展开我的博客', exact: true }).tap();
  await expect(panel).toBeVisible();
  await expect(page.locator('.blog-personal')).toHaveClass(/is-settled/);

  // 展开时锁住 body：不锁的话滚轮停在面板上会把后面那一页带着滚（Chromium 实测
  // window.scrollY 从 0 直接被带到 105）。滚动本身没法在这里复现 —— mobile project
  // 跑的是移动 WebKit，Playwright 的 mouse.wheel 在那个引擎里直接报「不支持」，
  // 所以这里钉的是锁的那条机制（展开即 hidden、收起 / 卸载还原）。
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

  // 点击穿透回归：收起挂在 click 上而不是 pointerdown。按下就收起的话，蒙版在松手前
  // 已经是 pointer-events: none，这次手势生成的 click 落到下面那张卡上，直接进 /blog/<id>。
  await page.touchscreen.tap(point.x, point.y);
  await expect(panel).toBeHidden();
  // 真穿透了的话导航要一点时间才发生：给它窗口，URL 仍是目录页才算过。
  await page.waitForTimeout(600);
  expect(page.url()).toBe(before);

  // 收起后恢复滚动（cleanup 还原 body 的 overflow / padding-right）。
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('五个范围使用同一列表，空状态清掉筛选后保留当前范围', async ({ page, isMobile }) => {
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
  await page.getByRole('link', { name: '我评论过的 1', exact: true }).click();
  await expect(page.locator(`#id${DIRECTORY_SEED.likedId}`)).toBeVisible();
  await expect(page.locator('.blog-item')).toHaveCount(1);
  await openPersonal(page);
  await page.getByRole('link', { name: /^全部文章 / }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has('scope'));
  // 旧断言查 `.blog-directory__scope` —— 该类名在 src 里零命中，恒真（R3-187 ②）。
  // 改为真实可观察状态：范围导航的 aria-current 回到「全部文章」。
  await expect(
    page.locator('.blog-personal__range[aria-current="page"]'),
    '点「全部文章」后范围导航没有回到 all'
  ).toHaveText(/全部文章/);
  if (isMobile) await expect(page.locator('.blog-personal__panel')).toHaveAttribute('inert', '');
});

test('选择栏目后收起面板，栏目文字完整显示', async ({ page, isMobile }) => {
  await page.goto('/blog?scope=mine');
  const host = page.locator('.blog-category-select');
  await page.getByRole('button', { name: '栏目：全部栏目', exact: true }).click();
  await page.getByRole('button', { name: `展开${DIRECTORY_SEED.parent.name}的二级栏目`, exact: true }).click();
  await page.getByRole('button', { name: DIRECTORY_SEED.child.name, exact: true }).click();
  await expect(host).not.toHaveClass(/is-open/);
  if (!isMobile) {
    // 选中后按钮文字完整显示，不能被截断成省略号。
    await expect.poll(async () => host.locator('button').first().locator('span').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(async () => host.locator('button').first().evaluate((el) => el.querySelector('span')!.getBoundingClientRect().height <= el.getBoundingClientRect().height)).toBe(true);
  }
});

test('范围内分页保留筛选，第二页显示实际的剩余文章', async ({ page }) => {
  await page.goto(`/blog?scope=mine&search=${DIRECTORY_SEED.titlePrefix}&category=${DIRECTORY_SEED.child.slug}&sort=updated`);
  await page.getByRole('link', { name: '2', exact: true }).click();
  await expect(page.locator('.blog-item')).toHaveCount(1);
  await expect(page.locator('#ide2e-directory-50')).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ scope: 'mine', category: DIRECTORY_SEED.child.slug, search: DIRECTORY_SEED.titlePrefix, sort: 'updated', page: '2' });
});

test('减少动态效果时栏目面板直接展开，Escape 后焦点回到展开按钮', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item').first()).toBeVisible();
  await page.getByRole('button', { name: '栏目：全部栏目', exact: true }).click();
  // 减少动态效果偏好下不播放展开动画。
  await expect(page.locator('.blog-category-select__panel')).toHaveCSS('transition-duration', '0s');
  await page.keyboard.press('Escape');
  if (isMobile) {
    await openPersonal(page);
    await expect(page.getByRole('link', { name: '我发布的 51', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '展开我的博客', exact: true })).toBeFocused();
  }
});
