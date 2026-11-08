// ─────────────────────────────────────────────────────────────────────────────
// ios-app.spec.ts —— iOS Safari「添加到主屏幕」的三件行为事实
//
// 只保留「源码里看着对、只有真浏览器才说得清」且不是外观的部分：
//   1. 根文档带 manifest + Apple 主屏元数据，声明的图标**真的取得回来**；
//   2. standalone（已从主屏图标打开）时安装引导隐藏；
//   3. 文章页「返回上页」在没有上一页时落到站内列表，而不是变成死键。
//
// 触屏字段字号、theme-color 具体色值、安全区让位的像素几何属于外观，
// 按仓库纪律退出 e2e —— 由受影响页面与真机的实际检查负责。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_BLOG, SEED_USERS } from './seed';

const BLOG_URL = `/blog/${SEED_BLOG.id}`;

test('根文档：manifest、Apple 主屏元数据与图标都齐', async ({ page }) => {
  await page.goto('/');

  // ── manifest：link 在 → 取得回 → 是合法 JSON → 关键字段在 → 图标取得回 ──
  const manifestLink = page.locator('link[rel="manifest"]').first();
  expect(await manifestLink.count(), '缺少 <link rel="manifest">').toBeGreaterThan(0);
  const href = await manifestLink.getAttribute('href');
  expect(href, 'manifest link 没有 href').toBeTruthy();
  const manifestUrl = new URL(href!, page.url()).toString();

  const mres = await page.request.get(manifestUrl);
  expect(mres.status(), `manifest 取不到：${manifestUrl}`).toBe(200);
  const manifest = await mres.json();
  expect(manifest.name || manifest.short_name).toBeTruthy();
  expect(manifest.start_url).toBeTruthy();
  expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
  const icons: { src: string }[] = manifest.icons ?? [];
  expect(icons.length, 'manifest 没声明任何图标').toBeGreaterThan(0);
  for (const icon of icons) {
    const ir = await page.request.get(new URL(icon.src, manifestUrl).toString());
    expect(ir.status(), `图标取不到：${icon.src}`).toBe(200);
    expect(ir.headers()['content-type'] ?? '').toMatch(/^image\//);
  }

  // ── apple-touch-icon：iOS 主屏图标用的就是它 ──
  const appleIcon = page.locator('link[rel="apple-touch-icon"]').first();
  expect(await appleIcon.count(), '缺少 <link rel="apple-touch-icon">').toBeGreaterThan(0);
  const appleHref = await appleIcon.getAttribute('href');
  expect(appleHref, 'apple-touch-icon 没有 href').toBeTruthy();
  const ares = await page.request.get(new URL(appleHref!, page.url()).toString());
  expect(ares.status()).toBe(200);
  expect(ares.headers()['content-type'] ?? '').toMatch(/^image\//);

  // ── 以 standalone 打开：apple-mobile-web-app-capable=yes（或现代别名）──
  const capable = page
    .locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]')
    .first();
  expect(await capable.count(), '缺少 apple-mobile-web-app-capable').toBeGreaterThan(0);
  expect(((await capable.getAttribute('content')) ?? '').toLowerCase()).toBe('yes');

  // ── 不得禁用用户缩放（这条是底线，任何「适配」都不许拿它换）──
  const vp = (await page.locator('meta[name="viewport"]').first().getAttribute('content')) ?? '';
  expect(vp, '缺少 viewport meta').toBeTruthy();
  expect(vp).toMatch(/width\s*=\s*device-width/i);
  expect(vp, 'viewport 不能禁用缩放（user-scalable=no）').not.toMatch(/user-scalable\s*=\s*no/i);
  expect(vp, 'viewport 不能锁死最大缩放（maximum-scale=1）').not.toMatch(
    /maximum-scale\s*=\s*1(\.0)?\b/i
  );
});

test('standalone 下不渲染「添加到主屏幕」引导', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto('/settings');

  // 普通窗口必须显示引导，独立窗口必须隐藏；缺失本身也是回归。
  const heading = page.getByRole('heading', { name: '添加到主屏幕' });
  await expect(heading).toBeVisible();

  // 模拟 iOS standalone：navigator.standalone 与 display-mode 两条判据都置真
  // （组件两条取并集，见 AddToHomeScreenGuide 的 detectStandalone）。
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    } catch {
      // 定义不上也不要紧：下面那条 display-mode 判据是并集的另一支。
    }
    const orig = window.matchMedia.bind(window);
    window.matchMedia = ((q: string) => {
      if (/display-mode:\s*standalone/.test(q)) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList;
      }
      return orig(q);
    }) as typeof window.matchMedia;
  });
  await page.reload();

  await expect(heading, 'standalone 下不该再提示「添加到主屏幕」').toHaveCount(0);
});

test('返回上页：有上一页原样返回，没有则落回站内列表', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  const back = page.getByRole('button', { name: '返回上页' });

  // ① 普通浏览：从 /blog 点进文章（历史里多一条）→ 返回应回到 /blog
  await page.goto('/blog');
  const card = page.locator(`a[href="${BLOG_URL}"]`).first();
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL((u) => u.pathname === BLOG_URL);
  await expect(back).toBeVisible();
  await back.click();
  await page.waitForURL((u) => u.pathname === '/blog');

  // ② 没有上一页（A2HS 冷启 / 从外部点开的链接）：history.length 为 1。
  //    把 length 模拟成 1 是唯一能在这个环境里复现「冷启无历史」的办法。
  await page.goto(BLOG_URL);
  await page.evaluate(() =>
    Object.defineProperty(window.history, 'length', { value: 1, configurable: true })
  );
  await expect(back).toBeVisible();
  await back.click();
  await page.waitForURL((u) => u.pathname === '/blog');
});
