import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// 编辑器工具条的窄屏形态 + Shift+Enter 的单行换行。
//
// 【为什么要 E2E】这两件事都**只在真浏览器里才成立**：
//   · 窄屏「只留三件核心动作」是**样式表**做的（@media + data-more，见
//     `_markdown-editor.scss` 的窄屏段）。写错一个选择器、或者把那段排到
//     `.md-toolbar__group` 之前，症状是「手机上照旧一屏按钮」而 React 侧
//     一点都不报错 —— 单测看不见，桌面那一遍也看不见（那条媒体查询不生效）。
//   · 「一行放得下 / 不溢出视口」是排版事实，只有真视口量得出来。
//   · Shift+Enter 走的是 CM6 的**键位表链**（我们的绑定必须排在 defaultKeymap
//     之前）。绑错位置的表现是「Shift+Enter 与 Enter 一模一样」—— 不报错、
//     不写日志，只有真敲一下才知道。落点与多选区那部分已由
//     tests/unit/md-editor-commands.test.ts 钉住，这里钉的是**按键真的走到它**。
//
// 【断言正文一律经预览】与 editor.spec / editor-upload.spec 同一条纪律：读
// `.md-editor__preview-body` 里的成品，不读 `.cm-content` 的 innerText。
// 单行换行这件事尤其如此 —— 源文编辑器里「看着几行」是它自己的排版，**成品**里
// 单 \n 出 <br>、\n\n 出两段，那才是用户看到的东西。
//
// 【视口自己钉死】用例不按 isMobile 分支，而是 setViewportSize —— 断点属于视口
// 而不属于设备，两个 project 跑的是同一件事。文件因此登记在 playwright.config.ts
// 的 RESPONSIVE_SPECS 里（mobile 那一遍是主场景，desktop 那一遍验「宽屏没被
// 顺手改窄」）。

const BLOG_EDITOR = '#editor';
const CLIP_EDITOR = '#clipboard-editor';

/** 断点（767px）两侧的代表值：手机三档 + 桌面。 */
const NARROW_WIDTHS = [320, 360, 390];
const DESKTOP_WIDTH = 1280;

/** 1x1 透明 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 窄屏默认留在首行的四颗（三件核心动作 + 那颗开关）。 */
const CORE_LABELS = ['表情', '上传图片', '插入引用', '更多工具'];
/** 收在「更多工具」里的（含单独藏起来的「表格」）。 */
const HIDDEN_LABELS = ['标题', '粗体', '斜体', '链接', '任务列表', '分隔线', '表格', '撤销', '导出'];

interface RowGeometry {
  /** 参与布局的按钮（`display: none` 的分组里的不算）。 */
  labels: (string | null)[];
  /** 每条不同的顶边（取整）—— 只有一条 = 同一行。 */
  tops: number[];
  /** 每颗按钮的高度（触摸面积）。 */
  heights: number[];
  /** 越出工具条内容区右缘的按钮（说明被裁掉或被挤出去）。 */
  overflowRight: (string | null)[];
  /** 工具条自身的横向溢出（>0 = 里面出现了横向滚动）。 */
  scrollOverflow: number;
}

/**
 * 量一行工具条的几何。
 *
 * 【为什么用 offsetParent 过滤】`display: none` 的元素 `offsetParent` 是 null，
 * 而窄屏收起的那些分组正是这样被藏起来的 —— 于是「参与布局的按钮」就是用户
 * 真正看得见的那几颗，不必自己再判一遍断点。`getBoundingClientRect()` 对隐藏
 * 元素返回全 0，直接用会把它们算成「都在左上角那一行」，反而看不出问题。
 */
async function measureRow(toolbar: Locator): Promise<RowGeometry> {
  return toolbar.evaluate((el) => {
    const btns = Array.from(el.querySelectorAll<HTMLElement>('.md-toolbar__btn')).filter(
      (b) => b.offsetParent !== null
    );
    const box = el.getBoundingClientRect();
    const contentRight = box.right - parseFloat(getComputedStyle(el).paddingRight);
    return {
      labels: btns.map((b) => b.getAttribute('aria-label')),
      tops: [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)))],
      heights: btns.map((b) => b.getBoundingClientRect().height),
      overflowRight: btns
        .filter((b) => b.getBoundingClientRect().right > contentRight + 1)
        .map((b) => b.getAttribute('aria-label')),
      scrollOverflow: el.scrollWidth - el.clientWidth,
    };
  });
}

