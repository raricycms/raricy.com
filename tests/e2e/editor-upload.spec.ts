import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// Markdown 编辑器（博客 / 云剪贴板）上传图片的**真实链路**。
//
// 【为什么要 E2E】这条链路的错法全都不指向根因，而且只有真跑浏览器才碰得到：
//   · 字段名 —— 上传必须带表单字段 `file`。错了的话文件其实发出去了，服务端
//     `form.get('file')` 取不到 → `400 请选择文件`（2026-09 线上报的就是这条）。
//   · 响应结构 —— 取回来的地址要拼成**标准 Markdown**（`![名](url)`）再插进正文。
//     拼错了图片会**静默**插不进去，页面上一点报错都没有。
//   · 插入锚点 —— 多张图是**各发各的请求**、按完成顺序回来，而版面必须按
//     **用户选择的顺序**。它错了只会「偶尔顺序乱」，单张图测不出来。
//   · 体积闸门 —— 超限的 body 到服务端只会变成看不懂的「无效的上传请求」
//     （Next 中间件静默截断）或 413 HTML 错误页。必须在发请求**之前**拦下。
//   · 拖拽 —— CM6 默认对拖进来的文件是「读出它的**文本内容**再插入」，图片二进制
//     会被读成乱码塞进正文。这条只有真拖一次才知道拦没拦住。
//
// 【断言正文用预览，不读 CM6 的 DOM】`#editor .md-editor__preview-body` 里是整篇
// 渲染后的成品 —— 「用户打完字看到什么」就是它，而 `.cm-content` 的 innerText 是
// CM6 内部结构，顺带还会把零宽的「上传中」徽标文本混进来。

/** 1x1 透明 PNG。 */
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1X1 = Buffer.from(PNG_1X1_B64, 'base64');

/** 两个编辑器共用同一份上传实现，两边都得真跑一遍。 */
const EDITORS = [
  { name: '博客编辑器', url: '/blog/upload', editor: '#editor' },
  { name: '云剪贴板编辑器', url: '/clipboard/upload', editor: '#clipboard-editor' },
];

/** 数一数发出去的图片上传请求。 */
function countUploads(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/images') && r.method() === 'POST') n += 1;
  });
  return () => n;
}

/** 切到预览，把整篇渲染结果拿来断言。 */
async function showPreview(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '预览', exact: true }).click();
  return page.locator(`${editor} .md-editor__preview-body`);
}

