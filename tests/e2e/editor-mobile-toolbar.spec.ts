import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// 编辑器工具条的窄屏形态 + Shift+Enter 的单行换行。
//
// 【为什么要 E2E】这两件事都**只在真浏览器里才成立**：
//   · 窄屏把带文字的入口收成 40px 图标钮、把历史组藏进「更多」菜单，是
//     **样式表**做的（@media，见 `_markdown-editor.scss` 的窄屏段）。写错一个
//     选择器、或者把那段排到 `.md-toolbar__group` 之前，症状是「手机上照旧一屏
//     按钮」而 React 侧一点都不报错 —— 单测看不见，桌面那一遍也看不见。
//   · 「一行放得下 / 不溢出视口」是排版事实，只有真视口量得出来。
//   · Shift+Enter 走的是 CM6 的**键位表链**（我们的绑定必须排在 defaultKeymap
//     之前）。绑错位置的表现是「Shift+Enter 与 Enter 一模一样」—— 不报错、
//     不写日志，只有真敲一下才知道。落点与多选区那部分已由
//     tests/unit/md-editor-commands.test.ts 钉住，这里钉的是**按键真的走到它**。
//
// 【断言正文一律经预览】与 editor.spec / editor-upload.spec 同一条纪律：读
// `.md-editor__preview-body` 里的成品，不读 `.cm-content` 的 innerText。
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

/** 窄屏首行的五个主入口（历史组由样式表藏掉，撤销/重做在「更多」里）。 */
const CORE_LABELS = ['插入', '组件', '上传图片', '插入引用', '更多'];
/** 窄屏被样式表藏起来的按钮（仍可从「更多」菜单触发同一条命令）。 */
const HIDDEN_LABELS = ['撤销', '重做'];

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
 * 而窄屏藏起来的历史组正是这样被藏起来的 —— 于是「参与布局的按钮」就是用户
 * 真正看得见的那几颗。
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
 * CM6 认的 `Mod-` 是哪个 —— 照它自己的判据算（同 editor.spec.ts）。
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
 * 把工具条滚到视口顶部偏下、避开固定顶栏（62px），给向下展开的浮层留空间。
 */
async function scrollToolbarClear(page: Page, editor: string) {
  await page.locator(`${editor} .md-toolbar`).evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 90));
  });
  await page.waitForTimeout(120);
}

/** 打开 Insert 菜单。 */
async function openInsert(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '插入', exact: true }).click();
  const menu = page.locator(`${editor} .md-toolbar__menu--insert`);
  await expect(menu).toBeVisible();
  return menu;
}

/** 在 Insert 菜单里打开表情网格，返回网格。 */
async function openEmoji(page: Page, editor: string) {
  const menu = await openInsert(page, editor);
  await menu.getByRole('button', { name: '展开表情', exact: true }).click();
  const grid = menu.locator('.md-toolbar__emoji-grid');
  await expect(grid).toBeVisible();
  return grid;
}

/** 打开「更多」菜单。 */
async function openMore(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '更多', exact: true }).click();
  const menu = page.locator(`${editor} .md-toolbar__menu--right`);
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

/** 回编辑态并把光标确定地放到文末。 */
async function backToEditAtEnd(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press(`${await modKey(page)}+End`);
}

/** 某一段成品里的**视觉行数**（<br> 在 innerText 里就是换行）。 */
async function visualLines(node: Locator): Promise<number> {
  return node.evaluate((el) => (el as HTMLElement).innerText.split('\n').length);
}

/** 工具条上那个字数（正文长度）。 */
async function charCount(page: Page): Promise<number> {
  const text = await page.locator(`${BLOG_EDITOR} .md-editor__count`).innerText();
  return Number.parseInt(text, 10);
}

/**
 * 光标此刻在不在编辑区的可见范围内，以及视图滚到了哪（同 editor.spec 的口径）。
 */
