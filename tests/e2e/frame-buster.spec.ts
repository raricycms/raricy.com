// FrameBuster（src/app/components/FrameBuster.tsx）在真浏览器里的行为。
//
// 【为什么必须 E2E】这段逻辑只有真浏览器能验：window.self !== window.top 的判定、
// location.ancestorOrigins 的跨域可见性、水合之后才挂上的 Esc/焦点逻辑 —— 单测里全是假的。
// 该组件此前零覆盖（上一版是底部横条，上线时没有任何用例）。
//
// 【怎么造一个真跨站嵌入】父页是 baseURL（http://127.0.0.1:3100），iframe 指向
// http://localhost:3100 —— 同一个服务的两个 hostname，浏览器视作不同 origin
// （组件里的 isSameSite 只比 hostname、不看端口），跨站判定因此成立。
// 不用 page.route 伪造父页：那是「公网页面嵌 loopback」，会撞上 Chrome 的
// Local Network Access 限制，得不偿失。
//
// 【两个 project 都要过】desktop 是 Chromium、mobile 实际是 WebKit
// （devices['iPhone 13'] 带 defaultBrowserType: 'webkit'）—— ancestorOrigins 正是
// WebKit 系 API，两边都有，缺的只有 Firefox（本项目没有该 project）。

import { test, expect, type FrameLocator, type Page } from '@playwright/test';

/** 与服务同实例、不同 hostname → 浏览器视作跨站。 */
const CROSS_SITE_SRC = 'http://localhost:3100/';

/** 在父页里注入一个全屏 iframe，返回它的 FrameLocator。
 *  `sandbox` 缺省不设 —— 多数用例要的就是「普通嵌入」；给了就照原样写进 sandbox 属性。 */
async function embed(page: Page, src: string, sandbox?: string): Promise<FrameLocator> {
  await page.evaluate(({ iframeSrc, sandboxAttr }) => {
    document.getElementById('e2e-embed')?.remove();
    const f = document.createElement('iframe');
    f.id = 'e2e-embed';
    // sandbox 必须在 src 之前挂上：先加载再改 sandbox，Chrome 会强制重载整个文档
    if (sandboxAttr) f.setAttribute('sandbox', sandboxAttr);
    f.src = iframeSrc;
    Object.assign(f.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      border: '0',
      // 夹具必须压过父页自己的一切：顶栏是 fixed z-index 1030、<main> 是 body 的
      // flex 项（实测它的内容会盖在 z-index:auto 的 fixed iframe 上）。不抬到顶，
      // Playwright 的命中测试会打到父页的 .site-navbar / 正文，点击永远重试到超时。
      zIndex: '2147483647',
    });
    document.body.appendChild(f);
  }, { iframeSrc: src, sandboxAttr: sandbox ?? '' });
  return page.frameLocator('#e2e-embed');
}

