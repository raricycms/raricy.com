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
    const capsule = (await page.locator('.blog-personal').boundingBox())!;
    // 125 = 左内距 13 + 加号 44 + 间距 8 + 头像 44 + 右侧留白 16（见 _directory.scss）。
    expect(capsule.width).toBe(125);
    expect(capsule.height).toBe(70);
    const plus = (await page.locator('.blog-personal__create').boundingBox())!;
    expect(plus.width).toBe(44);
    expect(plus.height).toBe(44);
  } else {
    const filters = page.locator('.blog-filters');
    const radius = await filters.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
    expect(radius).toBeGreaterThanOrEqual((await filters.boundingBox())!.height / 2);
    expect(Math.abs(category.y - search.y)).toBeLessThan(4);
    expect(Math.abs(category.y - sort.y)).toBeLessThan(4);
    expect((await page.locator('.blog-personal').boundingBox())!.width).toBe(280);
    expect((await page.locator('.blog-personal').boundingBox())!.height).toBeLessThan(500);
    // 桌面没有「展开」这回事，蒙版整个不渲染。
    await expect(page.locator('.blog-personal__backdrop')).toBeHidden();
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
      return { left: el.getBoundingClientRect().left + parseFloat(style.left), width: parseFloat(style.width), viewport: document.documentElement.clientWidth, mask: style.maskImage, background: style.backgroundColor, pointerEvents: style.pointerEvents };
    });
    expect(Math.abs(mask.left)).toBeLessThan(1);
    expect(mask.width).toBe(mask.viewport);
    expect(mask.mask).toContain('linear-gradient');
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
      const create = host.querySelector('.blog-personal__create')!;
      const createLabel = host.querySelector('.blog-personal__create-label')!;
      const start = avatar.getBoundingClientRect().toJSON();
      const startCreate = create.getBoundingClientRect().toJSON();
      const startStyle = { bg: getComputedStyle(create).backgroundColor, label: getComputedStyle(createLabel).opacity };
      (host.querySelector('.blog-personal__toggle') as HTMLButtonElement).click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = host.getAnimations({ subtree: true });
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 210; });
      const middle = avatar.getBoundingClientRect().toJSON();
      const middleCreate = create.getBoundingClientRect().toJSON();
      const gutter = host.querySelector('.blog-personal__inner')!;
      const scroll = { overflow: getComputedStyle(gutter).overflowY, gutter: gutter.getBoundingClientRect().width - gutter.clientWidth };
      animations.forEach((animation) => animation.finish());
      const end = avatar.getBoundingClientRect().toJSON();
      const endCreate = create.getBoundingClientRect().toJSON();
      const endStyle = { bg: getComputedStyle(create).backgroundColor, label: getComputedStyle(createLabel).opacity };
      return {
        start, middle, end, startCreate, middleCreate, endCreate, startStyle, endStyle,
        scroll, same: avatar === host.querySelector('.blog-personal__avatar'),
        avatars: host.querySelectorAll('.avatar').length,
      };
    });
    expect(motion.same).toBe(true);
    expect(motion.avatars).toBe(1);
    expect(motion.scroll.overflow).toBe('hidden');
    expect(Math.abs(motion.scroll.gutter)).toBeLessThan(1);
    expect(motion.start.width).toBe(44);
    expect(motion.middle.width).toBeGreaterThan(motion.start.width);
    expect(motion.middle.width).toBeLessThan(motion.end.width);
    expect(motion.end.width).toBe(48);
    expect(motion.middle.y).toBeLessThan(motion.start.y);
    expect(motion.middle.y).toBeGreaterThan(motion.end.y);
    // 收起时加号在头像球左侧（胶囊左端），展开后二者在面板左沿对齐。
    expect(motion.startCreate.left + motion.startCreate.width).toBeLessThan(motion.start.left);
    expect(Math.abs(motion.end.left - motion.endCreate.left)).toBeLessThan(1);
    // 同一个「创建」元素从圆形加号长成面板底部的创建按钮。
    expect(motion.startCreate.width).toBe(44);
    expect(motion.middleCreate.width).toBeGreaterThan(motion.startCreate.width);
    expect(motion.middleCreate.width).toBeLessThan(motion.endCreate.width);
    expect(motion.endCreate.width).toBe(105);
    expect(motion.startStyle).toEqual({ bg: 'rgba(37, 99, 235, 0.1)', label: '0' });
    expect(motion.endStyle.label).toBe('1');
    // 收起态与展开态是同一个二级主题色容器（只是收起时没有文案）。
    expect(motion.endStyle.bg).toBe(motion.startStyle.bg);
    await expect(page.getByRole('button', { name: '收起我的博客', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('personal-avatar-expanded.png') });
  }
  const stats = page.locator('.blog-personal__stats');
  await expect(stats).toContainText('获赞');
  await expect(stats).toContainText('收获鱼干');
  const pills = await stats.locator('dd').evaluateAll((els) => els.map((el) => ({ text: el.textContent, y: el.getBoundingClientRect().y })));
  expect(pills.map((pill) => pill.text)).toEqual(['+0', '+1', '+0']);
  expect(new Set(pills.map((pill) => pill.y)).size).toBe(1);
  expect(await stats.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await expect(stats.locator('.blog-likes')).toBeVisible();
  await expect(stats.locator('.blog-fish')).toBeVisible();
  await expect(stats.locator('.blog-comments')).toBeVisible();
  await expect(page.locator('.blog-personal').getByRole('link', { name: '创建', exact: true })).toBeVisible();
  if (isMobile) {
    await expect(page.locator('.blog-personal')).toHaveClass(/is-settled/);
    const closing = await page.locator('.blog-personal').evaluate(async (host) => {
      (host.querySelector('.blog-personal__toggle') as HTMLButtonElement).click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = host.getAnimations({ subtree: true });
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 210; });
      const inner = host.querySelector('.blog-personal__inner')!;
      const result = { overflow: getComputedStyle(inner).overflowY, gutter: inner.getBoundingClientRect().width - inner.clientWidth };
      animations.forEach((animation) => animation.finish());
      return result;
    });
    expect(closing.overflow).toBe('hidden');
    expect(Math.abs(closing.gutter)).toBeLessThan(1);
  }
});

