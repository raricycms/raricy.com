import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// vditor 编辑器（博客 / 云剪贴板）上传图片的**真实链路**。
//
// 【为什么要 E2E】这条链路的两端各有一套协议，错法都不指向根因，而两端都只有
// 真跑浏览器才碰得到：
//   · 字段名 —— vditor 默认 `file[]`，/api/images 只认 `file`。文件其实发出去了，
//     服务端 form.get('file') 取不到 → `400 请选择文件`（2026-09 线上报的就是这条）。
//   · 响应结构 —— vditor 要 `{ code, msg, data: { errFiles, succMap } }`，
//     本站返回 `{ code: 200, message, id, url }`。不转换的话图片**静默**插不进去
//     （genUploadedLabel 抛 TypeError），页面上一点报错都没有。
// 单测够不着（vditor 的 XHR 与 DOM 插入全在浏览器里），接口测试也够不着
// （它自己拼 FormData，压根不经过 vditor 的 upload 配置）—— 而这两条恰恰是
// 「换了个编辑器配置就悄悄坏掉」的地方。协议本身另有静态契约单测：
// tests/unit/vditor-upload.test.ts。

/**
 * 1x1 透明 PNG。
 *
 * 不能用随便一串字节：服务端 verifyImageMime 会 sniff magic bytes，
 * 声明 image/png 而内容不符直接 400 文件内容与声明的格式不匹配。
 * 也必须是真图片 —— 服务端还要过一遍 sharp 压缩。
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 两个编辑器共用 src/lib/vditor-upload.ts 的同一份上传配置，两边都得真跑一遍。 */
const EDITORS = [
  { name: '博客编辑器', url: '/blog/upload', editor: '#editor' },
  { name: '云剪贴板编辑器', url: '/clipboard/upload', editor: '#clipboard-editor' },
];

for (const { name, url, editor } of EDITORS) {
  test(`${name}：工具栏里没有多出来的「选择文件」控件`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor}.vditor`)).toBeVisible();

    // .filepick 是 base.js 给**可见的**原生 input[type=file] 注入的 UI。vditor 那颗
    // 上传 input 靠 CSS 隐形（没有 hidden 属性、没有 display:none），早退抓不到它 ——
    // 一旦被接管，工具栏里就凭空多出一颗「选择文件」蓝钮 + 「未选择文件」+ ×
    // （2026-10 线上实际如此）。这条守的是「编辑器里一个 .filepick 都不该有」。
    const input = page.locator('.vditor-toolbar input[type="file"]');
    await expect(input).toHaveCount(1); // 工具栏建出来了，这颗 input 已经在 DOM 里

    // 【为什么要手动跑一次，而不是干等 MutationObserver】两个编辑器的时序不一样，
    // 干等着会得到一个**假绿灯**：实测把守卫去掉后，博客那一条照样通过（那颗 input
    // 是 base.js 三轮 init 之后才插进来的，观察器没轮到它），只有云剪贴板那条变红。
    // 手动调公开入口对两个页面都稳定 —— 而且这正是「编辑器里再跑一次增强」那条真实路径
    // （客户端路由跳转就是靠它兜的）。
    await page.evaluate(() => (window as { enhanceFileInputs?: () => void }).enhanceFileInputs?.());
    await expect(page.locator(`${editor} .filepick`)).toHaveCount(0);
    // 上传的入口仍只有工具栏那颗图标
    await expect(input).toHaveCount(1);
  });

  test(`${name}：上传图片后 Markdown 里出现 /api/images 地址`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor}.vditor`)).toBeVisible();

    // 上传是 vditor 工具栏里那个隐藏的 <input type=file>（点图标才弹系统选择框）
    const input = page.locator('.vditor-toolbar input[type="file"]');
    await expect(input).toHaveCount(1);

    // 先挂上响应监听再喂文件，否则可能错过已经返回的请求
    const uploadResponse = page.waitForResponse(
      (r) => r.url().includes('/api/images') && r.request().method() === 'POST'
    );
    await input.setInputFiles({ name: 'e2e-vditor-upload.png', mimeType: 'image/png', buffer: PNG_1X1 });

    // ① 服务端收下了 —— 字段名对不上的话这里是 400 请选择文件
    const res = await uploadResponse;
    expect(res.status(), `上传接口返回 ${res.status()}：${await res.text()}`).toBe(200);

    // ② 图片真的插进编辑器了 —— 响应结构对不上的话前面 200、这里什么都没有
    //    （IR 模式把 Markdown 图片就地渲染成 <img>）
    const img = page.locator(`${editor} img[src^="/api/images/"]`);
    await expect(img).toHaveCount(1);

    // ③ 且是 raw 地址（能显示出来），不是落库用的 id
    await expect(img).toHaveAttribute('src', /^\/api\/images\/[A-Za-z0-9]{10}\/raw$/);

    // ④ 不该同时弹错误提示
    await expect(page.locator('.vditor-tip')).toBeHidden();
  });

  test(`${name}：一次选多张，全部插进 Markdown（含重名）`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor}.vditor`)).toBeVisible();

    const input = page.locator('.vditor-toolbar input[type="file"]');
    // multiple 打开后选择框真的带 multiple 属性 —— 否则浏览器只会让用户选一张
    await expect(input).toHaveAttribute('multiple', 'multiple');

    const uploaded: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/images') && r.method() === 'POST') uploaded.push(r.url());
    });

    // 三张：两张**同名**（succMap 的键会撞，撞了 vditor 只会插一张）+ 一张不同名
    await input.setInputFiles([
      { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1X1 },
      { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1X1 },
      { name: 'other.png', mimeType: 'image/png', buffer: PNG_1X1 },
    ]);

    // 一次请求带三张（不是拆成三次）
    await expect(page.locator(`${editor} img[src^="/api/images/"]`)).toHaveCount(3);
    expect(uploaded).toHaveLength(1);
    await expect(page.locator('.vditor-tip')).toBeHidden();
  });

  test(`${name}：一次选的图总体积超限时拦在上传之前`, async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(url);
    await expect(page.locator(`${editor}.vditor`)).toBeVisible();

    let posted = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/images') && r.method() === 'POST') posted += 1;
    });

    // 两张 6MB（合计 12MB > 11MB 闸门）。字节内容无所谓 —— 闸门在任何校验之前。
    const big = Buffer.alloc(6 * 1024 * 1024);
    await page.locator('.vditor-toolbar input[type="file"]').setInputFiles([
      { name: 'big1.png', mimeType: 'image/png', buffer: big },
      { name: 'big2.png', mimeType: 'image/png', buffer: big },
    ]);

    // 提示要说清怎么办（被 validate 拒时 vditor 不会重置 input.value，
    // 用户重选同一批不会再触发 change，只说「太大了」会像点了没反应）
    await expect(page.locator('.vditor-tip')).toContainText('分批');
    // 关键：一张都没发出去。超限的 body 到了服务端只会变成看不懂的
    // 「无效的上传请求」（Next 中间件静默截断）或 413 HTML 错误页。
    expect(posted).toBe(0);
  });
}
