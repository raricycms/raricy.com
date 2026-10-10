// ─────────────────────────────────────────────────────────────────────────────
// ios-app.spec.ts —— iOS Safari「添加到主屏幕」适配的端到端
//
// 覆盖六件事（都是「源码里看着对、只有真浏览器才说得清」的）：
//   1. 根文档带 manifest + Apple 主屏元数据，且声明的图标**真的取得回来**；
//   2. 触屏下文本字段字号 ≥16px（否则 iOS 聚焦会强制放大整页），桌面值不变；
//   3. standalone（已从主屏图标打开）时安装引导隐藏；
//   4. 文章页「返回上页」在没有上一页时落到站内列表，而不是变成死键。
//   5. 主题色跟随偏好，且没有重复声明；
//   6. 非零安全区在顶栏、正文和输入区各让位一次。
//
// 【本文件登记在 RESPONSIVE_SPECS 里】字号那条只有 mobile 那一遍（coarse 指针）才验得到
// 正向分支；桌面那一遍同时验「桌面值没被改动」这条反向分支。其余三条两遍等价，跟着双跑。
//
// 【判据取可观测事实】manifest/图标断言打的是**取回来的资源**（状态码 + content-type +
// JSON 字段），字号打 getComputedStyle，返回落点打最终 URL —— 都不照抄源码里的字符串。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_BLOG, SEED_USERS } from './seed';

const BLOG_URL = `/blog/${SEED_BLOG.id}`;
/** 与实现里那条媒体查询同源 —— 但断言看的是**它算出来的字号**，不是这条串本身。 */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/** 读某个元素某个选择器的计算字号（px）。选择器一个都命中不到时返回 null。 */
async function fontPx(page: Page, selector: string): Promise<number | null> {
  // CodeMirror 在 hydration 后挂载，等待真实控件，避免把加载中的占位误报为缺失。
  await expect(page.locator(selector).first()).toBeVisible();
  return page
    .locator(selector)
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize));
}

async function setSafeArea(page: Page, insets: { top: number; right: number; bottom: number; left: number }) {
  await page.evaluate((values) => {
    for (const [side, px] of Object.entries(values)) {
      document.documentElement.style.setProperty(`--safe-${side}`, `${px}px`);
    }
  }, insets);
}

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

test('触屏下文本字段字号 ≥16px，桌面保持原值', async ({ page }) => {
  // 通用字段（登录页用户名 / 密码）
  await page.goto('/login');
  const coarse = await page.evaluate((q: string) => window.matchMedia(q).matches, TOUCH_QUERY);

  const check = (px: number | null, label: string, required = true) => {
    if (px === null) {
      if (required) expect(px, `${label}：没渲染出来（选择器变了？）`).not.toBeNull();
      return;
    }
    if (coarse) {
      expect(
        px,
        `${label} 在触屏下必须 ≥16px，否则 iOS 聚焦时会强制把整页放大`
      ).toBeGreaterThanOrEqual(16);
    } else {
      expect(px, `${label} 在桌面下的字号不该被改动`).toBeLessThan(16);
    }
  };

  check(await fontPx(page, '#username'), '登录页用户名');
  check(await fontPx(page, '#password'), '登录页密码');

  await loginViaApi(page, SEED_USERS.core.username);

  // 讨论 / 评论共用的富文本输入区（文章页的评论框）
  await page.goto(BLOG_URL);
  check(await fontPx(page, '.comment-composer__input'), '评论输入区');

  // 全站共用类搜索框
  await page.goto('/blog');
  check(await fontPx(page, '.search-input'), '博客搜索框');

  // 编辑器（CodeMirror）的实际 contenteditable 字号。
  await page.goto('/blog/upload');
  check(await fontPx(page, '.md-editor .cm-content'), '编辑器源码区（CodeMirror）');
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

test('主题色跟随保存的偏好及手动切换，只有一条主题色声明', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('theme-test-seeded')) {
      localStorage.setItem('theme', 'dark');
      sessionStorage.setItem('theme-test-seeded', 'true');
    }
  });
  await page.goto('/');
  const color = page.locator('meta[name="theme-color"]');
  await expect(color).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(color).toHaveAttribute('content', '#131517');
  await page.waitForFunction(() => typeof (window as unknown as { switchTheme?: unknown }).switchTheme === 'function');
  await page.evaluate(() => (window as unknown as { switchTheme: (t: string) => void }).switchTheme('light'));
  await expect(color).toHaveAttribute('content', '#F8FAFC');
  // 清掉手动偏好后，系统主题变化也更新窗口颜色，且不写入手动偏好。
  await page.evaluate(() => localStorage.removeItem('theme'));
  await page.reload();
  await page.waitForFunction(() => typeof (window as unknown as { switchTheme?: unknown }).switchTheme === 'function');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(color).toHaveAttribute('content', '#131517');
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull();
});

