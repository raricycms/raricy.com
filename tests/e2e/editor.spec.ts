import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// Markdown 编辑器（博客 / 云剪贴板共用）的行为、版面与主题。
//
// 【为什么要 E2E】这一层全是「源码里看着对、真跑起来不对」的东西：
//   · 工具条按钮与 `Mod-b` 必须是**同一条命令路径**，否则用按钮加的粗体撤销不掉；
//   · 视图切换是 CSS 属性选择器驱动的（`.md-editor[data-mode=...]`）——写错一个
//     属性名，两栏会同时显示或同时消失，而 React 那边一点都不报错；
//   · 主题跟随靠的是站点 CSS 变量级联，读源码看不出「换主题后颜色有没有真的变」；
//   · 窄屏要少给「并排」这一档，而它是**样式表**藏掉的，JS 侧看不出来。
//
// 【断言的是行为，不是 CM6 的 DOM】正文一律经**预览**读回（`#editor .md-editor__preview-body`
// 里的成品 HTML），而不是去读 `.cm-content` 的 innerText：后者是 CM6 的内部结构，
// 换个小版本就可能变，而「我打的字渲染出来是什么样」才是用户看得见的事实。
// 同理，主题断言打在**我们自己的** `.md-toolbar` 上，不碰 CM6 注入的样式表。

/** 编辑器外壳在两张表单里的 id。 */
const BLOG_EDITOR = '#editor';
const CLIP_EDITOR = '#clipboard-editor';

/**
 * 移动端顶栏是折叠的（`layout/_header.scss` 里 808px 以下 `.site-navbar-collapse`
 * 是 `max-height: 0; overflow: hidden`）：`#themeToggle` 与导航链接虽然**仍有**
 * bounding box（Playwright 据此判「visible」），但整个盒子被父级裁掉、压在页面内容
 * 下面，点击点会落在 hero 上 → 被拦截。真机上用户也是先点汉堡才看得到这些入口。
 */
async function openNavIfMobile(page: Page, isMobile: boolean) {
  if (!isMobile) return;
  const navbar = page.locator('.site-navbar');
  if (await navbar.evaluate((el) => el.classList.contains('open'))) return;
  await page.click('.site-navbar-toggler');
  await expect(navbar).toHaveClass(/open/);
}

/** 把站点切到指定主题：点真实的 #themeToggle，不直接改 DOM 属性。 */
async function switchToTheme(page: Page, want: 'light' | 'dark') {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (current !== want) await page.click('#themeToggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', want);
}

/**
 * 读某个元素某个计算样式的**落定值**。
 *
 * 站点有一条全局 `* { transition: color .3s, background-color .3s }`（layout/_header.scss）
 * —— 切主题因此是 300ms 渐变：CSS 变量立刻变，但 getComputedStyle 在动画途中读到的是
 * 中间色，刚点完读到的≈旧色（mobile 上必现，desktop 只是恰好读得晚）。
 * 轮询到连续两次读数一致即视为过渡结束。
 */
async function settledStyle(
  page: Page,
  selector: string,
  prop: 'backgroundColor' | 'color'
): Promise<string> {
  let prev = '';
  let sameCount = 0;
  await expect
    .poll(
      async () => {
        const now = await page
          .locator(selector)
          .first()
          .evaluate((el, p) => getComputedStyle(el)[p as 'color'] as string, prop);
        sameCount = now === prev ? sameCount + 1 : 0;
        prev = now;
        return sameCount;
      },
      { timeout: 5000 }
    )
    .toBeGreaterThanOrEqual(1);
  return prev;
}

/** 收集页面上未捕获的错误。编辑器这一层最容易出的就是「初始化时抛在回调里」——
 *  页面上一点提示都没有，只是某个功能静默不工作。 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** 只看**静态资源**的 404：路径拼错、资源改名、包被删掉之后留下的引用都长这样。
 *  不去盯全部 404 —— 接口的 404 有各自的语义，不归这里管。 */
function collectAsset404(page: Page): string[] {
  const missing: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 404 && /\.(?:css|js|mjs|png|svg|woff2?)(?:\?|$)/.test(r.url())) {
      missing.push(r.url());
    }
  });
  return missing;
}

/** 在编辑区里打字。先点一下把焦点放进去（CM6 要焦点才收键盘）。 */
async function typeInEditor(page: Page, editor: string, text: string) {
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.type(text);
}

