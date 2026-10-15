import { test, expect } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

test('用户胶囊：仅光晕悬停、原位向下展开、失焦和 ESC 收起', async ({ page, isMobile }) => {
  await loginViaApi(page, SEED_USERS.admin.username);
  await page.goto('/');
  if (isMobile) {
    await page.locator('.site-navbar-toggler').click();
    // 先等操作按钮入场落定，再量用户胶囊自身的伸缩；不等待角标的无限 pulse。
    await page.locator('.site-actions').evaluate(async actions => {
      await Promise.all(
        Array.from(actions.children).flatMap(el => el.getAnimations()).map(animation => animation.finished)
      );
    });
  }
  const toggle = page.locator('#userDropdownToggle');
  const shell = page.locator('.site-user-dropdown-shell');
  const menu = page.locator('#userDropdownMenu');
  const idle = await toggle.evaluate(el => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  const closed = (await shell.boundingBox())!;
  await toggle.hover();
  await expect.poll(() => shell.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
  expect(await toggle.evaluate(el => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }))).toEqual(idle);
  await toggle.click();
  await expect(menu.getByRole('menuitem')).toHaveCount(5);
  await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
  await expect.poll(async () => (await shell.boundingBox())!.height).toBeGreaterThan(closed.height + 180);
  const open = (await shell.boundingBox())!;
  expect(open.x).toBeCloseTo(closed.x, 0);
  expect(open.y).toBeCloseTo(closed.y, 0);
  expect(open.width).toBeCloseTo(closed.width, 0);
  if (isMobile) await menu.getByRole('menuitem').first().focus();
  else await toggle.press('Tab');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#themeToggle').focus();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await shell.boundingBox())!.height).toBeCloseTo(closed.height, 0);
  await toggle.click();
  if (isMobile) await menu.getByRole('menuitem').first().focus();
  else await toggle.press('Tab');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('顶栏逐步收紧：保留横排导航，长用户名让位给头像，展开菜单不挤动入口', async ({ page, isMobile }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const tag = uniqueTag();
  const username = '名'.repeat(12) + tag.slice(-8);
  const registration = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD },
  });
  expect((await registration.json()).code).toBe(200);

  const widths = isMobile ? [320, 375, 808] : [809, 844, 899, 900, 959, 960, 991, 992, 1024, 1199, 1200, 1440];
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      // 每档重新导航，避免手机模拟器保留上一档的缩放和点击坐标；同一 cookie 保持登录。
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      const toggler = page.locator('.site-navbar-toggler');
      if (width <= 808) await toggler.click();
      else await expect(toggler).toBeHidden();

      const toggle = page.locator('#userDropdownToggle');
      await expect(toggle).toHaveAccessibleName(`用户菜单：${username}`);
      await expect(toggle).toHaveAttribute('title', username);
      const label = page.locator('.site-user-name');
      const avatar = page.locator('.site-user-avatar');
      const before = (await avatar.boundingBox())!;
      expect(before.width).toBeCloseTo(32, 0);
      expect(before.height).toBeCloseTo(32, 0);
      if (width > 808 && width < 900) await expect(label).toBeHidden();
      else expect(await label.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);

      for (const link of await page.locator('.site-nav .site-link').all()) {
        expect((await link.boundingBox())!.height, `${width}px 导航文字不拆行`).toBeLessThanOrEqual(48);
      }
      const geometry = await page.locator('.site-navbar').evaluate(header => ({
        width: header.clientWidth,
        scrollWidth: header.scrollWidth,
        items: Array.from(header.querySelectorAll('.site-brand, .site-link, .site-actions > *'))
          .map(el => el.getBoundingClientRect()).map(box => ({ left: box.left, right: box.right })),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      for (const item of geometry.items) {
        expect(item.left).toBeGreaterThanOrEqual(0);
        expect(item.right).toBeLessThanOrEqual(width);
      }
      const navBefore = (await page.locator('.site-nav').boundingBox())!;
      if (width > 808) {
        const actions = (await page.locator('.site-actions').boundingBox())!;
        expect(navBefore.x + navBefore.width).toBeLessThanOrEqual(actions.x);
        expect((await page.locator('.site-navbar').boundingBox())!.height).toBeCloseTo(62, 0);
      }
      if (!isMobile && [844, 1024, 1440].includes(width)) {
        await page.locator('.site-navbar').screenshot({ path: testInfo.outputPath(`navbar-${width}.png`) });
      }

      await toggle.click();
      const menu = page.locator('#userDropdownMenu');
      await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
      await expect(label).toBeVisible();
      const firstIcon = menu.getByRole('menuitem').first().locator('.icon');
      expect((await label.boundingBox())!.x).toBeCloseTo((await firstIcon.boundingBox())!.x, 0);
      const after = (await avatar.boundingBox())!;
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
      expect((await page.locator('.site-nav').boundingBox())!.x).toBeCloseTo(navBefore.x, 0);
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      for (const item of await menu.getByRole('menuitem').all()) {
        expect(await item.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await toggle.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });
  }
});

test('访客顶栏：中等宽度保留导航和登录入口，手机导航正常收起', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [809, 960, 992, 1024, 1199]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.site-navbar-toggler')).toBeHidden();
    await expect(page.locator('.site-nav a[href="/story"]')).toBeVisible();
    const login = (await page.locator('.site-login-btn').boundingBox())!;
    const register = (await page.locator('.site-actions a[href="/register"]').boundingBox())!;
    expect(register.x + register.width).toBeLessThanOrEqual(width);
    expect(login.height).toBeLessThanOrEqual(48);
  }
  await page.setViewportSize({ width: 808, height: 900 });
  await page.goto('/');
  const toggler = page.locator('.site-navbar-toggler');
  await toggler.click();
  await page.locator('.site-nav a[href="/story"]').click();
  await expect(page).toHaveURL('/story');
  await expect(toggler).toHaveAttribute('aria-expanded', 'false');
});