test('手机端胶囊：加号直达创建，点头像展开，加号展开成创建按钮', async ({ page, isMobile }) => {
  test.skip(!isMobile, '胶囊只在 ≤992px 的悬浮入口出现');
  await page.goto('/blog?scope=mine');
  const capsule = page.locator('.blog-personal');
  const plus = page.locator('.blog-personal__create');
  const shell = (await capsule.boundingBox())!;
  const create = (await plus.boundingBox())!;
  const head = (await page.locator('.blog-personal__avatar').boundingBox())!;
  // 125 = 左内距 13 + 加号 44 + 间距 8 + 头像 44 + 右侧留白 16。
  expect(Math.round(shell.width)).toBe(125);
  expect(Math.round(shell.height)).toBe(70);
  expect(Math.round(create.width)).toBe(44);
  expect(Math.round(create.height)).toBe(44);
  // 加号在左、头像球在右，同一行，头像右侧留 16px。
  expect(create.x + create.width).toBeLessThan(head.x);
  expect(Math.abs(create.y - head.y)).toBeLessThan(1);
  expect(Math.round(head.x + head.width + 16)).toBe(Math.round(shell.x + shell.width));

  // 加号圆盘与胶囊左端圆角同心：胶囊 radius 35 ⇒ 左端圆角圆心在 (left + 35, bottom - 35)；
  // 加号 44×44、内距 13 ⇒ 圆心在 (left + 13 + 22, bottom - 13 - 22)。同一对数字，
  // 改内距或半径时要一起改，否则「圆盘贴着圆角」会歪成偏心的。
  expect(await capsule.evaluate((el) => parseFloat(getComputedStyle(el.querySelector('.blog-personal__shell')!).borderRadius))).toBe(35);
  expect(Math.abs(create.x + create.width / 2 - (shell.x + 35))).toBeLessThan(0.5);
  expect(Math.abs(create.y + create.height / 2 - (shell.y + shell.height - 35))).toBeLessThan(0.5);
  // 圆盘自身在 44px 里居中（内距 8 + 图标 28 + 内距 8）：收起态视觉与改版前一样。
  const plusIcon = (await plus.locator('.icon').boundingBox())!;
  expect(Math.round(plusIcon.width)).toBe(28);
  expect(Math.abs(plusIcon.x + plusIcon.width / 2 - (create.x + create.width / 2))).toBeLessThan(0.5);
  // 收起态那颗 X 必须正好盖在头像上（同一个 44×44 方块），否则「点头像展开」会点空。
  const headToggle = (await page.locator('.blog-personal__toggle').boundingBox())!;
  expect(Math.abs(headToggle.x - head.x)).toBeLessThan(0.5);
  expect(Math.abs(headToggle.y - head.y)).toBeLessThan(0.5);
  expect(Math.round(headToggle.width)).toBe(44);
  await expect(plus).toHaveAttribute('href', '/blog/upload');
  await expect(plus).toHaveAccessibleName('创建');

  // 点头像（收起态的热区就是这颗头像）展开；「创建」原地长成面板底部的按钮。
  // 用 tap 而不是 click：触屏点按留下的模拟 hover 会黏在同一颗按钮上，而它随后正是
  // 右上角的关闭钮 —— 那样 X 一出现就带着浅底，看着像被悬停过（_directory.scss 的
  // __toggle 因此只给真实鼠标 hover）。
  await page.getByRole('button', { name: '展开我的博客', exact: true }).tap();
  await expect(page.locator('.blog-personal__panel')).toBeVisible();
  await expect(page.locator('.blog-personal')).toHaveClass(/is-settled/);
  await expect(page.locator('.blog-personal__toggle')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByRole('link', { name: '创建', exact: true })).toBeVisible();
  await expect.poll(async () => Math.round((await plus.boundingBox())!.width)).toBe(105);

  // 展开态创建按钮 105×44：内距 8 + 图标 28 + 间距 10 + 文案 40 = 86。
  // 图标圆盘与按钮左端圆角同心（高 44 ⇒ 半径 22，圆心在 left + 22；
  // 图标圆心在 left + 8 + 14），文案右边缘离按钮右端 19px。
  const expandedBox = (await plus.boundingBox())!;
  const expandedIcon = (await plus.locator('.icon').boundingBox())!;
  const expandedLabel = (await plus.locator('.blog-personal__create-label').boundingBox())!;
  expect(Math.round(expandedBox.width)).toBe(105);
  expect(Math.round(expandedBox.height)).toBe(44);
  expect(await plus.evaluate((el) => getComputedStyle(el).padding)).toBe('8px');
  expect(Math.abs(expandedIcon.x - expandedBox.x - 8)).toBeLessThan(0.5);
  expect(Math.abs(expandedIcon.x + expandedIcon.width / 2 - (expandedBox.x + expandedBox.height / 2))).toBeLessThan(0.5);
  expect(Math.round(expandedLabel.width)).toBe(40);
  expect(Math.abs(expandedBox.x + expandedBox.width - (expandedLabel.x + expandedLabel.width) - 19)).toBeLessThan(0.5);

  // 收起后点加号直达创建页，不经过面板。
  await page.getByRole('button', { name: '收起我的博客', exact: true }).click();
  await expect(page.locator('.blog-personal__panel')).toBeHidden();
  await plus.click();
  await expect(page).toHaveURL('/blog/upload');
});