/**
 * CM6 认的 `Mod-` 修饰键是哪个 —— 直接照它自己的判据算。
 *
 * 【为什么不能写死 Control】CM6 的键位表把 `Mod-b` 解析成「平台的常用修饰键」，
 * 判据是它启动时算好的 `browser.mac`：`iOS 判据 || /Mac/.test(navigator.platform)`。
 * 而 e2e 的 mobile project 用 iPhone 13 的 UA —— `navigator.vendor` 被改写成
 * `Apple Computer, Inc.`、UA 里有 `Mobile/…`，于是 **CM6 认为自己跑在 iOS 上**，
 * `Mod` = **Cmd**；可 `navigator.platform` 仍是 Win32（Playwright 不覆盖它）。
 * 两个信号相矛盾，结果就是「发 Ctrl 什么都不会发生」——看起来和「快捷键压根没绑」
 * 一模一样。真机上没有这个错位，这是模拟环境的产物，所以按 CM6 的规则镜像一份。
 */
async function modKey(page: Page): Promise<'Meta' | 'Control'> {
  const cm6SaysMac = await page.evaluate(() => {
    const nav = navigator;
    const ios =
      /Apple Computer/.test(nav.vendor) &&
      (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2);
    return ios || /Mac/.test(nav.platform);
  });
  return cm6SaysMac ? 'Meta' : 'Control';
}

/** 切到某一档视图。 */
async function setViewMode(page: Page, editor: string, label: '编辑' | '并排' | '预览') {
  await page.locator(editor).getByRole('button', { name: label, exact: true }).click();
}