/**
 * CM6 认的 `Mod-` 是哪个 —— 照它自己的判据算。
 *
 * 【为什么不能写死 Control】CM6 把 `Mod-b` 解析成「平台的常用修饰键」，判据是它
 * 启动时算好的 `browser.mac`（iOS 判据 || /Mac/.test(navigator.platform)）。而 e2e 的
 * mobile project 用 iPhone 13 的 UA —— CM6 于是**认为自己跑在 iOS 上**、`Mod` = Cmd；
 * 可 `navigator.platform` 仍是 Win32（Playwright 不覆盖它）。两个信号相矛盾，发 Ctrl
 * 会**什么都不发生**，看起来和「快捷键压根没绑」一模一样。真机没有这个错位，这是
 * 模拟环境的产物，所以按 CM6 的规则镜像一份（editor.spec.ts 里有同名的一份）。
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

/** 切到预览，读整篇渲染出来的成品。 */
async function showPreview(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '预览', exact: true }).click();
  return page.locator(`${editor} .md-editor__preview-body`);
}

/**
 * 把工具条滚到视口顶部偏下、**避开固定顶栏**（62px）的位置。
 *
 * 【为什么需要】编辑区在整页里很靠下（标题 / 分类 / 摘要几个字段之后），320px 上
 * 工具条的顶边落在 ~1190px。Playwright 的 `click()` 会自动滚动，但那只会把目标
 * **勉强**露出来（常常贴在视口底边）—— 于是「往下展开」的浮层（表情 / 标题 / 导出）
 * 整个落在视口外，而命中测试（`elementFromPoint`）对视口外的点返回 null，
 * 会被误判成「点不到」。所以先自己滚一次：让工具条顶边落在顶栏之下、又留足
 * 向下展开的空间。截图同理 —— 不滚的话拍到的是编辑区下半截与页脚。
 */
async function scrollToolbarClear(page: Page, editor: string) {
  await page.locator(`${editor} .md-toolbar`).evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 90));
  });
  await page.waitForTimeout(120);
}

/** 打开表情面板，返回那个浮层。 */
async function openEmoji(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '表情', exact: true }).click();
  const menu = page.locator(`${editor} .md-toolbar__menu--emoji`);
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * 断言浮层整个落在编辑器的裁剪框内。
 *
 * `.md-editor` 是那个 `overflow: hidden` 的祖先 —— 浮层越出它就**被裁掉且点不到**，
 * 而它的 `boundingBox` 仍在视口里，所以只断视口会漏。
 */
async function assertWithinEditor(page: Page, editor: string, menu: Locator) {
  const ed = await page.locator(editor).boundingBox();
  const box = await menu.boundingBox();
  expect(box!.x, '浮层越过了编辑器左缘').toBeGreaterThanOrEqual(ed!.x - 0.5);
  expect(
    box!.x + box!.width,
    '浮层越过了编辑器右缘（会被 overflow: hidden 裁掉且点不到）'
  ).toBeLessThanOrEqual(ed!.x + ed!.width + 0.5);
  expect(box!.y, '浮层越过了编辑器上缘').toBeGreaterThanOrEqual(ed!.y - 0.5);
  expect(
    box!.y + box!.height,
    '浮层越过了编辑器下缘（会被 overflow: hidden 裁掉且点不到）'
  ).toBeLessThanOrEqual(ed!.y + ed!.height + 0.5);
}

/** 在编辑区里打字（先点一下把焦点放进去）。 */
async function typeInEditor(page: Page, editor: string, text: string) {
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.type(text);
}

/** 回编辑态并把光标**确定地**放到文末（点击落点是不定的，光标位置对这几条用例是有意义的）。 */
async function backToEditAtEnd(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press(`${await modKey(page)}+End`);
}

/** 某一段成品里的**视觉行数**（<br> 在 innerText 里就是换行）。 */
async function visualLines(node: Locator): Promise<number> {
  return node.evaluate((el) => (el as HTMLElement).innerText.split('\n').length);
}

function toolbarOf(page: Page, editor: string) {
  return page.locator(`${editor} .md-toolbar`);
}

