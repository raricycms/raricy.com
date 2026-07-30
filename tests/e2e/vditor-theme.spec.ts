import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// vditor 编辑器跟随站点亮/暗主题。
//
// 【为什么要 E2E】这条链路后端一点都碰不到 —— 三条轨道全在浏览器里：
//   · 外壳    → BlogForm 在 new Vditor 时传 theme，vditor 加 .vditor--dark 类
//   · 正文    → <link id="vditorContentTheme"> 在 light.css / dark.css 之间换
//   · 代码块  → <link id="vditorHljsStyle"> 在 github / monokai 之间换
// 而且第三条是 BlogForm 自己接管的（vditor 的 setCodeTheme 拼 `.css`，包里只有
// `.min.css`，传第三个参数必 404）。这类「页面 200、样式在、只有真去点才知道」
// 的问题正是本仓引入 E2E 的原因。

const CONTENT_THEME = '#vditorContentTheme';
const HLJS_STYLE = '#vditorHljsStyle';

/** 把站点切到指定主题：点真实的 #themeToggle，不直接改 DOM 属性。 */
async function switchToTheme(page: import('@playwright/test').Page, want: 'light' | 'dark') {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (current !== want) await page.click('#themeToggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', want);
}

test.describe('vditor 跟随站点主题', () => {
  test('亮/暗切换时外壳、正文、代码高亮三条轨道同步且无 404', async ({ page }) => {
    // 切主题时会新拉 content-theme / hljs 的 css，任一 404 都说明路径拼错了
    const notFound: string[] = [];
    page.on('response', (r) => {
      if (r.status() === 404 && /vditor/.test(r.url())) notFound.push(r.url());
    });

    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/blog/upload');

    // vditor 是异步初始化的，等它真的把 .vditor 类挂上再断言
    const editor = page.locator('#editor.vditor');
    await expect(editor).toBeVisible();

    // ── 亮色基线 ────────────────────────────────────────────────────────────
    await switchToTheme(page, 'light');
    await expect(editor).not.toHaveClass(/vditor--dark/);
    await expect(page.locator(CONTENT_THEME)).toHaveAttribute('href', /content-theme\/light\.css$/);
    await expect(page.locator(HLJS_STYLE)).toHaveAttribute('href', /styles\/github\.min\.css$/);

    const lightToolbarBg = await page
      .locator('.vditor-toolbar')
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    // ── 切到暗色 ────────────────────────────────────────────────────────────
    await switchToTheme(page, 'dark');
    await expect(editor).toHaveClass(/vditor--dark/);
    await expect(page.locator(CONTENT_THEME)).toHaveAttribute('href', /content-theme\/dark\.css$/);
    await expect(page.locator(HLJS_STYLE)).toHaveAttribute('href', /styles\/monokai\.min\.css$/);

    // 类名换了不等于样式真生效 —— 断言算出来的底色确实变了
    const darkToolbarBg = await page
      .locator('.vditor-toolbar')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkToolbarBg).not.toBe(lightToolbarBg);

    // ── 切回亮色，确认是双向的而非单程 ──────────────────────────────────────
    await switchToTheme(page, 'light');
    await expect(editor).not.toHaveClass(/vditor--dark/);
    await expect(page.locator(CONTENT_THEME)).toHaveAttribute('href', /content-theme\/light\.css$/);
    await expect(page.locator(HLJS_STYLE)).toHaveAttribute('href', /styles\/github\.min\.css$/);

    expect(notFound, `vditor 资源 404：${notFound.join(', ')}`).toEqual([]);
  });

  test('离开编辑页后移除全局 hljs <link>，不污染文章页', async ({ page }) => {
    // #vditorHljsStyle 挂在 <head> 上、全局作用于 .hljs。留着的话，
    // 客户端跳转回文章页会盖掉 MarkdownRenderer 自己的代码高亮主题。
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/blog/upload');
    await expect(page.locator('#editor.vditor')).toBeVisible();
    await expect(page.locator(HLJS_STYLE)).toHaveCount(1);

    // 走站内链接做客户端跳转 —— 整页刷新的话 <head> 本来就重建了，测不到卸载清理
    await page.click('a[href="/blog"]');
    await expect(page).toHaveURL(/\/blog$/);
    await expect(page.locator(HLJS_STYLE)).toHaveCount(0);
  });
});
