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

test('顶栏：长用户名不挤出头像，导航文字在各宽度保持横排', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // 使用合法上限的真实用户名，避免仅测短种子名而漏掉布局溢出。
  const tag = uniqueTag();
  const username = '名'.repeat(12) + tag.slice(-8);
  const registration = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD },
  });
  expect((await registration.json()).code).toBe(200);
  const widths = isMobile ? [320, 375, 390, 768] : [808, 809, 960, 991, 992, 1024, 1199, 1200, 1280, 1440];
  for (const width of widths) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      // 每档从新页面开始，避免移动端缩放与上一档的展开状态影响点击坐标。
      // 跨断点时保留同一页面的行为由下一条用例单独验证。
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('#userDropdownToggle > span').first()).toHaveAttribute('title', username);
      const toggler = page.locator('.site-navbar-toggler');
      if (await toggler.isVisible() && await toggler.getAttribute('aria-expanded') !== 'true') {
        await toggler.click();
      }
      const links = page.locator('.site-nav .site-link');
      await expect(links).toHaveCount(5);
      for (const link of await links.all()) {
        const box = (await link.boundingBox())!;
        expect(box.height, `${width}px 导航文字拆行`).toBeLessThanOrEqual(48);
      }

      const bounds = await page.locator('.site-navbar').evaluate(header => ({
        width: header.clientWidth,
        scrollWidth: header.scrollWidth,
        items: Array.from(header.querySelectorAll('.site-brand, .site-link, .site-actions > *, .site-user-avatar'))
          .map(el => el.getBoundingClientRect()).filter(box => box.width > 0)
          .map(box => ({ left: box.left, right: box.right })),
      }));
      expect(bounds.scrollWidth, `${width}px 顶栏横向溢出`).toBeLessThanOrEqual(bounds.width);
      for (const box of bounds.items) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
      }
      expect((await page.locator('.site-user-avatar').boundingBox())!.width).toBeCloseTo(32, 0);
      const label = page.locator('#userDropdownToggle > span').first();
      expect(await label.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);

      await page.locator('#userDropdownToggle').click();
      const menu = page.locator('#userDropdownMenu');
      await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible();
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      for (const item of await menu.getByRole('menuitem').all()) {
        expect(await item.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.locator('#userDropdownToggle').press('Escape');
    });
  }
});

test('顶栏：访客跨折叠断点后可继续使用导航', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1199, height: 900 });
  await page.goto('/');
  const toggler = page.locator('.site-navbar-toggler');
  await toggler.click();
  await expect(page.locator('.site-login-btn')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggler).toHaveAttribute('aria-expanded', 'false');

  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(toggler).toBeHidden();
  await expect.poll(() => page.locator('#siteNavbar').evaluate(el => (el as HTMLElement).inert)).toBe(false);
  await page.locator('.site-login-btn').focus();
  await expect(page.locator('.site-login-btn')).toBeFocused();

  await page.setViewportSize({ width: 1199, height: 900 });
  await expect(page.locator('.site-nav')).toBeHidden();
  await toggler.click();
  await page.locator('.site-nav a[href="/story"]').click();
  await expect(page).toHaveURL('/story');
  await expect(toggler).toHaveAttribute('aria-expanded', 'false');
});