test('手机端展开个人面板时压一层暗色蒙版，顶栏不被蒙，点蒙版收起', async ({ page, isMobile }) => {
  test.skip(!isMobile, '蒙版只在 ≤992px 的悬浮入口出现');
  await page.goto('/blog?scope=mine');
  const backdrop = page.locator('.blog-personal__backdrop');
  const panel = page.locator('.blog-personal__panel');

  // 收起态：元素在（≤992px 才 display:block），但不接收点击。
  // ⚠️ 判据不能用 toBeHidden：opacity:0 的元素在 Playwright 里仍算 visible。
  await expect(backdrop).toHaveCSS('opacity', '0');
  await expect(backdrop).toHaveCSS('pointer-events', 'none');

  await page.getByRole('button', { name: '展开我的博客', exact: true }).tap();
  await expect(panel).toBeVisible();
  await expect(backdrop).toHaveCSS('opacity', '1');
  await expect(backdrop).toHaveCSS('pointer-events', 'auto');
  // 与站内其它遮罩同一个色（.modal / .modal-overlay / .bento-detail__backdrop）。
  await expect(backdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.5)');

  // 铺满可视区，但层级**低于固定顶栏**：顶栏不参与变暗、照常可点；同时高于页面内容。
  // 尺寸基准取 visualViewport：Chromium 的移动模拟里布局视口（clientWidth）比可视区
  // 大一条经典滚动条的宽度，而 fixed 定位的初始包含块跟着可视区走 —— 全站其它固定
  // 遮罩（.modal-overlay、.chat-lightbox）在这个环境里也是同样大小，不是本条的偏差。
  const layout = await page.evaluate(() => {
    const vv = window.visualViewport;
    const navbar = document.querySelector('.site-navbar')!;
    const navRect = navbar.getBoundingClientRect();
    const navHit = document.elementFromPoint(navRect.width / 2, navRect.height / 2);
    return {
      navbar: Number(getComputedStyle(navbar).zIndex),
      host: Number(getComputedStyle(document.querySelector('.blog-personal')!).zIndex),
      filters: Number(getComputedStyle(document.querySelector('.blog-filters')!).zIndex),
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
      // 命中测试：顶栏那条区域里最上层仍是顶栏自己；页面内容那一点最上层是蒙版。
      navbarOnTop: navHit !== null && navbar.contains(navHit),
      scrimOnTop: document.elementFromPoint(12, 220) === document.querySelector('.blog-personal__backdrop'),
    };
  });
  expect(layout.host).toBeLessThan(layout.navbar);
  expect(layout.host).toBeGreaterThan(layout.filters);
  expect(layout.navbarOnTop).toBe(true);
  expect(layout.scrimOnTop).toBe(true);
  const box = (await backdrop.boundingBox())!;
  expect(Math.round(box.width)).toBe(Math.round(layout.width));
  expect(Math.round(box.height)).toBe(Math.round(layout.height));

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
  await expect(page.locator('.blog-directory__scope')).toHaveCount(0);
  await expect(page).toHaveURL((url) => !url.searchParams.has('scope'));
  if (isMobile) await expect(page.locator('.blog-personal__panel')).toHaveAttribute('inert', '');
});

