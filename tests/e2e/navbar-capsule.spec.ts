import { test, expect } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

test('手机顶栏两个方向都有高度动画，第五个讨论入口按顺序入场', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机折叠布局');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { switchTheme?: unknown }).switchTheme)).toBe('function');
  const toggle = page.getByRole('button', { name: '切换导航', exact: true });
  for (const open of [true, false]) {
    const frames = await toggle.evaluate((el) => {
      const host = el.closest('.site-navbar')!;
      const snapshot = () => host.getBoundingClientRect().height;
      const before = snapshot();
      (el as HTMLButtonElement).click();
      const animations = host.getAnimations({ subtree: true });
      animations.forEach((animation) => { animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) / 2; });
      const middle = snapshot();
      const delays = Array.from(host.querySelectorAll('.site-nav > li')).map((item) => parseFloat(getComputedStyle(item).transitionDelay));
      const visible = getComputedStyle(host.querySelector('.site-navbar-collapse')!).visibility;
      animations.forEach((animation) => animation.finish());
      return { before, middle, end: snapshot(), visible, delays };
    });
    expect(frames.middle).toBeGreaterThan(Math.min(frames.before, frames.end));
    expect(frames.middle).toBeLessThan(Math.max(frames.before, frames.end));
    expect(frames.visible).toBe('visible');
    if (open) expect(frames.delays[4]).toBeGreaterThan(frames.delays[3]);
  }
});

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

test('手机端用户名是固定宽度的文本框：名字过长横向滚动，不省略也不换行', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机折叠布局');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const tag = uniqueTag();
  // 用户报障的那个长度：八个汉字。
  const username = '八个汉字的用户名';
  const registration = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD },
  });
  expect((await registration.json()).code).toBe(200);

  for (const width of [320, 375, 414, 808]) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.site-navbar-toggler').click();

      const name = page.locator('.site-user-name');
      await expect(name).toBeVisible();
      const box = await name.evaluate(el => {
        const style = getComputedStyle(el);
        return {
          overflowX: style.overflowX,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        };
      });

      // ① 不省略号、不折行：名字是一格固定宽度的文本框，溢出靠横向滚动消化。
      //    上一版这里是 `overflow: hidden` + `text-overflow: ellipsis`，八个汉字
      //    在 375px 上只剩四个字，且没有任何办法读到剩下的（手机没有 hover/title）。
      expect(box.overflowX).toBe('auto');
      expect(box.textOverflow).toBe('clip');
      expect(box.whiteSpace).toBe('nowrap');
      // 名字的完整宽度还在内容里，没有被盒子裁掉（否则滚动也读不全）。
      expect(box.scrollWidth).toBeGreaterThanOrEqual(120);

      // ② 装不下时真的滚得动（scrollLeft 能离开 0）。
      if (box.scrollWidth > box.clientWidth) {
        const scrolled = await name.evaluate(el => {
          el.scrollLeft = 40;
          return el.scrollLeft;
        });
        expect(scrolled, `${width}px 用户名可横向滚动`).toBeGreaterThan(0);
      } else {
        // 盒子够宽时八个汉字应当完整可见 —— 320px 的换行档与 808px 的宽档都是这一种。
        expect(box.clientWidth).toBeGreaterThanOrEqual(box.scrollWidth);
      }

      const geometry = await page.evaluate(() => {
        const actions = document.querySelector('.site-actions')!;
        const items = Array.from(actions.children).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            className: el.className.slice(0, 30),
            center: Math.round(rect.top + rect.height / 2),
            left: +rect.left.toFixed(1),
            right: +rect.right.toFixed(1),
          };
        });
        const capsule = document.querySelector('.site-user-dropdown')!.getBoundingClientRect();
        const avatar = document.querySelector('.site-user-avatar')!.getBoundingClientRect();
        const chevron = document.querySelector('.site-user-dropdown-chevron')!.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        return {
          viewport: window.innerWidth,
          items,
          capsule: { left: +capsule.left.toFixed(1), right: +capsule.right.toFixed(1), width: +capsule.width.toFixed(1) },
          avatar: { left: +avatar.left.toFixed(1), right: +avatar.right.toFixed(1) },
          chevron: { left: +chevron.left.toFixed(1), right: +chevron.right.toFixed(1) },
          actionsWidth: +actionsBox.width.toFixed(1),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      // ③ 头像与箭头始终留在胶囊里（名字再长也不把它们挤出去）。
      expect(geometry.avatar.left).toBeGreaterThanOrEqual(geometry.capsule.left);
      expect(geometry.chevron.right).toBeLessThanOrEqual(geometry.capsule.right + 0.5);
      // ④ 整页不出现横向滚动条。
      expect(geometry.pageOverflow).toBe(false);

      // ⑤ 三个图标与用户名胶囊同一行；只有 320px 极窄屏允许整颗胶囊换行，
      //    换行时它铺满操作区整行（宽度来自布局，不来自名字长短）。
      const rows = new Set(geometry.items.map(item => item.center));
      if (width >= 360) {
        expect(rows.size, `${width}px 操作区保持一行`).toBe(1);
        // 胶囊宽度 = 操作区减去三颗图标与间距，与名字长短无关（固定宽度文本框）。
        const icons = geometry.items.filter(item => !item.className.includes('site-user-dropdown'));
        const iconWidth = icons.reduce((sum, item) => sum + (item.right - item.left), 0);
        const gaps = 4 * (geometry.items.length - 1);
        expect(geometry.capsule.width).toBeCloseTo(geometry.actionsWidth - iconWidth - gaps, 0);
      } else {
        expect(rows.size).toBe(2);
        expect(geometry.capsule.width).toBeCloseTo(geometry.actionsWidth, 0);
      }
    });
  }
});