test.describe('FrameBuster：跨站 iframe 嵌入提示', () => {
  test('跨站嵌入 → 弹居中模态；点遮罩不关；Esc 关', async ({ page }) => {
    await page.goto('/');
    const frame = await embed(page, CROSS_SITE_SRC);

    const overlay = frame.locator('.frame-buster');
    // 模态要等 iframe 文档下载 + 水合之后才出现，给足时间
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(frame.locator('.frame-buster__dialog')).toHaveAttribute('role', 'dialog');

    // 点遮罩左上角（卡片居中，两个 project 视口下该点都在卡片外）—— 按约定不应关闭
    await overlay.click({ position: { x: 6, y: 6 } });
    await expect(overlay).toBeVisible();

    // Esc：FrameLocator 没有 .press()，先把焦点交给卡片，再由 page 发键（会落到 iframe 内）
    await frame.locator('.frame-buster__dialog').focus();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('「继续浏览」可关闭；整页重载后仍会再弹（不记忆）', async ({ page }) => {
    await page.goto('/');
    let frame = await embed(page, CROSS_SITE_SRC);
    await expect(frame.locator('.frame-buster')).toBeVisible({ timeout: 15_000 });

    await frame.getByRole('button', { name: '继续浏览' }).click();
    await expect(frame.locator('.frame-buster')).toHaveCount(0);

    // 整页重载 → root layout 重新挂载 → 再弹一次。没有任何持久化，这是刻意行为。
    await page.reload();
    frame = await embed(page, CROSS_SITE_SRC);
    await expect(frame.locator('.frame-buster')).toBeVisible({ timeout: 15_000 });
  });

  test('普通嵌入 → 「全屏打开」把顶层窗口导航走', async ({ page }) => {
    await page.goto('/');
    const frame = await embed(page, CROSS_SITE_SRC);
    await expect(frame.locator('.frame-buster')).toBeVisible({ timeout: 15_000 });

    await frame.getByRole('link', { name: '全屏打开' }).click();
    // 顶层窗口整个换成 iframe 里的那个地址（不是开新标签页）—— 正常嵌入下这一跳就够了
    await page.waitForURL(/localhost:3100/, { timeout: 15_000 });
  });

  test('正常访问与同站嵌入 → 什么都不渲染', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.frame-buster')).toHaveCount(0); // 顶层访问

    const frame = await embed(page, '/'); // 同 hostname → 同站
    // 等到「被动副作用已 flush」的确定信号：HeroCanvas 在 effect 里写 canvas.width，
    // SSR 输出没有该属性 —— 它出现即证明同一批 effect（含 FrameBuster 的检测）已经跑过。
    await expect(frame.locator('#hero-canvas')).toHaveAttribute('width', /\d+/);
    await expect(frame.locator('.frame-buster')).toHaveCount(0);
  });
});

// 嵌入方给 iframe 挂 sandbox 时，「跳出」会逐级失效。三档分别对应组件里的两段兜底：
//   无 sandbox             → <a target="_top"> 直接跳走（上面那条普通嵌入用例）
//   allow-popups           → 顶层导航被拦，500ms 后 window.open 接住
//   两样都不开              → 只能把按钮切成第二段提示，别让用户对着死按钮点
test.describe('FrameBuster：sandbox 挡住跳出时的兜底', () => {
  test('未开 allow-top-navigation、开了 allow-popups → 转而开新窗口', async ({ page }) => {
    await page.goto('/');
    const frame = await embed(page, CROSS_SITE_SRC, 'allow-scripts allow-same-origin allow-popups');
    await expect(frame.locator('.frame-buster')).toBeVisible({ timeout: 15_000 });

    // 用 context 的 page 事件而不是 page 的 popup 事件：只是不想依赖「新窗口与
    // 这张 page 的 opener 关联」——组件会顺手把新窗口的 opener 置空。**实测两个都触发**
    // （opener 关联在窗口创建时就定了，事后置空不影响），所以这里不是绕坑，只是选了个
    // 耦合更少的写法。
    const popupPromise = page.context().waitForEvent('page', { timeout: 20_000 });
    await frame.getByRole('link', { name: '全屏打开' }).click();

    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('localhost:3100');
    // 顶层窗口纹丝不动 —— 这正是「点了没反应」的那一档，兜底是唯一的出口
    expect(page.url()).toContain('127.0.0.1:3100');
  });

  test('sandbox 两样都不开 → 按钮切成第二段，提示右键复制链接', async ({ page }) => {
    await page.goto('/');
    const frame = await embed(page, CROSS_SITE_SRC, 'allow-scripts allow-same-origin');
    await expect(frame.locator('.frame-buster')).toBeVisible({ timeout: 15_000 });

    await frame.getByRole('link', { name: '全屏打开' }).click();

    // 顶层导航被拦 + window.open 返回 null（宽限 500ms 后才判定）→ 第二段文案
    await expect(frame.getByRole('link', { name: '在新窗口打开' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(frame.locator('.frame-buster__text')).toContainText('复制链接');
  });
});