/**
 * 某个元素正中心**真的点得到吗** —— 命中测试。
 *
 * 【为什么不能只断 `toBeVisible()` / `boundingBox`】`toBeVisible` 只看
 * `display` / `visibility` / 尺寸，**看不出被祖先 `overflow: hidden` 裁掉**：被裁的
 * 元素照样有非零尺寸、照样落在视口里，只是它的那个点在页面上被别的元素盖住（或落到
 * 裁剪框外）。`elementFromPoint` 走的是浏览器真正的命中测试，只有它认得出。
 * 判「命中」时把「点在自己身上 / 自己的子节点上 / 自己的祖先上」都算通过 ——
 * 按钮里的 `<svg>` / `<path>` 会抢到命中目标。
 */
async function hittable(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  });
}

/** 面板里每一颗按 aria-label 列出的**点不到**的条目（空数组 = 全都能点）。 */
async function deadItems(menu: Locator): Promise<string[]> {
  return menu.evaluate((el) => {
    const dead: string[] = [];
    el.querySelectorAll<HTMLElement>('button').forEach((it) => {
      const b = it.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit || !(it === hit || it.contains(hit))) {
        dead.push(it.getAttribute('aria-label') ?? it.textContent ?? '?');
      }
    });
    return dead;
  });
}

test.describe('编辑器工具条：窄屏只留三件事', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  test('320 / 360 / 390 三档窄屏：工具条固定一行、只剩核心动作 + 「更多工具」', async ({
    page,
  }) => {
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    await expect(toolbar).toBeVisible();

    for (const width of NARROW_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });

      // ① 核心动作在、其余不在（`toBeHidden` 认的就是 display:none）
      for (const name of CORE_LABELS) {
        await expect(
          toolbar.getByRole('button', { name, exact: true }),
          `${width}px 下「${name}」应当还在首行`
        ).toBeVisible();
      }
      for (const name of HIDDEN_LABELS) {
        await expect(
          toolbar.getByRole('button', { name, exact: true }),
          `${width}px 下「${name}」应当收进「更多工具」`
        ).toBeHidden();
      }

      const geo = await measureRow(toolbar);
      // ② 真的一行 —— 不是「看着差不多」：所有可见按钮的顶边只有一条
      expect(geo.tops, `${width}px 下工具条折成了 ${geo.tops.length} 行`).toHaveLength(1);
      expect(geo.labels.slice().sort()).toEqual(CORE_LABELS.slice().sort());
      // ③ 不溢出：没有按钮越过内容区右缘，工具条自身也不出现横向滚动
      expect(geo.overflowRight, `${width}px 下有按钮越过工具条右缘`).toEqual([]);
      expect(geo.scrollOverflow, `${width}px 下工具条出现了横向滚动`).toBeLessThanOrEqual(1);
      // ④ 触摸面积：28px 是鼠标尺寸，手指点不准（样式表里定的 40px）
      expect(
        Math.min(...geo.heights),
        `${width}px 下按钮只有 ${Math.min(...geo.heights)}px 高`
      ).toBeGreaterThanOrEqual(36);
    }
  });

  test('宽屏：工具条保持原样 —— 全部按钮都在，那颗「更多工具」整个不显示', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    await expect(toolbar).toBeVisible();

    for (const name of [...CORE_LABELS.slice(0, 3), ...HIDDEN_LABELS]) {
      await expect(
        toolbar.getByRole('button', { name, exact: true }),
        `宽屏下「${name}」不该被藏起来`
      ).toBeVisible();
    }
    await expect(toolbar.getByRole('button', { name: '更多工具', exact: true })).toBeHidden();

    // 宽屏只少「更多工具」那一颗（它是 display:none），别的**一颗都不许少**
    const total = await toolbar.locator('.md-toolbar__btn').count();
    const geo = await measureRow(toolbar);
    expect(geo.labels, '宽屏不该收起任何分组').toHaveLength(total - 1);
    // 尺寸也照旧（28px 那一档）：宽屏不该被顺手放大
    expect(Math.max(...geo.heights), '宽屏按钮被放大了').toBeLessThanOrEqual(30);
  });

  test('「更多工具」：展开后格式 / 菜单 / 导出都可达，再点一下收起（开关不挪窝）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    const more = toolbar.getByRole('button', { name: '更多工具', exact: true });

    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    // 先写点字，等下要验「展开后点的格式按钮真的作用在正文上」
    await typeInEditor(page, BLOG_EDITOR, '小标题');

    const before = await more.boundingBox();
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    // ① 展开后次要按钮全回来
    for (const name of HIDDEN_LABELS) {
      await expect(
        toolbar.getByRole('button', { name, exact: true }),
        `展开后「${name}」仍不可见`
      ).toBeVisible();
    }
    // ② 内联展开（不是浮层）：没有任何东西越出工具条，也没有横向滚动
    const expanded = await measureRow(toolbar);
    expect(expanded.overflowRight).toEqual([]);
    expect(expanded.scrollOverflow).toBeLessThanOrEqual(1);
    // ③ 开关自己不挪窝 —— 展开前后它都在首行第三格（挪了就会点错）
    const after = await more.boundingBox();
    expect(Math.abs(after!.x - before!.x), '「更多工具」在展开时移动了').toBeLessThanOrEqual(1);
    expect(Math.abs(after!.y - before!.y), '「更多工具」在展开时移动了').toBeLessThanOrEqual(1);

    // ④ 格式菜单：真选一项，真作用在正文上
    const mod = await modKey(page);
    await page.locator(`${BLOG_EDITOR} .cm-content`).click();
    await page.keyboard.press(`${mod}+a`);
    await toolbar.getByRole('button', { name: '标题', exact: true }).click();
    const menu = toolbar.locator('.md-toolbar__menu');
    await menu.getByRole('menuitem', { name: '标题 2' }).click();
    await expect(menu).toHaveCount(0);

    // ⑤ 导出菜单：两项都在，且整个浮层留在视口内（窄屏最容易把它顶出去）
    await toolbar.getByRole('button', { name: '导出', exact: true }).click();
    const exportMenu = toolbar.locator('.md-toolbar__menu');
    await expect(exportMenu.getByRole('menuitem', { name: '导出 HTML' })).toBeVisible();
    await expect(exportMenu.getByRole('menuitem', { name: '打印 / 存为 PDF' })).toBeVisible();
    const menuBox = await exportMenu.boundingBox();
    expect(menuBox!.x, '导出菜单越过了视口左缘').toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width, '导出菜单越过了视口右缘').toBeLessThanOrEqual(391);
    await page.keyboard.press('Escape');
    await expect(exportMenu).toHaveCount(0);

    // ⑥ 收起：回到那四颗，仍是一行；标题也真的落进了正文
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(toolbar.getByRole('button', { name: '粗体', exact: true })).toBeHidden();
    const collapsed = await measureRow(toolbar);
    expect(collapsed.tops).toHaveLength(1);
    expect(collapsed.labels.slice().sort()).toEqual(CORE_LABELS.slice().sort());

    const preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('h2')).toHaveText('小标题');
  });
});

