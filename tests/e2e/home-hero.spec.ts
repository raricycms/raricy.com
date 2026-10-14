// 视差与构图依赖浏览器的 SVG 变换和真视口；桌面与 WebKit 触屏都需要检查。
import { test, expect, type Page } from '@playwright/test';

async function mockTiltPermission(page: Page, permission: 'auto' | 'granted' | 'denied' | 'error') {
  await page.addInitScript((result) => {
    // 浏览器自动化没有实体传感器；只替换权限入口，位移仍由真实 SVG 和 RAF 渲染。
    // Linux WebKit 的宿主屏幕默认横向；手机竖屏视口不会自动改传感器坐标。
    Object.defineProperty(window, 'orientation', { configurable: true, value: 0 });
    if (screen.orientation) Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: 0 });
    const constructor = window.DeviceOrientationEvent ?? class extends Event {};
    Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: constructor });
    Object.defineProperty(constructor, 'requestPermission', {
      configurable: true,
      value: result === 'auto' ? undefined : () => {
        const root = document.documentElement;
        root.dataset.tiltPermissionRequests = String(Number(root.dataset.tiltPermissionRequests ?? 0) + 1);
        return result === 'error' ? Promise.reject(new Error('Permission unavailable')) : Promise.resolve(result);
      },
    });
  }, permission);
}

async function sendTilt(page: Page, beta: number | null, gamma: number | null) {
  await page.evaluate(({ beta, gamma }) => {
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma }));
  }, { beta, gamma });
}

function layerOffset(page: Page, near: boolean, axis: 'e' | 'f' = 'e') {
  const layers = page.locator('.hero-scene__layer');
  return (near ? layers.last() : layers.first()).evaluate(
    (el, axis) => new DOMMatrix(getComputedStyle(el).transform)[axis], axis,
  );
}

function expectOffset(page: Page, near: boolean, axis: 'e' | 'f' = 'e') {
  // WebKit 的低帧率 RAF 缓动需要更多时间；轮询真实位移，不用固定等待。
  return expect.poll(() => layerOffset(page, near, axis), { timeout: 10_000, intervals: [100] });
}

test('首页山景：窄屏不溢出，文字和探索入口完整可见', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    const title = page.locator('#hero-title');
    await expect(title).toHaveText('聪明山');
    await expect(page.locator('.hero-tagline')).toHaveText('我们总将找到答案');
    const box = await title.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(16);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(page.getByRole('link', { name: '开始探索' })).toBeVisible();
    await expect(page.locator('.hero-scene__sun')).toHaveCSS('opacity', '1');
    await expect(page.locator('.hero-scene__moon')).toHaveCSS('opacity', '0');
    await page.locator('.hero-section').screenshot({ path: testInfo.outputPath(`hero-${width}-light.png`) });
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await expect(page.locator('#hero-title')).toHaveCSS('color', 'rgb(241, 245, 249)');
  await expect(page.locator('.hero-scene__sun')).toHaveCSS('opacity', '0');
  await expect(page.locator('.hero-scene__moon')).toHaveCSS('opacity', '1');
  await page.locator('.hero-section').screenshot({ path: testInfo.outputPath('hero-desktop-dark.png') });
  await page.getByRole('link', { name: '开始探索' }).click();
  // base.js 接管锚点并平滑滚动，不改 URL；验证实际落点而不是 hash。
  await expect(page.locator('.card-story')).toBeInViewport();
  await expect.poll(async () => page.locator('#features').evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(100);
});