test('栏目闲置文字完整，桌面向左伸缩时搜索框跟随且右端不变', async ({ page, isMobile }, testInfo) => {
  await page.goto('/blog?scope=mine');
  const host = page.locator('.blog-category-select');
  // 首帧的服务端兜底宽度到测量值是水合后的第一次变化：那时宽度过渡必须还是
  // 关着的（全局 `*` 只过渡 color / background-color），否则进入目录页会看到
  // 按钮从 120px 缩短到内容宽度的一段动画。
  await expect(host).not.toHaveClass(/is-ready/);
  expect(await host.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain('width');
  const frames = await host.evaluate(async (el) => {
    const button = el.querySelector('button')!;
    const snapshot = () => {
      const category = el.getBoundingClientRect();
      const search = document.querySelector('.blog-filters .search-field')!.getBoundingClientRect();
      return { right: category.right, width: category.width, searchWidth: search.width };
    };
    const before = snapshot();
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const animations = el.getAnimations({ subtree: true });
    animations.forEach((animation) => { animation.pause(); animation.currentTime = 210; });
    const middle = snapshot();
    animations.forEach((animation) => animation.finish());
    return { before, middle, end: snapshot() };
  });
  if (!isMobile) {
    expect(frames.middle.width).toBeGreaterThan(frames.before.width);
    expect(frames.middle.width).toBeLessThan(frames.end.width);
    expect(frames.middle.right).toBeCloseTo(frames.before.right, 1);
    expect(frames.end.right).toBeCloseTo(frames.before.right, 1);
    expect(frames.middle.searchWidth).toBeLessThan(frames.before.searchWidth);
    expect(frames.end.searchWidth).toBeLessThan(frames.middle.searchWidth);
  }
  // 用户操作过之后宽度过渡才开启（展开动画本身依赖它）。
  expect(await host.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('width');
  await page.getByRole('button', { name: `展开${DIRECTORY_SEED.parent.name}的二级栏目`, exact: true }).click();
  await page.getByRole('button', { name: DIRECTORY_SEED.child.name, exact: true }).click();
  await expect(host).not.toHaveClass(/is-open/);
  await expect.poll(async () => host.locator('button').first().locator('span').evaluate((el) => ({ ellipsis: getComputedStyle(el).textOverflow, fits: el.scrollWidth <= el.clientWidth }))).toMatchObject(isMobile ? { ellipsis: 'clip' } : { fits: true });
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(async () => host.locator('button').first().evaluate((el) => el.querySelector('span')!.getBoundingClientRect().height <= el.getBoundingClientRect().height)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('directory-selected-category.png'), animations: 'disabled' });
});

test('分页与页脚留足间距，跳页输入框有底色并使用折角箭头', async ({ page }) => {
  await page.goto('/blog?scope=mine');
  const pagination = page.getByRole('navigation', { name: '分页', exact: true });
  await pagination.scrollIntoViewIfNeeded();
  const gap = await page.evaluate(() => document.querySelector('.site-footer')!.getBoundingClientRect().top - document.querySelector('.pagination')!.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(60);
  await expect(page.getByRole('link', { name: '下一页', exact: true }).locator('svg')).toBeVisible();
  const input = page.locator('.page-input');
  expect(await input.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor));
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
