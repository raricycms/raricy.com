import { readFileSync } from 'node:fs';
import { test, expect, type Download, type Page } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

// 编辑器「加固」这几条的**真跑链路**：面板键盘流、对话框焦点锁、Esc→Tab、
// 导出取的是哪一份正文。
//
// 【为什么只有 E2E 说得清】
//   · 「面板里按 Enter 会不会把整张表单提交掉」是**浏览器隐式提交**行为 ——
//     单测里 React 的事件是合成出来的，没有表单的默认动作，永远绿；
//   · 「Tab 会不会走到遮罩后面」问的是**焦点顺序**，只有真浏览器有那个顺序；
//   · 「Esc 再 Tab 能不能走出编辑区」是 CodeMirror 自己实现的（input.ts 里
//     Escape 之后的 2 秒窗口放行 Tab），我们只负责把它说出来 —— 真按一下才知道；
//   · 「敲完最后一个字立刻导出」比的是**导出的那份正文是哪一版**：预览是防抖
//     400ms 的，只有真敲真点才分得出来。

/** 1x1 透明 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 面板本身（页面别处不会有这个类）。 */
function panel(page: Page) {
  return page.locator('.md-res-modal');
}

async function openPanel(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '插入引用', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

/** 数一数**写请求**：这些用例要证的正是「一次都不该有」。 */
function collectWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || r.method() === 'HEAD') return;
    if (r.url().includes('/api/')) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

async function makeClip(page: Page, title: string, content: string): Promise<string> {
  const res = await page.request.post('/api/clipboard', {
    data: { title, content, publicity: true },
  });
  const body = await res.json();
  expect(body.code, `建剪贴板失败：${JSON.stringify(body)}`).toBe(200);
  return body.id as string;
}