test('非零安全区：顶栏、正文和讨论底部各让位一次', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto('/chat');
  await expect(page.locator('.chat-composer')).toBeVisible();
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty('--safe-top', '20px');
    root.setProperty('--safe-left', '24px');
    root.setProperty('--safe-right', '20px');
    root.setProperty('--safe-bottom', '34px');
  });
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.site-navbar')!.getBoundingClientRect();
    const chat = document.querySelector('.chat-page')!.getBoundingClientRect();
    const composer = document.querySelector('.chat-composer')!;
    return {
      headerHeight: header.height,
      bodyTop: parseFloat(getComputedStyle(document.body).paddingTop),
      chatTop: chat.top, chatLeft: chat.left, chatRight: chat.right, chatBottom: chat.bottom,
      composerBottomPadding: parseFloat(getComputedStyle(composer).paddingBottom),
      innerMainPadding: parseFloat(getComputedStyle(document.querySelector('.chat-main')!).paddingLeft),
      width: window.innerWidth, height: window.innerHeight,
    };
  });
  expect(geometry.headerHeight).toBeCloseTo(82, 0);
  expect(geometry.bodyTop).toBeCloseTo(82, 0);
  expect(geometry.chatTop).toBeCloseTo(82, 0);
  expect(geometry.chatLeft).toBeCloseTo(24, 0);
  expect(geometry.chatRight).toBeCloseTo(geometry.width - 20, 0);
  expect(geometry.chatBottom).toBeCloseTo(geometry.height, 0);
  expect(geometry.composerBottomPadding).toBeCloseTo(44, 0);
  expect(geometry.innerMainPadding).toBe(0);
  // 模拟键盘引起的可视区收缩，验证 hook 与 CSS 的连接；不等同于真机软键盘验收。
  const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperties(vv, {
      height: { value: window.innerHeight - 300, configurable: true },
      offsetTop: { value: 40, configurable: true },
      scale: { value: 1, configurable: true },
    });
    vv.dispatchEvent(new Event('resize'));
  });
  const override = () => page.locator('.chat-page').evaluate(el =>
    (el as HTMLElement).style.getPropertyValue('--chat-vv-bottom'));
  await expect.poll(override).toBe(coarse ? `${geometry.height - 260}px` : '');
  if (coarse) {
    const chat = await page.locator('.chat-page').boundingBox();
    expect(chat!.y + chat!.height).toBeCloseTo(geometry.height - 260, 0);
  }
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'scale', { value: 2, configurable: true });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(override).toBe('');
  // 普通页面也经过相同横屏安全区，而非只修讨论输入框。
  await page.goto('/login');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-left', '24px');
    document.documentElement.style.setProperty('--safe-right', '20px');
  });
  const bounds = await page.locator('#username').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(24);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(geometry.width - 20);
});

test('长 modal-overlay 弹窗的关闭与底部操作都避开安全区', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await loginViaApi(page, SEED_USERS.owner.username);
  await page.goto('/admin/categories');
  await setSafeArea(page, { top: 59, right: 28, bottom: 34, left: 32 });
  await page.getByRole('button', { name: '+ 新建栏目' }).click();

  const overlay = page.locator('.modal-overlay.show');
  const dialog = overlay.locator('.modal-dialog');
  const close = overlay.locator('.modal-header button');
  await expect(dialog).toBeVisible();
  const closeBox = await close.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(closeBox!.y, '关闭按钮不能落入顶部安全区').toBeGreaterThanOrEqual(59);
  expect(dialogBox!.x).toBeGreaterThanOrEqual(32);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390 - 28);

  // 真表单比视口高：滚到最下沿后，保存与取消仍在 Home Indicator 上方且可以点击。
  expect(await overlay.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await overlay.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const saveBox = await overlay.getByRole('button', { name: '保存', exact: true }).boundingBox();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(664 - 34);
  await overlay.getByRole('button', { name: '取消', exact: true }).click();
  await expect(overlay).toHaveCount(0);
});

test('看图关闭和缩放控件在竖屏、横屏及零安全区下都可用', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const upload = await page.request.post('/api/images', {
    multipart: { file: { name: 'safe-area.png', mimeType: 'image/png', buffer: png } },
  });
  expect(upload.status()).toBe(200);
  const imageId = (await upload.json()).id as string;
  const posted = await page.request.post('/api/chat/channels/lobby/messages', {
    data: { content: `e2e-safe-image-${uniqueTag()}`, image_id: imageId },
  });
  expect(posted.status()).toBe(200);
  await page.goto('/chat?channel=lobby');

  for (const scenario of [
    { width: 390, height: 664, top: 0, right: 0, bottom: 0, left: 0 },
    { width: 390, height: 664, top: 59, right: 0, bottom: 34, left: 0 },
    { width: 844, height: 390, top: 0, right: 59, bottom: 21, left: 59 },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await setSafeArea(page, scenario);
    await page.locator(`.chat-msg__image[src*="${imageId}"]`).click();
    const lightbox = page.locator('.chat-lightbox');
    await expect(lightbox).toBeVisible();
    const close = lightbox.getByRole('button', { name: '关闭', exact: true });
    const closeBox = await close.boundingBox();
    const zoomBox = await lightbox.locator('.chat-lightbox__zoom').boundingBox();
    expect(closeBox!.y).toBeCloseTo(16 + scenario.top, 0);
    expect(closeBox!.x + closeBox!.width).toBeCloseTo(scenario.width - 20 - scenario.right, 0);
    expect(zoomBox!.y + zoomBox!.height).toBeCloseTo(
      scenario.height - (scenario.width <= 640 ? 32 : 24) - scenario.bottom, 0
    );
    expect(zoomBox!.x).toBeGreaterThanOrEqual(scenario.left);
    expect(zoomBox!.x + zoomBox!.width).toBeLessThanOrEqual(scenario.width - scenario.right);
    await lightbox.getByRole('button', { name: '放大', exact: true }).click();
    await expect(lightbox.locator('.chat-lightbox__zoom-level')).toHaveText('150%');
    await close.click();
    await expect(lightbox).toHaveCount(0);
  }
});