for (const { name, url, editor } of EDITORS) {
  test(`${name}：工具栏里没有多出来的「选择文件」控件`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

    // .filepick 是 base.js 给**看得见的**原生 input[type=file] 注入的 UI
    //（一颗蓝按钮 + 「未选择文件」+ ×）。编辑器那颗上传 input 靠 `hidden` 属性
    // 与**行内** display:none 隐形 —— base.js 只认这两种，写在样式表里的看不见。
    // 一旦被接管，工具条上就凭空多出一组控件（2026-10 线上实际如此）。
    const input = page.locator(`${editor} input[type="file"]`);
    await expect(input).toHaveCount(1);

    // 【为什么要手动跑一次，而不是干等 MutationObserver】两个编辑器的时序不一样，
    // 干等着会得到**假绿灯**：实测把守卫去掉后，博客那一条照样通过，只有云剪贴板
    // 那条变红。手动调公开入口对两个页面都稳定 —— 而且这正是「站内路由跳转后再跑
    // 一轮增强」那条真实路径。
    await page.evaluate(() => (window as { enhanceFileInputs?: () => void }).enhanceFileInputs?.());
    await expect(page.locator(`${editor} .filepick`)).toHaveCount(0);
    await expect(input).toHaveCount(1);
  });

  test(`${name}：上传一张，正文里出现该图的 Markdown 并被渲染出来`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

    // 先挂上响应监听再喂文件，否则可能错过已经返回的请求
    const uploadResponse = page.waitForResponse(
      (r) => r.url().includes('/api/images') && r.request().method() === 'POST'
    );
    await page
      .locator(`${editor} input[type="file"]`)
      .setInputFiles({ name: 'e2e-upload.png', mimeType: 'image/png', buffer: PNG_1X1 });

    // ① 服务端收下了 —— 字段名对不上的话这里是 400 请选择文件
    const res = await uploadResponse;
    expect(res.status(), `上传接口返回 ${res.status()}：${await res.text()}`).toBe(200);

    // ② 图片真的进了正文 —— 响应结构对不上的话前面 200、这里什么都没有
    const preview = await showPreview(page, editor);
    const img = preview.locator('img[src^="/api/images/"]');
    await expect(img).toHaveCount(1);

    // ③ 且是 raw 地址（能显示出来），不是落库用的 id
    await expect(img).toHaveAttribute('src', /^\/api\/images\/[A-Za-z0-9]{10}\/raw$/);

    // ④ 不该同时弹错误提示
    await expect(page.locator('#toast-container .toast--error')).toHaveCount(0);
  });

  test(`${name}：一次选多张（含重名）全部进正文，且版面顺序＝选择顺序`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

    const uploads = countUploads(page);

    // 三张：两张**同名**。同名不会撞掉任何一张 —— 每张各发各的请求、各自带自己的
    // 文件名，而不是像旧实现那样把结果塞进一个「文件名 → 地址」的映射表里
    //（那种结构下同名只剩最后一张）。
    await page.locator(`${editor} input[type="file"]`).setInputFiles([
      { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1X1 },
      { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1X1 },
      { name: 'other.png', mimeType: 'image/png', buffer: PNG_1X1 },
    ]);

    const preview = await showPreview(page, editor);
    const imgs = preview.locator('img[src^="/api/images/"]');
    await expect(imgs).toHaveCount(3);

    // 版面顺序 = 用户选择的顺序。三张并发、完成顺序随机，所以这一条同时钉住了
    // 「锚点按选择顺序落位」——按完成顺序落位的话这里会时不时红。
    // （上面 toHaveCount(3) 已经等到三张都进正文了，这里读到的不是中间态。）
    expect(await imgs.evaluateAll((els) => els.map((el) => el.getAttribute('alt')))).toEqual([
      'shot.png',
      'shot.png',
      'other.png',
    ]);

    // 一张一个请求（不是打成一个大 body）—— 单张失败不影响其余几张，
    // 也让「重试某一张」有粒度
    expect(uploads()).toBe(3);
    await expect(page.locator('#toast-container .toast--error')).toHaveCount(0);
  });

  test(`${name}：拖拽图片文件进编辑区会被拦下并上传（不是被读成文本）`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor} .cm-content`)).toBeVisible();

    const uploadResponse = page.waitForResponse(
      (r) => r.url().includes('/api/images') && r.request().method() === 'POST'
    );

    // CM6 的默认 drop 处理是「用 FileReader 读出文件的文本再插入」——图片会被读成
    // 乱码。这条真造一个 drop 事件，走的是编辑器注册的同一个处理器。
    await page.locator(`${editor} .cm-content`).evaluate(
      (el, b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: rect.left + 8,
            clientY: rect.top + 8,
          })
        );
      },
      PNG_1X1_B64
    );

    const res = await uploadResponse;
    expect(res.status()).toBe(200);

    const preview = await showPreview(page, editor);
    await expect(preview.locator('img[src^="/api/images/"]')).toHaveCount(1);
    // 正文里**只有**这张图：二进制若被当文本读进来，这里会多出一坨可读字符
    await expect(preview).toHaveText(/^\s*$/);
  });

  test(`${name}：一次选的图总体积超限时拦在上传之前`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor} .md-toolbar`)).toBeVisible();

    const uploads = countUploads(page);

    // 两张 6MB（合计 12MB > 11MB 闸门）。字节内容无所谓 —— 闸门在任何校验之前。
    const big = Buffer.alloc(6 * 1024 * 1024);
    await page.locator(`${editor} input[type="file"]`).setInputFiles([
      { name: 'big1.png', mimeType: 'image/png', buffer: big },
      { name: 'big2.png', mimeType: 'image/png', buffer: big },
    ]);

    // 提示要说清怎么办（input 的 value 已经清空了，重选同一批会重新触发 ——
    // 但只说「太大了」，用户还是不知道下一步做什么）
    await expect(page.locator('#toast-container .toast__body')).toContainText('分批');

    // 关键：一张都没发出去
    expect(uploads()).toBe(0);
    // 也不要留下任何「上传中」的占位徽标 —— 拦下时不该建批次
    await expect(page.locator(`${editor} .md-upload-chip`)).toHaveCount(0);
  });
}