async function caretView(page: Page, editor: string) {
  return page.evaluate((sel) => {
    const scroller = document.querySelector(sel + ' .cm-scroller') as HTMLElement;
    const box = scroller.getBoundingClientRect();
    const selection = window.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    let top = rect?.top ?? 0;
    let bottom = rect?.bottom ?? 0;
    if (!rect || (!rect.height && !rect.width)) {
      const node = range?.startContainer ?? null;
      const el =
        node && node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as HTMLElement | null);
      const line = el?.closest('.cm-line')?.getBoundingClientRect();
      if (line) {
        top = line.top;
        bottom = line.bottom;
      }
    }
    return {
      scrollTop: scroller.scrollTop,
      caretBottom: bottom,
      boxBottom: box.bottom,
      visible: bottom > box.top && top < box.bottom,
    };
  }, editor);
}

function toolbarOf(page: Page, editor: string) {
  return page.locator(`${editor} .md-toolbar`);
}

/** 某个元素正中心真的点得到吗 —— 命中测试。 */
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
    const box = el.getBoundingClientRect();
    el.querySelectorAll<HTMLElement>('button').forEach((it) => {
      const b = it.getBoundingClientRect();
      // 菜单内部可滚动：滚出可视区的条目**不算点不到**（真实用户会先滚）。
      // 只检查此刻落在菜单可视框内的那部分 —— 它们才该“看得见就点得到”。
      const visible =
        b.width > 0 &&
        b.height > 0 &&
        b.top >= box.top - 1 &&
        b.bottom <= box.bottom + 1 &&
        b.left >= box.left - 1 &&
        b.right <= box.right + 1;
      if (!visible) return;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit || !(it === hit || it.contains(hit))) {
        dead.push(it.getAttribute('aria-label') ?? it.textContent ?? '?');
      }
    });
    return dead;
  });
}

test.describe('编辑器工具条：窄屏五个主入口 + 「更多」', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
  });

  test('320 / 360 / 390 三档窄屏：工具条固定一行、主入口 + 「更多」', async ({ page }) => {
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    await expect(toolbar).toBeVisible();

    for (const width of NARROW_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });

      // ① 主入口在、历史组由样式表藏起来
      for (const name of CORE_LABELS) {
        await expect(
          toolbar.getByRole('button', { name, exact: true }),
          `${width}px 下「${name}」应当还在首行`
        ).toBeVisible();
      }
      for (const name of HIDDEN_LABELS) {
        await expect(
          toolbar.getByRole('button', { name, exact: true }),
          `${width}px 下「${name}」应当收进「更多」`
        ).toBeHidden();
      }

      const geo = await measureRow(toolbar);
      // ② 真的一行
      expect(geo.tops, `${width}px 下工具条折成了 ${geo.tops.length} 行`).toHaveLength(1);
      expect(geo.labels.slice().sort()).toEqual(CORE_LABELS.slice().sort());
      // ③ 不溢出
      expect(geo.overflowRight, `${width}px 下有按钮越过工具条右缘`).toEqual([]);
      expect(geo.scrollOverflow, `${width}px 下工具条出现了横向滚动`).toBeLessThanOrEqual(1);
      // ④ 触摸面积
      expect(
        Math.min(...geo.heights),
        `${width}px 下按钮只有 ${Math.min(...geo.heights)}px 高`
      ).toBeGreaterThanOrEqual(36);
    }
  });

  test('宽屏：主入口带文字、历史组在、「更多」仍在', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    await expect(toolbar).toBeVisible();

    for (const name of [...CORE_LABELS, ...HIDDEN_LABELS]) {
      await expect(
        toolbar.getByRole('button', { name, exact: true }),
        `宽屏下「${name}」不该被藏起来`
      ).toBeVisible();
    }

    // 宽屏不收起任何按钮：所有 .md-toolbar__btn 都参与布局
    const total = await toolbar.locator('.md-toolbar__btn').count();
    const geo = await measureRow(toolbar);
    expect(geo.labels, '宽屏不该收起任何按钮').toHaveLength(total);
    // 尺寸是鼠标那一档（带文字的主入口高度仍是 28）
    expect(Math.max(...geo.heights), '宽屏按钮被放大了').toBeLessThanOrEqual(30);
  });

  test('「更多」：撤销 / 导出 / 打印 / 格式化都在菜单里，Esc 关闭', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/blog/upload');
    const toolbar = toolbarOf(page, BLOG_EDITOR);
    await scrollToolbarClear(page, BLOG_EDITOR);

    await typeInEditor(page, BLOG_EDITOR, '小标题');

    const menu = await openMore(page, BLOG_EDITOR);
    await expect(menu.getByRole('menuitem', { name: '撤销', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '重做', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '导出 HTML', exact: true })).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: '打印 / 存为 PDF', exact: true })
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: /^格式化/ })
    ).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.x, '「更多」菜单越过了视口左缘').toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width, '「更多」菜单越过了视口右缘').toBeLessThanOrEqual(391);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Insert 菜单：标题选项真的作用在正文上
    const mod = await modKey(page);
    await page.locator(`${BLOG_EDITOR} .cm-content`).click();
    await page.keyboard.press(`${mod}+a`);
    const insert = await openInsert(page, BLOG_EDITOR);
    await insert.getByRole('menuitem', { name: '标题 2', exact: true }).click();
    await expect(insert).toHaveCount(0);

    const preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('h2')).toHaveText('小标题');
  });
});