test('切换主题：日月沿弧线持续逆时针旋转并变色，减少动态效果时直接切换', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
  const sun = page.locator('.hero-scene__sun');
  const moon = page.locator('.hero-scene__moon');
  await expect(sun).toHaveCSS('opacity', '1');
  await expect(moon).toHaveCSS('opacity', '0');
  await expect(sun.locator('circle').first()).toHaveCSS('fill', 'rgb(251, 120, 124)');
  if (isMobile) await page.getByRole('button', { name: '切换导航', exact: true }).click();
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // 两颗天体相差半圈；矩阵 b 的符号能区分逆时针续转与原路倒放。
  await expect.poll(async () => page.locator('.hero-scene').evaluate((el) => {
    const sunMatrix = new DOMMatrix(getComputedStyle(el.querySelector('.hero-scene__sun')!).transform);
    const moonMatrix = new DOMMatrix(getComputedStyle(el.querySelector('.hero-scene__moon')!).transform);
    return sunMatrix.b < -0.2 && moonMatrix.b > 0.2;
  }), { intervals: [30, 50, 100] }).toBe(true);
  await expect.poll(async () => sun.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(-1, 5);
  await expect.poll(async () => moon.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(1, 5);
  await expect(moon).toHaveCSS('opacity', '1');
  await expect(moon.locator('circle').first()).toHaveCSS('fill', 'rgb(251, 191, 36)');
  await expect(sun.locator('circle').first()).not.toHaveCSS('fill', 'rgb(251, 120, 124)');
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  await expect.poll(async () => page.locator('.hero-scene').evaluate((el) => {
    const sunMatrix = new DOMMatrix(getComputedStyle(el.querySelector('.hero-scene__sun')!).transform);
    const moonMatrix = new DOMMatrix(getComputedStyle(el.querySelector('.hero-scene__moon')!).transform);
    return sunMatrix.b > 0.2 && moonMatrix.b < -0.2;
  }), { intervals: [30, 50, 100] }).toBe(true);
  await expect.poll(async () => sun.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(1, 5);
  await expect(sun.locator('circle').first()).toHaveCSS('fill', 'rgb(251, 120, 124)');
  await expect(moon).toHaveCSS('opacity', '0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  await expect(sun).toHaveCSS('transition-duration', '0s');
  await expect(moon).toHaveCSS('transition-duration', '0s');
  await expect(moon).toHaveCSS('opacity', '1');
});

test('视差：鼠标驱动景深，文字保持稳定', async ({ page, isMobile }) => {
  test.skip(isMobile, '触屏不模拟鼠标视差');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
  await expect(page.locator('.hero-tilt-toggle')).toHaveCount(0);
  await page.locator('.hero-content').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const near = page.locator('.hero-scene__layer').last();
  const transform = () => near.evaluate((el) => getComputedStyle(el).transform);
  const initial = await transform();
  await page.mouse.move(1360, 300);
  await expect.poll(transform).not.toBe(initial);
  await expect.poll(async () => {
    const matrix = await near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e);
    return matrix;
  }).toBeGreaterThan(18);
  const titleBefore = await page.locator('#hero-title').boundingBox();
  await page.mouse.move(200, 300);
  await expect.poll(async () => near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e)).toBeLessThan(-18);
  const titleAfter = await page.locator('#hero-title').boundingBox();
  expect(titleAfter!.x).toBeCloseTo(titleBefore!.x, 1);
  expect(titleAfter!.y).toBeCloseTo(titleBefore!.y, 1);
});

test.describe('手机倾斜视差', () => {
  test.setTimeout(45_000);
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(!isMobile, '倾斜输入只用于触屏粗指针');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test('无需授权时自动开启，以握持角度校准，分层限幅且文字稳定', async ({ page }) => {
    await mockTiltPermission(page, 'auto');
    await page.goto('/');
    await expect(page.getByRole('button', { name: '关闭倾斜效果' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.hero-content').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const titleBefore = await page.locator('#hero-title').boundingBox();
    await sendTilt(page, null, null);
    await sendTilt(page, 60, 12);
    await expectOffset(page, true).toBeCloseTo(0, 2);
    await expectOffset(page, true, 'f').toBeCloseTo(0, 2);
    await sendTilt(page, 85, 37);
    await expectOffset(page, true).toBeCloseTo(28.6, 1);
    await expectOffset(page, true, 'f').toBeCloseTo(18.2, 1);
    expect(await layerOffset(page, true)).toBeGreaterThan(await layerOffset(page, false) * 5);
    const titleAfter = await page.locator('#hero-title').boundingBox();
    expect(titleAfter!.x).toBeCloseTo(titleBefore!.x, 1);
    expect(titleAfter!.y).toBeCloseTo(titleBefore!.y, 1);
    await sendTilt(page, 145, 87);
    await expectOffset(page, true).toBeCloseTo(28.6, 1);
    await expectOffset(page, true, 'f').toBeCloseTo(18.2, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  });

  test('点击才请求授权，关闭后复位，重新开启不重复请求且重新校准', async ({ page }) => {
    await mockTiltPermission(page, 'granted');
    await page.goto('/');
    await expect(page.getByRole('button', { name: '开启倾斜效果', exact: true })).toBeVisible();
    await sendTilt(page, 60, 0);
    await sendTilt(page, 85, 25);
    await expectOffset(page, true).toBeCloseTo(0, 2);
    await expect(page.locator('html')).not.toHaveAttribute('data-tilt-permission-requests');
    await page.getByRole('button', { name: '开启倾斜效果', exact: true }).click();
    await expect(page.getByRole('button', { name: '关闭倾斜效果' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-tilt-permission-requests', '1');
    await sendTilt(page, 60, 0);
    await sendTilt(page, 60, 25);
    await expectOffset(page, true).toBeGreaterThan(25);
    await page.getByRole('button', { name: '关闭倾斜效果' }).click();
    await expectOffset(page, true).toBeCloseTo(0, 1);
    await sendTilt(page, 60, -25);
    await expectOffset(page, true).toBeCloseTo(0, 1);
    await page.getByRole('button', { name: '开启倾斜效果', exact: true }).click();
    await sendTilt(page, 90, 20);
    await expectOffset(page, true).toBeCloseTo(0, 1);
    await sendTilt(page, 90, -5);
    await expectOffset(page, true).toBeLessThan(-25);
    await expect(page.locator('html')).toHaveAttribute('data-tilt-permission-requests', '1');
  });

  for (const permission of ['denied', 'error'] as const) {
    test(`权限${permission === 'denied' ? '拒绝' : '异常'}时可重试，仍保留滚动视差`, async ({ page }) => {
      await mockTiltPermission(page, permission);
      await page.goto('/');
      await page.getByRole('button', { name: '开启倾斜效果', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('未获授权，仍可滚动浏览山景。');
      await sendTilt(page, 60, 0);
      await sendTilt(page, 85, 25);
      await expectOffset(page, true).toBeCloseTo(0, 1);
      await page.getByRole('button', { name: '重新开启倾斜效果' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-tilt-permission-requests', '2');
      await page.evaluate(() => window.scrollTo(0, 340));
      await expectOffset(page, true, 'f').toBeLessThan(-100);
    });
  }

  test('横竖屏切换重新校准，并按屏幕方向转换传感器轴', async ({ page }) => {
    await mockTiltPermission(page, 'auto');
    await page.goto('/');
    await expect(page.getByRole('button', { name: '关闭倾斜效果' })).toBeVisible();
    for (const angle of [90, -90, 180, 0]) {
      await page.evaluate((angle) => {
        // WebKit 的旧 orientation 与标准 screen.orientation 都需要覆盖。
        Object.defineProperty(window, 'orientation', { configurable: true, value: angle });
        if (screen.orientation) Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: angle });
        window.dispatchEvent(new Event('orientationchange'));
      }, angle);
      await sendTilt(page, 60, 10);
      await expectOffset(page, true).toBeCloseTo(0, 1);
      await expectOffset(page, true, 'f').toBeCloseTo(0, 1);
      await sendTilt(page, 85, 35);
      const radians = angle * Math.PI / 180;
      await expectOffset(page, true).toBeCloseTo(28.6 * (Math.cos(radians) + Math.sin(radians)), 1);
      await expectOffset(page, true, 'f').toBeCloseTo(18.2 * (Math.cos(radians) - Math.sin(radians)), 1);
    }
  });

  test('减少动态效果隐藏入口并停止倾斜，恢复后重新校准', async ({ page }) => {
    await mockTiltPermission(page, 'granted');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
    await expect(page.locator('.hero-tilt-toggle')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-tilt-permission-requests');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: '开启倾斜效果', exact: true }).click();
    await expect(page.getByRole('button', { name: '关闭倾斜效果' })).toBeVisible();
    await sendTilt(page, 60, 0);
    await sendTilt(page, 60, 25);
    await expectOffset(page, true).toBeGreaterThan(25);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.hero-tilt-toggle')).toHaveCount(0);
    await sendTilt(page, 80, -25);
    await expect(page.locator('.hero-scene__layer').last()).toHaveCSS('transform', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByRole('button', { name: '关闭倾斜效果' })).toBeVisible();
    await sendTilt(page, 80, -25);
    await expectOffset(page, true).toBeCloseTo(0, 1);
    await expect(page.locator('html')).toHaveAttribute('data-tilt-permission-requests', '1');
  });

  for (const unavailable of ['api', 'secure-context'] as const) {
    test(`${unavailable}不可用时隐藏倾斜入口，保留山景与探索链接`, async ({ page }) => {
      await page.addInitScript((unavailable) => {
        Object.defineProperty(window, unavailable === 'api' ? 'DeviceOrientationEvent' : 'isSecureContext', {
          configurable: true, value: unavailable === 'api' ? undefined : false,
        });
      }, unavailable);
      await page.goto('/');
      await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
      await expect(page.locator('.hero-tilt-toggle')).toHaveCount(0);
      await expect(page.locator('.hero-scene')).toBeVisible();
      await expect(page.getByRole('link', { name: '开始探索' })).toBeVisible();
    });
  }
});

test('视差：向下滚动景物上移，近景比远景移动更多，回顶复位', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
  const near = page.locator('.hero-scene__layer').last();
  const far = page.locator('.hero-scene__layer').first();
  await page.evaluate(() => window.scrollTo(0, 340));
  await expect.poll(async () => near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f)).toBeLessThan(-100);
  const nearScale = await near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  const farScale = await far.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  expect(nearScale).toBeGreaterThan(farScale);
  expect(nearScale).toBeGreaterThan(1.03);
  const nearY = await near.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f);
  const farY = await far.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f);
  expect(farY).toBeLessThan(0);
  expect(nearY).toBeLessThan(farY * 5);
  await page.screenshot({ path: testInfo.outputPath('hero-scroll.png') });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => near.evaluate((el) => Math.abs(new DOMMatrix(getComputedStyle(el).transform).f))).toBeLessThan(0.1);
});

test('减少动态效果：初始和动态切换偏好都保留静态山景', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.hero-section')).toHaveAttribute('data-scene-ready', 'true');
  await page.evaluate(() => window.scrollTo(0, 250));
  const near = page.locator('.hero-scene__layer').last();
  await expect.poll(async () => near.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => near.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  await page.reload();
  await expect(page.locator('.hero-scene')).toBeVisible();
  await expect.poll(async () => near.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

test('禁用 JavaScript 时山景和探索链接仍可使用', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.locator('.hero-scene')).toBeVisible();
    await expect(page.getByRole('heading', { name: '聪明山', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '开始探索' }).click();
    await expect(page).toHaveURL(/#features$/);
  } finally {
    await context.close();
  }
});