test.describe('编辑器工具条：核心入口（博客 / 云剪贴板）', () => {
  for (const { name, url, editor } of [
    { name: '博客', url: '/blog/upload', editor: BLOG_EDITOR },
    { name: '云剪贴板', url: '/clipboard/upload', editor: CLIP_EDITOR },
  ] as const) {
    test(`${name}（窄屏）：表情 / 上传图片 / 插入引用三件都真的可达`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.core.username);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      const toolbar = toolbarOf(page, editor);
      await expect(toolbar).toBeVisible();
      // 工具条在整页里很靠下：先滚到视口上部，否则往下展开的面板会落在视口外，
      // 命中测试会把它误判成「点不到」。
      await scrollToolbarClear(page, editor);

      // ① 表情：面板打开 → 挑一个 → 落进正文
      const emojiMenu = await openEmoji(page, editor);
      // 面板整个落在**编辑器的裁剪框**里（`.md-editor` 是那个 `overflow: hidden`
      // 的祖先）—— 只断「在视口里」是不够的，被祖先裁掉的照样在视口里。
      await assertWithinEditor(page, editor, emojiMenu);
      // 每一颗都做命中测试：没被裁、也没被别的东西盖住
      expect(await deadItems(emojiMenu), '有表情点不到（被祖先裁掉或被盖住）').toEqual([]);
      await emojiMenu.getByRole('menuitem', { name: '插入表情 😀' }).click();
      await expect(emojiMenu).toHaveCount(0);

      // ② 上传图片：点它真的抬起文件选择框（onPickFiles 去点那颗隐藏 input），
      //    选中的文件真的走完整条链路上传并插进正文
      const chooser = page.waitForEvent('filechooser');
      await toolbar.getByRole('button', { name: '上传图片', exact: true }).click();
      await (await chooser).setFiles({
        name: 'e2e-mobile.png',
        mimeType: 'image/png',
        buffer: PNG_1X1,
      });

      // ③ 插入引用：资源面板打开，且窄屏下装得进视口（它自己带 100vw-40px 的宽度）
      await toolbar.getByRole('button', { name: '插入引用', exact: true }).click();
      const panel = page.locator('.md-res-modal');
      await expect(panel).toBeVisible();
      const panelBox = await panel.boundingBox();
      expect(panelBox!.x, '资源面板越过了视口左缘').toBeGreaterThanOrEqual(0);
      expect(panelBox!.x + panelBox!.width, '资源面板越过了视口右缘').toBeLessThanOrEqual(391);
      await panel.getByRole('button', { name: '关闭' }).click();
      await expect(panel).toHaveCount(0);

      // ④ 三件事都作用在正文上：表情是文本、图片是图
      const preview = await showPreview(page, editor);
      await expect(preview).toContainText('😀');
      await expect(preview.locator('img[src^="/api/images/"]')).toHaveCount(1);
      await expect(page.locator('#toast-container .toast--error')).toHaveCount(0);
    });
  }

  // 最窄的一档（320）单独一遍：浮层宽度必须跟着**编辑器实际可用宽度**收。
  // 320 上博客与剪贴板的檐沟不同、编辑区宽度也不同（实测 208 / 232），
  // 「视口减一个常量」的写法必然在其中一条上出错 —— 所以两条链路都要量。
  for (const { name, url, editor } of [
    { name: '博客', url: '/blog/upload', editor: BLOG_EDITOR },
    { name: '云剪贴板', url: '/clipboard/upload', editor: CLIP_EDITOR },
  ] as const) {
    test(`${name}（320）：浮层收进编辑区；最右一列与最后一个表情都点得到`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.core.username);
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto(url);
      const toolbar = toolbarOf(page, editor);
      await expect(toolbar).toBeVisible();
      await scrollToolbarClear(page, editor);

      // ① 三颗核心入口要**点得到**（不是「visible」—— 被祖先 overflow 裁掉的元素
      //    也满足 visible）
      for (const label of CORE_LABELS.slice(0, 3)) {
        expect(
          await hittable(toolbar.getByRole('button', { name: label, exact: true })),
          `320px 下「${label}」点不到`
        ).toBe(true);
      }

      // ② 表情面板：整个落在编辑器裁剪框里，且每一颗都命中（最右一列最容易丢）
      const menu = await openEmoji(page, editor);
      await assertWithinEditor(page, editor, menu);
      expect(await deadItems(menu), '320px 下有表情点不到（被裁或被盖）').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // ③ 标题 / 导出两个菜单也在展开区里，最容易被顶出编辑区
      await toolbar.getByRole('button', { name: '更多工具', exact: true }).click();
      await scrollToolbarClear(page, editor);
      const headingMenu = toolbar.locator('.md-toolbar__menu:not(.md-toolbar__menu--emoji)');
      await toolbar.getByRole('button', { name: '标题', exact: true }).click();
      await expect(headingMenu).toBeVisible();
      await assertWithinEditor(page, editor, headingMenu);
      await expect(headingMenu.getByRole('menuitem', { name: '标题 2' })).toBeVisible();
      expect(await deadItems(headingMenu), '标题菜单里有点不到的项').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(headingMenu).toHaveCount(0);

      const exportMenu = toolbar.locator('.md-toolbar__menu--right');
      const exportBtn = toolbar.getByRole('button', { name: '导出', exact: true });
      expect(await hittable(exportBtn), '320px 下「导出」点不到').toBe(true);
      await exportBtn.click();
      await expect(exportMenu).toBeVisible();
      await assertWithinEditor(page, editor, exportMenu);
      expect(await deadItems(exportMenu), '导出菜单里有点不到的项').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(exportMenu).toHaveCount(0);

      // ④ 真点**最后一个**表情（最后一行的最右一格 —— 正是最容易够不到的那颗），
      //    并确认它落进了正文。Playwright 的 click 自带命中判定，够不到会直接超时。
      const lastMenu = await openEmoji(page, editor);
      await lastMenu.locator('.md-toolbar__emoji').last().click();
      await expect(lastMenu).toHaveCount(0);
      const preview = await showPreview(page, editor);
      await expect(preview, '最后一个表情应当落进正文').toContainText('🍜');
    });
  }
});