async function makeImage(page: Page, filename: string): Promise<string> {
  const res = await page.request.post('/api/images', {
    multipart: { file: { name: filename, mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  const body = await res.json();
  expect(body.code, `上传图片失败：${JSON.stringify(body)}`).toBe(200);
  return body.items[0].id as string;
}

/**
 * 点工具条的「导出」→「导出 HTML」，把下载下来的文件读成文本。
 *
 * `startedAt` 给的话，另外回一个 `elapsedMs` = 从它到**按下那一颗菜单项**的间隔。
 * 读文件、等下载都不算进去 —— 那几段是测试自己的开销，拿来判「防抖跑没跑完」
 * 会把结论说反。
 */
async function exportHtml(
  page: Page,
  editor: string,
  startedAt?: number
): Promise<{ text: string; filename: string; elapsedMs: number }> {
  await page.locator(editor).getByRole('button', { name: '导出', exact: true }).click();
  let clickedAt = 0;
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    // ★ menu 里的条目挂的是 `role="menuitem"`（显式 role 会盖掉 button 那个隐式角色），
    //   所以这里按 menuitem 找 —— 按 button 找会一直等不到，看着像「下载没发生」。
    page
      .locator(editor)
      .getByRole('menuitem', { name: '导出 HTML', exact: true })
      .click()
      .then(() => { clickedAt = Date.now(); }),
  ]);
  return {
    text: await readDownload(download),
    filename: download.suggestedFilename(),
    elapsedMs: startedAt ? clickedAt - startedAt : 0,
  };
}

async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  expect(path, '下载没有落地成本地文件').toBeTruthy();
  return readFileSync(path!, 'utf8');
}

test.describe('资源面板的键盘流', () => {
  test('★ 面板里按 Enter 只插引用，绝不提交表单（博客 / 云剪贴板各一次）★', async ({
    page,
  }) => {
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    const clipTitle = `回车夹-${tag}`;
    const clipBody = `回车正文-${tag}`;
    const clipId = await makeClip(page, clipTitle, clipBody);

    for (const [name, url, editor, titleField] of [
      ['博客新建', '/blog/upload', '#editor', '#title'],
      ['云剪贴板新建', '/clipboard/upload', '#clipboard-editor', '#title'],
    ] as const) {
      const writes = collectWrites(page);
      await page.goto(url);
      await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

      // 让表单**具备可提交的形状**：标题与正文都填上。否则就算真的隐式提交了，
      // 也只会在前端校验那里被拦下 —— 用例变成一句空话。
      await page.fill(titleField, `回车标题-${tag}`);
      if (name === '博客新建') await page.fill('#description', '摘要');
      await page.locator(`${editor} .cm-content`).click();
      await page.keyboard.type('正文');

      await openPanel(page, editor);
      await page.getByRole('tab', { name: '剪贴板', exact: true }).click();
      const search = panel(page).locator('.md-res-search input');
      await search.fill(clipTitle);

      // ★ 就是这一下 ★ 搜索框在 `<form>` 里，`<input type=search>` 里按 Enter 会触发
      // **隐式提交**：浏览器不等你点提交按钮。拦不住的后果按页面不同 ——
      // 博客新建页 = 当场发出去一篇只有标题、正文空白的文章。
      await search.press('Enter');

      // 面板把那一下当成「插入高亮的那条」：面板收起，正文里多一条引用。
      // 判据先取编辑区里的**字面量**（插入确实发生了），再切到只读预览确认这条
      // 引用**展开得出来** —— 只断言「面板关了」在插入失败时同样成立。
      await expect(panel(page), `${name}：Enter 没有插入，面板还开着`).toHaveCount(0);
      await expect(page.locator(`${editor} .cm-content`)).toContainText(`[@${clipId}]`);
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await expect(page.locator(`${editor} .md-editor__preview-body`)).toContainText(clipBody, {
        timeout: 10_000,
      });
      expect(writes, `${name}：面板里按 Enter 触发了写请求`).toEqual([]);
    }
  });

  test('★ 面板里按 Enter 而「没东西可插」时，表单照样不许提交 ★', async ({ page }) => {
    // 【这一条与上一条不是重复】上一条按 Enter 时**真的有东西可插**：插进去的
    // 那一下会把面板卸载掉，输入框连着整个面板一起离开文档 —— 浏览器的隐式提交
    // 这时候已经没有目标了，于是**不拦也看不出问题**（实测：把 preventDefault
    // 去掉，上一条照样绿）。真正的口子在「按了 Enter 但插不进去」：
    // 列表还在加载、搜不到结果、或者一屏全是不可插的私有收藏夹 —— 面板留在原地，
    // 输入框还在表单里，Enter 的默认动作就是**提交整张表单**。
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    await makeClip(page, `空结果夹-${tag}`, `空结果正文-${tag}`);

    for (const [name, url, editor, titleField] of [
      ['博客新建', '/blog/upload', '#editor', '#title'],
      ['云剪贴板新建', '/clipboard/upload', '#clipboard-editor', '#title'],
    ] as const) {
      const writes = collectWrites(page);
      await page.goto(url);
      await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();
      await page.fill(titleField, `空结果标题-${tag}`);
      if (name === '博客新建') await page.fill('#description', '摘要');
      await page.locator(`${editor} .cm-content`).click();
      await page.keyboard.type('正文');

      await openPanel(page, editor);
      await page.getByRole('tab', { name: '剪贴板', exact: true }).click();
      // 有列表、但搜不到 —— 用户最常见的「按了回车什么也没发生」那一档
      await page.locator('.md-res-search input').fill(`搜不到-${tag}-zzz`);
      await expect(panel(page)).toContainText('没有匹配的结果');

      await page.locator('.md-res-search input').press('Enter');

      // 没有条目 → 什么也不该发生：面板留着（用户可以继续改搜索词），
      // 而**写请求一条都不许有**。
      await expect(panel(page), `${name}：空结果时 Enter 把面板关掉了`).toBeVisible();
      await page.waitForTimeout(500); // 留出「提交了但还在飞」的窗口
      expect(writes, `${name}：空结果时按 Enter 触发了表单提交`).toEqual([]);
    }
  });

  test('★ 鼠标点一条也不发写请求（键盘流不是唯一通路）★', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    const clipTitle = `点选夹-${tag}`;
    await makeClip(page, clipTitle, `点选正文-${tag}`);

    const writes = collectWrites(page);
    await page.goto('/blog/upload');
    await openPanel(page, '#editor');
    await page.getByRole('tab', { name: '剪贴板', exact: true }).click();
    await page.locator('.md-res-item:not([disabled])').first().click();
    await expect(panel(page)).toHaveCount(0);
    expect(writes).toEqual([]);
  });
});

