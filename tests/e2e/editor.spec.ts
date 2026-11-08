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
// 【Round4 精简】主题色板逐档比对（亮/暗 × 博客/剪贴板 × 工具条/代码底色）与「音频控件
// 宽度」两条纯外观测量已按仓库约定删除（样式按页面/视口验收，见 e2e-app 报告）。
// 这里保留的是浏览器独有且不报错的：工具条命令路径、视图切换、预览只读、代码高亮生命周期。
//
// 【断言的是行为，不是 CM6 的 DOM】正文一律经**预览**读回（`#editor .md-editor__preview-body`
// 里的成品 HTML），而不是去读 `.cm-content` 的 innerText：后者是 CM6 的内部结构，
// 换个小版本就可能变，而「我打的字渲染出来是什么样」才是用户看得见的事实。
// 同理，主题断言打在**我们自己的** `.md-toolbar` 上，不碰 CM6 注入的样式表。

/** 编辑器外壳在两张表单里的 id。 */
const BLOG_EDITOR = '#editor';
const CLIP_EDITOR = '#clipboard-editor';

/**
 * 移动端顶栏是折叠的（`layout/_header.scss` 808px 以下的 `.site-navbar-collapse`
 * 用 `grid-template-rows: 0fr` + `visibility` 收起）：`#themeToggle` 与导航链接虽然
 * **仍有** bounding box（Playwright 据此判「visible」），但整块被 0fr 行裁掉、压在
 * 页面内容下面，点击点会落在 hero 上 → 被拦截。真机上用户也是先点汉堡才看得到这些入口。
 */
async function openNavIfMobile(page: Page, isMobile: boolean) {
  if (!isMobile) return;
  const navbar = page.locator('.site-navbar');
  if (await navbar.evaluate((el) => el.classList.contains('open'))) return;
  await page.click('.site-navbar-toggler');
  await expect(navbar).toHaveClass(/open/);
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

/**
 * 在编辑区里写一段带语言的围栏代码。
 *
 * 高亮断言必须打在**新引擎真的产出的节点**上（`.md-code-block .hljs-*`），
 * 不再依赖旧渲染器那两枚全局 `<style id="hljs-theme-*">`：新引擎按实例渲染，
 * 那两枚 DOM 已经不存在，也不该为了测试把它们加回来。
 */
async function typeCodeBlock(page: Page, editor: string) {
  await typeInEditor(page, editor, '```js');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const answer = 42;');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
}

/**
 * 走「格式 → 某一项」执行一个 Markdown 动作（粗体、标题……）。
 *
 * 四入口 IA 之后，所有 Markdown 写入动作都收在「格式」菜单里；桌面与手机同一条
 * 路径（菜单自己限宽限高、内部滚动），所以窄屏不再需要「先展开工具条」这一步。
 */
async function runInsertAction(page: Page, editor: string, name: string) {
  const scope = page.locator(editor);
  await scope.getByRole('button', { name: '格式', exact: true }).click();
  const menu = scope.locator('.md-toolbar__menu--insert');
  await expect(menu).toBeVisible();
  // 可切换的格式项是 menuitemcheckbox、标题档是 menuitemradio（aria-checked 需要），
  // 纯动作项仍是 menuitem —— 按名字取，不锁死具体 role（R3-119）。
  const item = menu
    .getByRole('menuitem', { name, exact: true })
    .or(menu.getByRole('menuitemcheckbox', { name, exact: true }))
    .or(menu.getByRole('menuitemradio', { name, exact: true }));
  await item.click();
  await expect(menu).toHaveCount(0);
}

/**
 * 页面未捕获异常与静态资源 404 —— 都是「页面照常渲染、某个功能静默不工作」的形态
 * （初始化回调没执行、CSS/高亮主题 404），只有真浏览器能看到。
 * 挂在「离开再回来」这条跨导航用例上，覆盖编辑器两次加载。
 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** 只盯静态资源后缀的 404；接口 404 有各自语义，不归这里管。 */
function collectAsset404(page: Page): string[] {
  const missing: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 404 && /\.(?:css|js|mjs|png|svg|woff2?)(?:\?|$)/.test(r.url())) {
      missing.push(r.url());
    }
  });
  return missing;
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
    // 四入口 IA：所有 Markdown 动作都在「格式」菜单里（桌面 / 手机同一条路径）
    await runInsertAction(page, BLOG_EDITOR, '粗体');
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

});

test.describe('编辑器代码高亮的生命周期（离开再回来）', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });


  test('离开编辑页再回来，新引擎的代码高亮仍然正常（不再依赖全局单例样式）', async ({
    page,
    isMobile,
  }) => {
    const pageErrors = collectPageErrors(page);
    const asset404 = collectAsset404(page);
    // 旧实现把两份 hljs 主题挂成 `<style id="hljs-theme-*">` 全局单例，一个编辑器
    // 卸载时摘掉会连累同屏的另一份。新引擎按实例渲染、没有全局单例可争——
    // 但要守的行为还在：**离开再回来，代码高亮仍然正常**。
    await page.goto('/blog/upload');
    await expect(page.locator(`${BLOG_EDITOR} .md-toolbar`)).toBeVisible();
    await openNavIfMobile(page, isMobile);

    // 走站内链接做客户端跳转，真的经历一次编辑器卸载
    await page.click('a[href="/blog"]');
    await expect(page).toHaveURL(/\/blog$/);

    // 再回编辑器：写代码、预览，高亮节点与颜色都要在
    await page.goto('/blog/upload');
    await expect(page.locator(`${BLOG_EDITOR} .md-toolbar`)).toBeVisible();
    await typeCodeBlock(page, BLOG_EDITOR);
    await setViewMode(page, BLOG_EDITOR, '预览');
    const keyword = page.locator(
      `${BLOG_EDITOR} .md-editor__preview-body .md-code-block .hljs-keyword`
    );
    await expect(keyword.first()).toHaveText('const');
    const tokenColor = await settledStyle(
      page,
      `${BLOG_EDITOR} .md-editor__preview-body .md-code-block .hljs-keyword`,
      'color'
    );
    expect(tokenColor).not.toBe('');

    // 旧渲染器的全局主题节点不再存在，也不该为了这条用例重新加回来
    await expect(page.locator('#hljs-theme-light, #hljs-theme-dark')).toHaveCount(0);

    // 两次加载都不能有未捕获异常或静态资源 404（CSS/高亮主题丢了页面照样渲染）
    expect(asset404, `静态资源 404：${asset404.join(', ')}`).toEqual([]);
    expect(pageErrors, `页面有未捕获错误：${pageErrors.join(' / ')}`).toEqual([]);
  });
});