test('手机端长用户名在顶栏展开后自动左右往返，减少动态效果时退回手动滚动', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机折叠布局');
  const tag = uniqueTag();
  // 顶到用户名上限（20 字）：375px 下那一格只放得下四五个汉字，必然溢出。
  const username = '名'.repeat(12) + tag.slice(-8);
  const registration = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD },
  });
  expect((await registration.json()).code).toBe(200);

  await page.setViewportSize({ width: 375, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);

  const name = page.locator('.site-user-name');
  const track = page.locator('.site-user-name__track');

  // 顶栏收起时不该启动：动画只挂在 `.site-navbar.open` 下。
  await expect.poll(() => track.evaluate(el => el.getAnimations().length)).toBe(0);

  await page.locator('.site-navbar-toggler').click();
  await expect(name).toBeVisible();

  const result = await track.evaluate(async (el) => {
    const box = el.closest('.site-user-name') as HTMLElement | null;
    // 用小数宽度算位移：scrollWidth / clientWidth 都是取整值，拿它们和 CSS 动画算出的
    // 小数位移比会在 375px 这一档差出 0.8px（看着像动画算错了，其实只是取整）。
    const overflow = box ? el.getBoundingClientRect().width - box.getBoundingClientRect().width : 0;
    const animations = el.getAnimations();
    const anim = animations.find(
      (a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName === 'site-user-name-pingpong'
    );
    if (!anim) return { overflow, found: false as const };

    const timing = anim.effect!.getComputedTiming();
    const duration = Number(timing.duration);
    const delay = Number(timing.delay);
    anim.pause();
    // 把播放头直接放到关键帧的保持段 / 中点，不靠 sleep 等它自己走 —— 与同文件里
    // 采样顶栏过渡中间帧的做法同源，避免 12s 的循环拖慢用例。
    const at = async (ratio: number) => {
      anim.currentTime = delay + duration * ratio;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return getComputedStyle(el).transform;
    };

    return {
      overflow,
      found: true as const,
      duration,
      delay,
      iterations: timing.iterations === Infinity ? 'infinite' : String(timing.iterations),
      start: await at(0.05),
      end: await at(0.5),
      back: await at(0.95),
    };
  });

  const translateX = (transform: string) => {
    if (transform === 'none') return 0;
    const match = /matrix(3d)?\(([^)]+)\)/.exec(transform);
    if (!match) throw new Error(`无法解析 transform：${transform}`);
    const values = match[2].split(',').map(Number);
    return match[1] ? values[12] : values[4];
  };

  expect(result.found).toBe(true);
  if (!result.found) throw new Error('长用户名没有启动往返动画');
  // 名字比格子宽才有位移；两端的位移都应是 0，中点正好把最后一个字推到右边缘。
  expect(result.overflow).toBeGreaterThan(0);
  expect(result.duration).toBe(12000);
  expect(result.delay).toBeCloseTo(550, 0);
  expect(result.iterations).toBe('infinite');
  expect(translateX(result.start)).toBeCloseTo(0, 1);
  expect(translateX(result.end)).toBeCloseTo(-result.overflow, 1);
  expect(translateX(result.back)).toBeCloseTo(0, 1);

  // 减少动态效果：自动移动整体关闭，但那一格仍是可手动横向滚动的文本框。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => track.evaluate(el => el.getAnimations().length)).toBe(0);
  const manual = await name.evaluate(el => ({
    overflowX: getComputedStyle(el).overflowX,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(manual.overflowX).toBe('auto');
  expect(manual.scrollWidth).toBeGreaterThan(manual.clientWidth);
  expect(await name.evaluate(el => { el.scrollLeft = 30; return el.scrollLeft; })).toBeGreaterThan(0);
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

test('紧凑头像菜单：向左展开和收回都有宽度过渡，头像与相邻入口保持原位', async ({ page, isMobile }) => {
  test.skip(isMobile, '紧凑横排顶栏使用桌面视口检查');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await loginViaApi(page, SEED_USERS.admin.username);

  for (const width of [809, 844, 899]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const toggle = page.locator('#userDropdownToggle');
    await expect(toggle).toBeVisible();

    for (const open of [true, false]) {
      const frames = await toggle.evaluate(el => {
        const shell = el.closest('.site-user-dropdown-shell')!;
        const snapshot = () => {
          const box = shell.getBoundingClientRect();
          const avatar = shell.querySelector('.site-user-avatar')!.getBoundingClientRect();
          const nav = document.querySelector('.site-nav')!.getBoundingClientRect();
          return { width: box.width, right: box.right, avatarX: avatar.x, avatarY: avatar.y, navX: nav.x };
        };
        const before = snapshot();
        (el as HTMLButtonElement).click();
        // 采样真实 CSS 过渡的中间帧，避免靠 sleep 碰运气，也能抓到瞬间切宽的回归。
        const animations = shell.getAnimations({ subtree: true });
        const widthAnimated = animations.some(animation =>
          animation instanceof CSSTransition && animation.transitionProperty === 'width'
        );
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
        }
        const middle = snapshot();
        animations.forEach(animation => animation.finish());
        return { before, middle, after: snapshot(), widthAnimated };
      });
      expect(frames.widthAnimated, `${width}px ${open ? '展开' : '收回'}有过渡`).toBe(true);
      expect(frames.before.width).toBeCloseTo(open ? 80 : 200, 0);
      expect(frames.after.width).toBeCloseTo(open ? 200 : 80, 0);
      expect(frames.middle.width).toBeGreaterThan(80);
      expect(frames.middle.width).toBeLessThan(200);
      for (const frame of [frames.middle, frames.after]) {
        for (const key of ['right', 'avatarX', 'avatarY', 'navX'] as const) {
          expect(frame[key]).toBeCloseTo(frames.before[key], 0);
        }
      }
      await expect(toggle).toHaveAttribute('aria-expanded', String(open));
      if (open) await expect(page.locator('.site-user-name')).toBeVisible();
      else await expect(page.locator('.site-user-name')).toBeHidden();
    }
  }
});