test.describe('预览里的按钮', () => {
  test('★ 预览里点代码块的「复制」绝不提交外层表单，也不跳转（博客 / 云剪贴板各一次）★', async ({
    page,
  }) => {
    // 【为什么只有真浏览器说得清】复制按钮是**正文渲染器**（blog-renderer）生成的
    // HTML，而编辑器的只读预览整块挂在博客 / 剪贴板的 <form> 下面。省略 type 的
    // <button> 默认就是 submit —— 「填好必填字段 → 预览里点一下复制代码」于是会
    // 顺手提交整张表单：博客那边当场发出去一篇文章并跳走、剪贴板那边做一次没打算
    // 做的保存。复制本身看起来一切正常（剪贴板写失败也照样显示「已复制」），
    // jsdom / 合成事件里没有表单的默认动作，这一条在单测里永远绿。
    await registerFreshUser(page, { core: true });
    // 给剪贴板写权限：不给的话 `navigator.clipboard.writeText` 会走拒绝分支
    //（我们在 catch 里同样显示「已复制」，所以两条路都对）—— 但「按了没反应」
    // 与「复制成功」在这里必须分得开，才说明这一下真的落到了那个按钮上。
    await page.context().grantPermissions(['clipboard-write']);
    const tag = uniqueTag();

    for (const [name, url, editor, titleField] of [
      ['博客新建', '/blog/upload', '#editor', '#title'],
      ['云剪贴板新建', '/clipboard/upload', '#clipboard-editor', '#title'],
    ] as const) {
      const writes = collectWrites(page);
      await page.goto(url);
      await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

      // ★ 先让表单**具备可提交的形状** ★ 必填项留空的话，就算真的触发了提交也会被
      // 浏览器 / 前端校验拦下，用例变成一句空话（同上面「面板里按 Enter」那两条）。
      await page.fill(titleField, `复制标题-${tag}`);
      await page.locator(`${editor} .cm-content`).click();
      if (name === '博客新建') {
        await page.fill('#description', '复制用的摘要');
        await page.selectOption('#category', { index: 1 });
      }
      await page.keyboard.type('```js\nconst a = 1;\n```');

      // 切到只读预览 —— 复制按钮就在预览里（正文页同款渲染）
      await page.getByRole('button', { name: '预览', exact: true }).click();
      const preview = page.locator(`${editor} .md-editor__preview-body`);
      const copy = preview.locator('.copy-btn');
      await expect(copy).toHaveCount(1);

      // ★ 就是这一下 ★
      await copy.click();

      // 复制这件事本身要发生（按钮切成「已复制」；剪贴板权限在无头浏览器里可能被拒，
      // 那条路径同样会走完成回调 —— 见 enhanceBlogContent 的 catch）
      await expect(copy).toHaveText('已复制');

      // 留出「提交了但还在飞」的窗口，再判两件事：一个写请求都没有、页面还在原地
      await page.waitForTimeout(1000);
      expect(writes, `${name}：点预览里的「复制」触发了写请求`).toEqual([]);
      expect(page.url(), `${name}：点预览里的「复制」把页面带走了`).toContain(url);
      // 正文也还在：跳转 / 重渲染把它洗掉的话，用户丢的是刚写的那一段
      await expect(page.locator(`${editor} .cm-content`)).toContainText('const a = 1;');
    }
  });
});