test.describe('编辑器工具条：核心入口（博客 / 云剪贴板）', () => {
  for (const { name, url, editor } of [
    { name: '博客', url: '/blog/upload', editor: BLOG_EDITOR },
    { name: '云剪贴板', url: '/clipboard/upload', editor: CLIP_EDITOR },
  ] as const) {
    test(`${name}（窄屏）：插入 / 组件 / 上传图片 / 插入引用都真的可达`, async ({ page }) => {
      await loginViaApi(page, SEED_USERS.core.username);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      const toolbar = toolbarOf(page, editor);
      await expect(toolbar).toBeVisible();
      await scrollToolbarClear(page, editor);

      // ① 表情现在收在 Insert 里：菜单 → 展开表情 → 挑一个 → 落进正文
      const emojiGrid = await openEmoji(page, editor);
      await assertWithinEditor(page, editor, emojiGrid);
      expect(await deadItems(emojiGrid), '有表情点不到（被祖先裁掉或被盖住）').toEqual([]);
      const emojiTexts = await emojiGrid.getByRole('menuitem').allTextContents();
      expect(emojiTexts).not.toContain('\uFE0F');
      for (const emoji of ['✌️', '❤️', '⚠️', '☀️']) {
        expect(emojiTexts).toContain(emoji);
      }
      await emojiGrid.getByRole('menuitem', { name: '插入表情 ❤️', exact: true }).click();
      await expect(page.locator(`${editor} .md-toolbar__menu--insert`)).toHaveCount(0);

      // ② 上传图片：点它真的抬起文件选择框，选中的文件真的走完整条链路上传并插进正文
      const chooser = page.waitForEvent('filechooser');
      await toolbar.getByRole('button', { name: '上传图片', exact: true }).click();
      await (await chooser).setFiles({
        name: 'e2e-mobile.png',
        mimeType: 'image/png',
        buffer: PNG_1X1,
      });

      // ③ 插入引用：资源面板打开，且窄屏下装得进视口
      await toolbar.getByRole('button', { name: '插入引用', exact: true }).click();
      const panel = page.locator('.md-res-modal');
      await expect(panel).toBeVisible();
      const panelBox = await panel.boundingBox();
      expect(panelBox!.x, '资源面板越过了视口左缘').toBeGreaterThanOrEqual(0);
      expect(panelBox!.x + panelBox!.width, '资源面板越过了视口右缘').toBeLessThanOrEqual(391);
      await panel.getByRole('button', { name: '关闭' }).click();
      await expect(panel).toHaveCount(0);

      // ④ 三件事都作用在正文上
      const preview = await showPreview(page, editor);
      await expect(preview).toContainText('❤️');
      await expect(preview.locator('img[src^="/api/images/"]')).toHaveCount(1);
      await expect(page.locator('#toast-container .toast--error')).toHaveCount(0);
    });
  }

  // 最窄的一档（320）单独一遍：浮层宽度必须跟着**编辑器实际可用宽度**收。
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

      // ① 五个主入口都要**点得到**（不是「visible」—— 被祖先 overflow 裁掉的元素
      //    也满足 visible）
      for (const label of CORE_LABELS) {
        expect(
          await hittable(toolbar.getByRole('button', { name: label, exact: true })),
          `320px 下「${label}」点不到`
        ).toBe(true);
      }

      // ② Insert 菜单整个落在编辑器裁剪框里，每一项都命中
      const insert = await openInsert(page, editor);
      await assertWithinEditor(page, editor, insert);
      expect(await deadItems(insert), '320px 下 Insert 菜单里有点不到的项').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(insert).toHaveCount(0);

      // ③ 「更多」菜单同样在框内
      const more = await openMore(page, editor);
      await assertWithinEditor(page, editor, more);
      expect(await deadItems(more), '「更多」菜单里有点不到的项').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(more).toHaveCount(0);

      // ④ 真点**最后一个**表情（最后一行的最右一格）
      const grid = await openEmoji(page, editor);
      await assertWithinEditor(page, editor, grid);
      expect(await deadItems(grid), '320px 下有表情点不到（被裁或被盖）').toEqual([]);
      await grid.locator('.md-toolbar__emoji').last().click();
      await expect(page.locator(`${editor} .md-toolbar__menu--insert`)).toHaveCount(0);
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
    await expect(preview.locator('p')).toHaveCount(1);
    await expect(preview.locator('br')).toHaveCount(1);
    expect(await visualLines(preview.locator('p')), '单 \\n 在成品里应当只有两行').toBe(2);
    await expect(preview).not.toContainText('<br>');

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

    const mod = await modKey(page);
    await backToEditAtEnd(page, BLOG_EDITOR);
    await page.keyboard.press(`${mod}+z`);
    preview = await showPreview(page, BLOG_EDITOR);
    await expect(preview.locator('br'), '撤销之后那个换行应当没了').toHaveCount(0);
  });

  test('Shift+Enter 在可见区底部：新光标仍在编辑区内，视图跟着滚', async ({ page }) => {
    await page.goto('/blog/upload');
    await page.locator(`${BLOG_EDITOR} .cm-content`).click();
    await page.keyboard.insertText(
      Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行的内容`).join('\n')
    );

    const scroller = page.locator(`${BLOG_EDITOR} .cm-scroller`);
    const metrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      metrics.scrollHeight,
      '文档没有高过编辑区，这条用例就验不到滚动'
    ).toBeGreaterThan(metrics.clientHeight + 300);

    await page.keyboard.press(`${await modKey(page)}+End`);
    const before = await caretView(page, BLOG_EDITOR);
    expect(before.scrollTop, '光标在文末，视图却还停在顶端').toBeGreaterThan(0);
    expect(before.visible, '前置条件不成立：光标本该已经被滚进可见区').toBe(true);

    const countBefore = await charCount(page);
    await page.keyboard.press('Shift+Enter');
    expect(await charCount(page), '这次 Shift+Enter 没有插进一个换行').toBe(countBefore + 1);

    const after = await caretView(page, BLOG_EDITOR);
    expect(after.visible, '按完 Shift+Enter，新光标掉到了编辑区可见范围之外').toBe(true);
    expect(after.scrollTop, '视图没有跟着光标往下滚').toBeGreaterThan(before.scrollTop);
  });
});