test.describe('编辑器行为', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  test('博客编辑器：工具条、字数统计与「粗体」按钮都真的作用在正文上', async ({ page }) => {
    await page.goto('/blog/upload');
    await expect(page.locator(`${BLOG_EDITOR} .md-toolbar`)).toBeVisible();

    // 初始是空的（新建页没有服务端正文，也没有草稿）
    await expect(page.locator(`${BLOG_EDITOR} .md-editor__count`)).toHaveText('0 字');

    await typeInEditor(page, BLOG_EDITOR, 'hello');
    await expect(page.locator(`${BLOG_EDITOR} .md-editor__count`)).toHaveText('5 字');

    // 全选后点工具条的「粗体」—— 断在**预览**上：命令有没有真的落进正文，
    // 只有整篇渲染出来才看得见（只断字数的话，包不包标记都不影响长度之外的东西）
    const mod = await modKey(page);
    await page.keyboard.press(`${mod}+a`);
    await page.locator(BLOG_EDITOR).getByRole('button', { name: '粗体', exact: true }).click();
    await setViewMode(page, BLOG_EDITOR, '预览');

    const preview = page.locator(`${BLOG_EDITOR} .md-editor__preview-body`);
    await expect(preview.locator('strong')).toHaveText('hello');
    // 标记本身不该出现在渲染结果里
    await expect(preview).not.toContainText('**');
  });

  test('快捷键 Mod-b 与工具条走同一条命令路径（都能撤销）', async ({ page }) => {
    await page.goto('/blog/upload');
    await typeInEditor(page, BLOG_EDITOR, 'abc');
    const mod = await modKey(page);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+b`);

    await setViewMode(page, BLOG_EDITOR, '预览');
    const preview = page.locator(`${BLOG_EDITOR} .md-editor__preview-body`);
    await expect(preview.locator('strong')).toHaveText('abc');

    // 撤销要能一步退回去 —— 工具条命令若不进撤销历史，这里会留下 <strong>
    await setViewMode(page, BLOG_EDITOR, '编辑');
    await page.locator(`${BLOG_EDITOR} .cm-content`).click();
    await page.keyboard.press(`${mod}+z`);
    await setViewMode(page, BLOG_EDITOR, '预览');
    await expect(preview.locator('strong')).toHaveCount(0);
    await expect(preview).toContainText('abc');
  });

  test('视图三档：桌面能并排，窄屏不给并排这一档', async ({ page, isMobile }) => {
    await page.goto('/blog/upload');
    const editor = page.locator(BLOG_EDITOR);
    const source = page.locator(`${BLOG_EDITOR} .md-editor__pane--source`);
    const preview = page.locator(`${BLOG_EDITOR} .md-editor__pane--preview`);

    const splitBtn = editor.getByRole('button', { name: '并排', exact: true });
    if (isMobile) {
      // 390px 上并排 = 两栏各不到 190px。按钮整个不出现（不是点了没反应）
      await expect(splitBtn).toBeHidden();
    } else {
      await expect(splitBtn).toBeVisible();
      await setViewMode(page, BLOG_EDITOR, '并排');
      await expect(source).toBeVisible();
      await expect(preview).toBeVisible();
    }

    // 「预览」这一档两边都有：只剩预览面板
    await setViewMode(page, BLOG_EDITOR, '预览');
    await expect(preview).toBeVisible();
    await expect(source).toBeHidden();

    // 「编辑」这一档：只剩源码
    await setViewMode(page, BLOG_EDITOR, '编辑');
    await expect(source).toBeVisible();
    await expect(preview).toBeHidden();

    // 切回编辑后光标还能落进去（面板藏过一轮之后 CM6 的布局要自己恢复）
    await typeInEditor(page, BLOG_EDITOR, 'x');
    await expect(page.locator(`${BLOG_EDITOR} .md-editor__count`)).toHaveText('1 字');
  });

  test('预览是只读的：切换视图、刷新引用都不发任何写请求', async ({ page }) => {
    await page.goto('/blog/upload');

    await typeInEditor(page, BLOG_EDITOR, '# 标题');
    await page.keyboard.press('Enter');
    await page.keyboard.type('正文里的图片：');
    await page.keyboard.type('![图](/api/images/abcdefghij/raw)');

    // 从现在起数写请求。预览整篇渲染会去取引用数据（GET），但**一个写都不该有**
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      if (r.url().includes('/api/')) writes.push(`${r.method()} ${r.url()}`);
    });

    await setViewMode(page, BLOG_EDITOR, '预览');
    const preview = page.locator(`${BLOG_EDITOR} .md-editor__preview-body`);
    await expect(preview.locator('h1')).toHaveText('标题');
    await expect(preview.locator('img')).toHaveAttribute('src', /\/api\/images\/abcdefghij\/raw$/);

    // 刷新引用：真的重取，且同样只读
    await page.locator(BLOG_EDITOR).getByRole('button', { name: '刷新预览' }).click();
    await expect(preview.locator('h1')).toHaveText('标题');

    expect(writes, `预览期间出现了写请求：${writes.join(' / ')}`).toEqual([]);
  });

  // 音频控件撑破正文：`<audio controls>` 的浏览器默认宽度约 300px 且不随容器收缩，
  // 而窄屏 390px 下预览盒子的**可用内容宽度只有 244px** —— 控件比容器还宽，于是正文
  // 出现横向滚动，控件右半截被滚动盒子裁掉。判据必须是**几何**：`doc.scrollWidth`
  // 量不出来（外层页面确实没有溢出，被滚动盒子吃掉了），只有预览容器自己的
  // scrollWidth/clientWidth 与控件右边缘才说得清。
  // 单测钉不到：这纯粹是浏览器排版事实（盒子宽度 + 替换元素的默认尺寸），
  // jsdom 里没有排版。移动端才是主场景，桌面那一遍同时验「宽屏没有被顺手改窄」。
  test('★ 预览里的音频控件不撑破正文容器（窄视口下也不被裁）★', async ({ page }) => {
    // 只用 ID3v2 头的最小 MP3 —— 服务端只嗅头几个字节（audio-upload.ts）。
    // 布局取决于元素的盒子，与能不能解码无关，但真上传一条才走的是真链路。
    const MP3_MIN = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
    const up = await page.request.post('/api/audio', {
      multipart: { file: { name: 'e2e-audio.mp3', mimeType: 'audio/mpeg', buffer: MP3_MIN } },
    });
    const upBody = await up.json();
    expect(upBody.code, `上传音频失败：${JSON.stringify(upBody)}`).toBe(200);

    await page.goto('/blog/upload');
    await typeInEditor(page, BLOG_EDITOR, `[@音频/${upBody.id}]`);
    await setViewMode(page, BLOG_EDITOR, '预览');

    const preview = page.locator(`${BLOG_EDITOR} .md-editor__preview-body`);
    const audio = preview.locator('audio');
    await expect(audio).toHaveCount(1);

    const geo = await preview.evaluate((el) => {
      const a = el.querySelector('audio') as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        audioRight: a.getBoundingClientRect().right,
        contentRight: el.getBoundingClientRect().right - parseFloat(cs.paddingRight),
        audioWidth: a.getBoundingClientRect().width,
      };
    });

    // 1px 容差：亚像素布局的取整
    expect(
      geo.scrollWidth,
      `预览容器被撑出横向滚动：scrollWidth=${geo.scrollWidth} > clientWidth=${geo.clientWidth}`
    ).toBeLessThanOrEqual(geo.clientWidth + 1);
    expect(
      geo.audioRight,
      `音频控件越过了正文可用宽度（控件 ${geo.audioWidth}px，右边缘 ${geo.audioRight} > ${geo.contentRight}）`
    ).toBeLessThanOrEqual(geo.contentRight + 1);
    // 反向：宽屏上**不许被顺手拉长**。用 `width: 100%` 去「修」溢出的话，桌面端会
    // 从 300px 变成整列宽 —— 那是另一种坏法，别让它悄悄换一种错法。
    expect(
      geo.audioWidth,
      `音频控件被拉长了（${geo.audioWidth}px > 控件本来的 300px）`
    ).toBeLessThanOrEqual(300);
  });
});

test.describe('编辑器跟随站点主题', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  for (const [name, url, editor] of [
    ['博客', '/blog/upload', BLOG_EDITOR],
    ['云剪贴板', '/clipboard/upload', CLIP_EDITOR],
  ] as const) {
    test(`${name}编辑器：亮 / 暗切换时工具条底色与代码高亮轨道都跟着变`, async ({
      page,
      isMobile,
    }) => {
      const asset404 = collectAsset404(page);
      const pageErrors = collectPageErrors(page);

      await page.goto(url);
      await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();
      await openNavIfMobile(page, isMobile);

      // ── 亮色基线 ──────────────────────────────────────────────────────────
      await switchToTheme(page, 'light');
      await expect(page.locator('#hljs-theme-light')).toHaveAttribute('media', 'all');
      await expect(page.locator('#hljs-theme-dark')).toHaveAttribute('media', 'not all');
      const lightBg = await settledStyle(page, `${editor} .md-toolbar`, 'backgroundColor');

      // ── 切到暗色 ──────────────────────────────────────────────────────────
      await switchToTheme(page, 'dark');
      await expect(page.locator('#hljs-theme-light')).toHaveAttribute('media', 'not all');
      await expect(page.locator('#hljs-theme-dark')).toHaveAttribute('media', 'all');
      const darkBg = await settledStyle(page, `${editor} .md-toolbar`, 'backgroundColor');

      // 「变量换了」不等于「颜色真的变了」—— 断言算出来的底色确实不同
      //（编辑器配色全走站点 CSS 变量，缺一个变量就是静默不生效）
      expect(darkBg).not.toBe(lightBg);

      // ── 切回亮色，确认是双向的而不是单程 ──────────────────────────────────
      await switchToTheme(page, 'light');
      await expect(page.locator('#hljs-theme-light')).toHaveAttribute('media', 'all');
      expect(await settledStyle(page, `${editor} .md-toolbar`, 'backgroundColor')).toBe(lightBg);

      expect(asset404, `静态资源 404：${asset404.join(', ')}`).toEqual([]);
      expect(pageErrors, `页面有未捕获错误：${pageErrors.join(' / ')}`).toEqual([]);
    });
  }

  test('离开编辑页后，正文页的代码高亮仍然只有一份生效', async ({ page, isMobile }) => {
    // 两份 <style>（github / monokai）是**全局单例、从不移除**：一个实例卸载时摘掉
    // 它会连同还在页上的其他实例（正文页 + 编辑器预览同屏是常态）一起打回无高亮。
    // 这条守的是「编辑器离开后没把正文页的高亮带走」——旧实现靠卸载时删 <link>，
    // 新实现靠 media 开关，两者要防的是同一件事。
    await page.goto('/blog/upload');
    await expect(page.locator(`${BLOG_EDITOR} .md-toolbar`)).toBeVisible();
    await openNavIfMobile(page, isMobile);

    // 走站内链接做客户端跳转 —— 整页刷新的话 <head> 本来就重建了，测不到卸载路径
    await page.click('a[href="/blog"]');
    await expect(page).toHaveURL(/\/blog$/);

    await expect(page.locator('#hljs-theme-light')).toHaveCount(1);
    await expect(page.locator('#hljs-theme-dark')).toHaveCount(1);
    // 且仍然只有一份生效
    const medias = await page.evaluate(() => [
      document.getElementById('hljs-theme-light')?.getAttribute('media'),
      document.getElementById('hljs-theme-dark')?.getAttribute('media'),
    ]);
    expect(medias.filter((m) => m === 'all')).toHaveLength(1);
  });
});