test.describe('对话框的焦点', () => {
  test('★ Tab 一路走不出对话框，更走不到遮罩后面的提交按钮 ★', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    await makeImage(page, `焦点图-${uniqueTag()}.png`);

    await page.goto('/blog/upload');
    await openPanel(page, '#editor');

    const submit = page.locator('#blogForm button[type="submit"]');
    // 面板是 aria-modal="true" 的对话框：不锁焦点的话 Tab 会一路走到**遮罩后面**
    // 的表单上 —— 焦点跑到看不见的地方，接着按 Enter 点到的可能是「提交」。
    // 走满一圈还多一点（关闭钮 + 5 颗标签 + 搜索框 + 刷新钮 = 8 格）
    for (let i = 1; i <= 12; i += 1) {
      await page.keyboard.press('Tab');
      const inDialog = await page.evaluate(() => {
        const d = document.querySelector('.md-res-modal');
        const a = document.activeElement;
        return !!d && !!a && d.contains(a);
      });
      expect(inDialog, `第 ${i} 次 Tab 之后焦点跑到对话框外面了`).toBe(true);
      await expect(submit, `第 ${i} 次 Tab 之后焦点落到了提交按钮上`).not.toBeFocused();
    }

    // Shift+Tab 往回同样收口
    for (let i = 1; i <= 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      const inDialog = await page.evaluate(() => {
        const d = document.querySelector('.md-res-modal');
        const a = document.activeElement;
        return !!d && !!a && d.contains(a);
      });
      expect(inDialog, `第 ${i} 次 Shift+Tab 之后焦点跑到对话框外面了`).toBe(true);
      await expect(submit).not.toBeFocused();
    }
  });
});

test.describe('编辑区的键盘出口', () => {
  test('Esc 再 Tab 能走出编辑区；提示元素确实挂在编辑区的 aria-describedby 上', async ({
    page,
  }) => {
    await registerFreshUser(page, { core: true });
    await page.goto('/blog/upload');

    // 「先 Esc 再 Tab」是 CodeMirror **自带**的（我们一条 Escape 键处理都没写），
    // 所以这条用例盯的其实是「有没有人后来画蛇添足地绑了一条 Escape」——
    // 绑了就会把它盖掉，键盘用户被关在正文里出不来。
    await page.locator('#editor .cm-content').click();
    await expect(page.locator('#editor .cm-content')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');

    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('cm-content') ?? false),
      'Esc → Tab 之后焦点还在编辑区里'
    ).toBe(false);

    // 提示必须**挂得上**：挂在编辑区的 aria-describedby 上，屏幕阅读器才读得到。
    // 只画一个 span 不接上去等于没写（页面上看得见、读屏读不到）。
    const hint = await page.evaluate(() => {
      const content = document.querySelector('#editor .cm-content');
      const id = content?.getAttribute('aria-describedby');
      return { id: id ?? null, text: id ? (document.getElementById(id)?.textContent ?? null) : null };
    });
    expect(hint.id, '编辑区没有 aria-describedby').toBeTruthy();
    expect(hint.text, 'aria-describedby 指向的元素不是那句键盘提示').toContain('Esc');
  });
});

test.describe('导出的并发', () => {
  test('★ 第一份还在算的时候再点一次：必须给明确提示，且只下一份 ★', async ({ page }) => {
    // 【这一条盯的是「静默早退」】`snapshotBusyRef` 挡住第二份本身是对的（连点两下
    // 不该渲染两遍、下两份），但**不说话**在用户那边就是「点了没反应」—— 而导出偏偏
    // 是最慢的一趟（整篇引用取数 + MathJax 排版），越慢越容易连点，越容易撞上。
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    const clipId = await makeClip(page, `导出并发-${tag}`, `并发正文-${tag}`);

    // 把引用取数按住 —— 导出的「在飞」窗口就在这儿。不按住的话本机几十毫秒就算完了，
    // 两下点击根本不重叠，用例恒绿（什么也没证明）。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = 0;
    await page.route('**/api/clipboard/*', async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });

    await page.goto('/blog/upload');
    await page.fill('#title', `导出并发-${tag}`);
    await page.locator('#editor .cm-content').click();
    await page.keyboard.insertText(`引用 [@${clipId}]`);

    const downloads: Download[] = [];
    page.on('download', (d) => downloads.push(d));

    const exportMenu = async () => {
      await page.locator('#editor').getByRole('button', { name: '导出', exact: true }).click();
      await page
        .locator('#editor')
        .getByRole('menuitem', { name: '导出 HTML', exact: true })
        .click();
    };

    await exportMenu();
    await expect.poll(() => held, { timeout: 10_000 }).toBeGreaterThan(0);

    // 第一份还在算 —— 用户又点了一次
    await exportMenu();
    await expect(
      page.locator('#toast-container'),
      '第二下是静默的 —— 用户以为点了没反应'
    ).toContainText('正在生成导出内容');
    expect(downloads, '第一份还没算完就下去了第二份').toHaveLength(0);

    release();
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(downloads, '第二下也下了一份').toHaveLength(1);
  });
});