test.describe('Shift+Enter：单行换行', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto('/blog/upload');
    await expect(toolbarOf(page, BLOG_EDITOR)).toBeVisible();
  });

  test('单个 Shift+Enter 只换一行（同一段里一个 <br>），两个才是两段', async ({ page }) => {
    await typeInEditor(page, BLOG_EDITOR, '第一行');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');

    let preview = await showPreview(page, BLOG_EDITOR);
    // 同一个 <p> 里一行靠 <br> 断开 —— 这就是「单行换行」在成品里的样子
    await expect(preview.locator('p')).toHaveCount(1);
    await expect(preview.locator('br')).toHaveCount(1);
    // 判「是不是真只在同一段里换了一行」要看**视觉行数**：innerText 里 <br> 就是换行。
    // 拿它去断文本的话会被 Playwright 的空白归一化吃掉这个差别。
    expect(await visualLines(preview.locator('p')), '单 \\n 在成品里应当只有两行').toBe(2);
    // 标记本身不许出现在正文里（不插 <br>、不插行尾两空格）
    await expect(preview).not.toContainText('<br>');

    // 回到编辑态、光标放到文末，再敲两个 Shift+Enter：那才是分段
    await backToEditAtEnd(page, BLOG_EDITOR);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第三段');

    preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('p'), '两个 \\n 应当是两段').toHaveCount(2);
    await expect(preview.locator('br')).toHaveCount(1);
    expect(await visualLines(preview.locator('p').nth(1))).toBe(1);
    await expect(preview.locator('p').nth(1)).toHaveText('第三段');
  });

  test('列表里 Shift+Enter 只换行不新建下一项', async ({ page }) => {
    await typeInEditor(page, BLOG_EDITOR, '- 项目一');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('续行');

    const preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('ul'), 'Shift+Enter 之后应当还是一个列表').toHaveCount(1);
    await expect(preview.locator('li'), 'Shift+Enter 不该新建下一项').toHaveCount(1);
    await expect(preview.locator('li br')).toHaveCount(1);
    // 反向对照：普通 Enter **在这里**也是只换行（CM6 对「续行」这种不顶格的线
    // 不补标记），所以上面那条不是「Shift+Enter 与 Enter 没差别」的证据 ——
    // 真正的对照在下面那条用例（在**列表项那一行**上按 Enter）。
  });

  test('列表项那一行上：普通 Enter 仍然新建下一项（Shift+Enter 只是绕开它）', async ({
    page,
  }) => {
    await typeInEditor(page, BLOG_EDITOR, '- 项目一');
    await page.keyboard.press('Enter');
    await page.keyboard.type('项目二');

    const preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('ul')).toHaveCount(1);
    await expect(preview.locator('li'), '普通 Enter 应当续写出第二项').toHaveCount(2);
    await expect(preview.locator('li').nth(1)).toHaveText('项目二');
  });

  test('Shift+Enter 之后接着打字落点正确，且这一步撤得掉', async ({ page }) => {
    await typeInEditor(page, BLOG_EDITOR, 'aa');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('bb');
    await expect(page.locator(`${BLOG_EDITOR} .md-editor__count`)).toHaveText('5 字');

    let preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('br')).toHaveCount(1);
    await expect(preview).toContainText('bb');

    // 撤销：那个换行得能撤掉（撤不掉的话用户只能删掉整行重打）
    const mod = await modKey(page);
    await backToEditAtEnd(page, BLOG_EDITOR);
    await page.keyboard.press(`${mod}+z`);
    preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('br'), '撤销之后那个换行应当没了').toHaveCount(0);
  });
});