test.describe('导出的正文是哪一份', () => {
  test('★ 敲完最后一个字立刻导出：导出件里必须有刚敲的那一段 ★', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    await page.goto('/blog/upload');

    await page.fill('#title', `导出标题-${tag}`);
    await page.locator('#editor .cm-content').click();
    // 先把前一半敲完、等预览追上（这边不着急）
    await page.keyboard.type('第一段。');
    await expect(page.locator('#editor .md-editor__preview-body')).toContainText('第一段。');

    // 再敲后一半，**不等防抖**立刻导出。导出若读的是预览那棵 DOM（防抖 400ms +
    // 一条异步取数），出来的就是**敲之前**那一版 —— 页面上没有任何提示。
    await page.keyboard.type(`第二段-${tag}。`);
    const typedAt = Date.now();
    const { text, filename, elapsedMs } = await exportHtml(page, '#editor', typedAt);

    expect(text, '导出件里没有刚敲的那一段 —— 导出读的是防抖前的旧预览').toContain(
      `第二段-${tag}。`
    );

    // ★ 文件名与 `<title>` 必须**同一份** ★ 标题是受控的、导出读的是此刻的它；
    // 若从进页面那一刻的 prop 取，新建页导出出来就是「未命名」。
    expect(filename).toBe(`导出标题-${tag}.html`);
    expect(text).toContain(`<title>导出标题-${tag}</title>`);

    // 环境太慢的话防抖已经跑完了，这一跑就没测到它要测的东西 —— 明说，别静默放过
    test.skip(elapsedMs >= 400, `防抖（400ms）已经跑完（${elapsedMs}ms），这一跑测不到导出源`);
  });

  test('导出件从 file:// 打开也能用：站内地址补成绝对、复制按钮摘掉、`#锚点` 保留', async ({
    page,
  }) => {
    await registerFreshUser(page, { core: true });
    const imageId = await makeImage(page, `导出图-${uniqueTag()}.png`);

    await page.goto('/blog/upload');
    await page.fill('#title', '导出件地址');
    await page.locator('#editor .cm-content').click();
    for (const line of [
      '## 第一节',
      '',
      '[跳到下面](#第二节)',
      '',
      `![图](/api/images/${imageId}/raw)`,
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '## 第二节',
    ]) {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
    }

    const { text } = await exportHtml(page, '#editor');
    const origin = new URL(page.url()).origin;

    // 正文里的站内相对地址在文件里是相对于**文件自己的位置**解析的 ——
    // 不补的话双击打开就是 `file:///api/images/...`，图片全裂
    expect(text).toContain(`src="${origin}/api/images/${imageId}/raw"`);
    // ★ 而 `#锚点` 恰恰该在文件**自己身上**跳，绝不能一起补成绝对地址。
    //   中文片段过 marked 的 cleanUrl 会被 `encodeURI` 成 `%E7%AC%AC…`（浏览器里等价），
    //   所以这里判的是「还是不是一个**同文档**片段」，不是那几个字节。
    expect(text, '导出件里的 #锚点被改写了').toMatch(/href="#(%E7%AC%AC%E4%BA%8C%E8%8A%82|第二节)"/);
    expect(text).not.toContain(`href="${origin}/#`);
    // 更不能加 <base>：那正好会把上面那条锚点也带回原站
    expect(text).not.toContain('<base');
    // 代码块的「复制」按钮是**站内页面才成立的空壳**（行为由 JS 挂），
    // 留在死文件里就是一颗按不动的按钮
    expect(text).not.toContain('copy-btn');
    // 代码本身留着。**按纯文本判**：高亮会把 `const a = 1;` 切成好几颗 span，
    // 直接找那句话找不到，看着像「代码块没了」。
    expect(text).toContain('hljs');
    expect(text.replace(/<[^>]+>/g, '')).toContain('const a = 1;');
  });
});

// ═══ 视图切换（一次纯粹的父级重渲染）不该抹掉预览里的后处理 ═══════════════════
//
// 【为什么只有 E2E 说得清】预览面板在编辑态是 `display:none`，**切一下视图**就是一次
// 父级重渲染 —— 而 React 19 是按**对象身份** diff `dangerouslySetInnerHTML` 的
// （内联 `{{ __html }}` 每次渲染都是新对象），于是那一瞬间容器的 innerHTML 会被整块
// 重写。后处理（MathJax 排出来的 mjx-container、投票小组件）是在 commit 之后那次效果
// 里做的，效果只认 doc 那几个依赖 —— **DOM 被重写它看不见**，于是不会重跑：
// 公式退回 `$$…$$` 原文、投票位空掉，控制台一个字都不报。
//
// 单测（blog-ref-render.test.ts 的「重渲染不重写正文 DOM」）钉的是机制本身，
// 这一条钉的是**用户真的会撞上的那个动作**：敲完公式切到预览看一眼。

test.describe('切视图不抹掉预览（后处理的产物要留住）', () => {
  test('★ 敲完公式再切到「预览」：公式还排着、投票小组件还填着 ★', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const tag = uniqueTag();
    const voteRes = await page.request.post('/api/votes', {
      data: { title: `切视图-${tag}`, options: ['甲', '乙'] },
    });
    const voteBody = (await voteRes.json()) as { code: number; data: { id: string } };
    expect(voteBody.code, `建投票失败：${JSON.stringify(voteBody)}`).toBe(200);

    await page.goto('/blog/upload');
    await expect(page.locator('#editor .md-toolbar')).toBeVisible();
    await page.locator('#editor .cm-content').click();
    // `$$` 必须**独占一行**：写成同段内的 `$$E=mc^2$$` 时 MathJax 本来就不认这对
    // 定界符（与本次修复无关，是本机实测的 MathJax 语义）—— 那样写会让这条用例
    // 在「有没有这个 bug」两种情况下一律红。
    for (const line of [
      '# 标题',
      '',
      '行内 $x^2$ 与块级：',
      '',
      '$$',
      'x = 1',
      '$$',
      '',
      `投一下 [@${voteBody.data.id}]`,
    ]) {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
    }

    const setView = (label: '编辑' | '并排' | '预览') =>
      page.locator('#editor').getByRole('button', { name: label, exact: true }).click();
    const preview = page.locator('#editor .md-editor__preview-body');
    // 小组件是**后处理建出来的**：正文 HTML 里只有空的 .vote-embed 挂载点
    const widget = preview.locator('.vote-embed-widget');

    // 先在「并排」里看着它排出来（两个面板都可见，排不出来与重写无关）
    await setView('并排');
    await expect(preview.locator('mjx-container').first()).toBeVisible({ timeout: 15_000 });
    await expect(widget).toHaveCount(1, { timeout: 15_000 });

    // ★ 切到「预览」：正文一个字没改，纯粹一次父级重渲染 ★
    await setView('预览');
    await expect(
      preview.locator('mjx-container').first(),
      '切一次视图就把公式打回了原文（后处理过的 DOM 被整块重写了）'
    ).toBeVisible();
    await expect(widget, '切一次视图就把投票位清空了').toHaveCount(1);
  });
});
