import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// 用 __dirname 而非 import.meta.dirname：Playwright 会把配置与用例转成 CJS 再加载，
// import.meta 在那里是语法错误（SyntaxError: Cannot use 'import.meta' outside a module）。
// vitest 侧是原生 ESM，故 vitest.config.ts / tests/setup.ts 里的 import.meta.dirname 没问题 ——
// 两套 runner 的加载方式不同，别照抄。

// E2E 配置。
//
// 【为什么需要 E2E】1000+ 后端用例抓不到这类问题 —— 今天线上三个 bug 全是例证：
//   · CSRF 中间件在反代下误杀正常请求（要真发 HTTP 才看得见）
//   · HTTP 站点下 Secure cookie 被浏览器丢弃（要真跑浏览器才看得见）
//   · base.js 在 DOMContentLoaded 之后加载 → 汉堡菜单/头像下拉是死的
//     （页面 200、样式对、图标在，只有真去点才知道）
// 后端测试证明「逻辑对」，E2E 证明「用户真能用」。
//
// 【数据安全】webServer 用独立的 e2e 测试库（tests/.tmp/e2e-*.db），
// 由 global-setup 从 schema 建表 + 造种子数据，绝不碰 instance/ 与 prisma/prod.db。

// ★ 库名每轮唯一 ★
//
// Playwright **先起 webServer、再跑 globalSetup**（实测：globalSetup 里探到 3100/3102
// 都已占用）。库名若是固定的 e2e.db，那么服务器一启动就可能把上一轮留下的同名文件
// 打开，紧接着 globalSetup 把它 rmSync 掉重建 —— 服务器手里攥着已删除的 inode，
// 之后所有写入都报「attempt to write a readonly database」，用例成片地挂。
// 是竞态而非必现：服务器恰好还没碰库就没事。实测同一份代码跑出 154 / 51 / 54 三种结果，
// 排查时极易误判成「测试本身 flaky」。
//
// 名字唯一 → globalSetup 建的是一个谁都没开过的新文件，竞态从根上不存在。
// 路径经 process.env.E2E_DB 传给 global-setup / teardown（它们与本文件同进程）。
const E2E_DB = path.resolve(
  __dirname,
  `tests/.tmp/e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`
);
process.env.E2E_DB = E2E_DB;

// 表情素材目录同理要经 process.env 传 —— globalSetup 与 webServer 是两个进程，
// 只写在 webServer.env 里的话 globalSetup 读不到（它要往这个目录造素材）。
const E2E_STICKERS_DIR = path.resolve(__dirname, 'tests/.tmp/e2e-stickers');
process.env.STICKERS_DIR = E2E_STICKERS_DIR;

// 头像框素材同理（同样是两个进程都要知道）。不设它 frame-service 会去扫 repo 根的
// public/static/frames（入库的真实素材），断言会随仓库内容而变。
const E2E_FRAMES_DIR = path.resolve(__dirname, 'tests/.tmp/e2e-frames');
process.env.FRAMES_DIR = E2E_FRAMES_DIR;

// 故事素材同理。**不设它故事页会读 repo 根的 instance/stories**（站长的真实数据），
// 那会让 /story 的用例随机器时通时不通 —— 本地有故事就跑得通，别人机器上就 404。
// 素材由 global-setup 的 seedStories() 造（一篇 markdown + 一份 cattca），
// 于是故事两页在 e2e 里是确定的。
const E2E_STORIES_DIR = path.resolve(__dirname, 'tests/.tmp/e2e-stories');
process.env.STORIES_DIR = E2E_STORIES_DIR;
const PORT = 3100; // 避开开发用的 3000
const MARKET_PORT = 3102; // 练手盘行情替身，见 tests/e2e/mock-market-price.ts

/**
 * 真正需要 mobile 布局的 spec —— mobile project 只跑这些（见下方 projects 的注解）。
 *
 * 判据是「用例是否碰布局」，不是「文件里有没有 mobile 字样」：
 *   · 用了 isMobile / viewportSize() 按布局分支的
 *   · 依赖抽屉 / 侧栏折叠 / 汉堡菜单的
 *
 * 注意 testMatch 匹配的是**文件路径**，匹配不了 describe 名（实测：
 * /^x\.spec\.ts:.*某describe/ 这种写法不报错但一个用例都选不中，是静默失效）。
 * 所以粒度只能到文件 —— 一个文件里只要有用例要双跑，整个文件就都得双跑。
 *
 * 加新 spec 时的判断：用例里碰了汉堡菜单 / 抽屉 / 侧栏折叠 / viewport 尺寸，
 * 就加进来；只是 goto 一个页面再断言内容，就不加。
 */
const RESPONSIVE_SPECS: RegExp[] = [
  /chat-features\.spec\.ts$/,
  /chat-sidebar\.spec\.ts$/,
  /vditor-theme\.spec\.ts$/,
  /chat-avatar-menu\.spec\.ts$/,
  /chat-sse\.spec\.ts$/,
  // 只有「移动端汉堡红点」那 2 条是移动端专属，另外 3 条是通用的未读角标语义。
  // 粒度到不了 describe，整个文件跟着双跑 —— 多跑 3 条，换「不会漏掉那条
  // test.skip(!isMobile) 的用例」。
  /chat-unread-mark\.spec\.ts$/,
  // 评论输入区与讨论共用 RichComposer：触屏下 useCoarsePointer 会把 Enter 从「发送」
  // 改成「换行」，发送只剩右下角按钮 —— 那是只可能在移动端跑出来的分支。
  /comment-rich\.spec\.ts$/,
  // 代码块顶破气泡是按**视口宽度**才出现的（窄屏可用宽度更小，同样的长代码行
  // 才会越过 fit-content 的上限）。桌面端跑它价值有限，移动端才是主场景。
  /chat-codeblock\.spec\.ts$/,
  // 收藏夹的布局用例：断言的就是「三颗按钮同一行」「标签不折行」「名称独占一行」
  // 这类**靠浏览器排版才成立**的事实，且按 viewportSize() 分档（<360px 有兜底）。
  // 桌面那一遍同样要跑 —— 用户报的正是**电脑端**弹窗里两颗按钮被拆成两行。
  /favorite-layout\.spec\.ts$/,
  // 评论区的横向溢出（楼中楼缩进把祖先撑宽）。同样是排版事实：border-box 下
  // padding 算在 width: 100% 里、margin 不算，要靠浏览器排版才看得出溢出多少。
  /comment-layout\.spec\.ts$/,
  // 小鱼干余额页的三颗行动：窄屏靠「藏前缀 + 收内边距」压在同一行，差几个像素就换行 ——
  // 同样是只有浏览器排版才说得清的事实。桌面那一遍验的是「文案没被压掉」。
  /fish-layout\.spec\.ts$/,
  // 页面檐沟：断言「抬头/首屏元素的左边缘离视口左边缘 ≥16px」。这是「谁兜住了这一页」
  // 的合成结果（元素自身内边距 + 祖先容器的檐沟），读样式表看不出来。视口在文件内
  // 显式钉死 390px，所以两遍跑的是同一件事，但 desktop 那一遍同样保留 —— 见文件头。
  /page-gutter\.spec\.ts$/,
  // 练手盘三栏工作台：四段阶梯里有两段只在窄视口走得到（自选变横向条、落成单列），
  // 而三栏那一档（desktop）同样要量 —— 列被内容撑破、网格里的 SVG 塌成 0，
  // 两件事在源码里都完全正常，只有真视口量得出来。
  /fish-trade-chart\.spec\.ts$/,
];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // 共用一个测试库，串行更稳
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 30_000,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // ── project 划分 ────────────────────────────────────────────────────────
  //
  // 原来两个 project 都把**每个**用例各跑一遍。但 23 个 spec 里只有 6 个真的
  // 看 viewport，其余 17 个是「goto 一个页面 → 断言 DOM / 打接口」——
  // 布局影响不到它们，mobile 那一遍纯属重复。
  //
  // 所以：desktop 跑全部，mobile 只跑 RESPONSIVE_SPECS。
  //
  // 为什么不反过来（把通用用例从 mobile 里排除）——两者等价，但那样要写 testIgnore，
  // 而 testIgnore 在 project 级上会同时作用于两个 project（踩过：desktop 和 mobile
  // 一起被排除，用例一条不剩）。desktop 保持默认全跑，没有这个坑。
  //
  // 【为什么不按 describe 细分】testMatch 只匹配文件路径，匹配不了 describe 名
  // （实测 /^x\.spec\.ts:.*某describe/ 不报错但选不中任何用例，静默失效 ——
  // 比报错更危险）。粒度只能到文件。
  //
  // 【为什么响应式的用例仍需 desktop 那一遍】这批用例大量写成
  // `if (isMobile) 点抽屉菜单 else 点展开的侧栏` —— 同一个 test 覆盖两种布局，
  // 只在 mobile 跑就等于桌面分支无人验证。所以 desktop 必须保留全量。
  //
  // 实测 300 → 179 个用例，耗时约减半。
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'] },
      testMatch: RESPONSIVE_SPECS,
    },
  ],

  webServer: [
    {
      // 行情源替身。**不是可选项**：练手盘的成交价是下单那一刻现取的，e2e 里不拦住
      // 就是真去打币安 —— 用例会随「墙内通不通、当时价格多少」随机成败，而
      // 「涨了 mint / 跌了 burn」这类断言需要一个确定的涨跌。
      command: `npx tsx tests/e2e/mock-market-price.ts`,
      port: MARKET_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_MARKET_PORT: String(MARKET_PORT),
      },
    },
    {
    // 用 next start（生产构建）而非 dev —— 线上跑的是这个，
    // 且 dev 模式的 Fast Refresh 会干扰「脚本加载时序」这类用例。
    command: `next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: `file:${E2E_DB}`,
      SECRET_KEY: 'e2e-test-secret-key',
      // 回调签名密钥的专用加密钥匙。**故意给一个与 SECRET_KEY 不同的值**：
      // 两条写路径（登记回调 / 换密钥）在缺它时是**响亮失败**（503），漏设的话
      // 以后写回调的用例会以一个看不出根因的 503 收场。
      FISH_ENCRYPTION_KEY: 'e2e-test-fish-encryption-key',
      // 站点走 http://127.0.0.1 —— 若下发 Secure cookie，浏览器会丢弃它，
      // 登录会「成功但不粘」。这正是线上踩过的坑；此处显式关掉，
      // 另有专门用例验证该判定逻辑本身。
      COOKIE_SECURE: 'false',
      // 画报 / 收款码的二维码前缀取自 SITE_URL（见 src/lib/site-url.ts）。
      // 不显式给的话会回落到 .env 里的 http://localhost:3000 —— 图照样能出，
      // 但二维码指向的是开发端口而不是这个测试服务器，等于测了个假的。
      SITE_URL: `http://127.0.0.1:${PORT}`,
      // 限频桶的快照落盘/回灌必须隔离到 tests/.tmp —— 不设它就会读写项目真实的
      // instance/rate-limit-snapshot.json：跑一次 e2e 就把测试用户的配额写进
      // 那边的持久状态（实测攒出 e2e-user-core 的 like 桶），且下一次启动还会
      // 回灌进来。测试不该碰 instance/ 下的任何东西（同 DATABASE_URL 的纪律）。
      RATE_LIMIT_SNAPSHOT_PATH: path.resolve(__dirname, 'tests/.tmp/e2e-rate-limit.json'),
      // 回调投递的定时器**必须关掉**：e2e 里根本没有接收端，让它跑起来就是一个
      // 后台循环对着不存在的地址反复重试。src/lib/webhook-drainer.ts 里那道
      // `NODE_ENV === 'test'` 的保险在这里**盖不住** —— e2e 跑的是 next start，
      // NODE_ENV 是 production。所以这一条是 e2e 侧唯一的闸门。
      FISH_WEBHOOK_DRAIN_MS: '0',
      // 练手盘的行情轮询同理必须关掉 —— 理由与上一条同款（e2e 跑的是 next start，
      // NODE_ENV 是 production，market-poll-drainer 里那道 `NODE_ENV === 'test'`
      // 的保险在这里盖不住）。行情由用例自己按需触发，不靠后台循环。
      MARKET_POLL_MS: '0',
      // 行情流（常驻 WebSocket）更要关：e2e 的行情替身**只有 HTTP、没有 WS 端点**，
      // 不关它就会去连真实币安（违反「e2e 不能打真实外网」），而且展示价会开始跟真价走，
      // fish-trade.spec.ts 那几条「展示价 == 80000」的断言跟着变脆。
      // 理由同上面两条：next start 是 production，模块内那道 NODE_ENV 保险盖不住。
      MARKET_STREAM_SILENCE_MS: '0',
      // 行情源指向替身 —— 见上面那个 webServer 条目的说明。
      MARKET_PRICE_BASE_URL: `http://127.0.0.1:${MARKET_PORT}`,
      AVATARS_DIR: path.resolve(__dirname, 'tests/.tmp/e2e-avatars'),
      IMAGE_UPLOAD_FOLDER: path.resolve(__dirname, 'tests/.tmp/e2e-images'),
      // ⚠️ 音频这个**尤其不能漏**：没设它的话，e2e 的每次音频上传都会静默写进
      // 开发者本机的真实 instance/audio/ —— 没有报错、没有警告，只是测试数据混进了
      // 生产数据目录。图床漏了同理，但音频文件大得多、也更难事后分辨。
      AUDIO_UPLOAD_FOLDER: path.resolve(__dirname, 'tests/.tmp/e2e-audio'),
      // 表情素材同理：不设它就会去扫项目真实的 instance/stickers（本机可能真有素材），
      // 「空素材」这类用例会因此随机通过或失败。
      STICKERS_DIR: E2E_STICKERS_DIR,
      FRAMES_DIR: E2E_FRAMES_DIR,
      STORIES_DIR: E2E_STORIES_DIR,
    },
    },
  ],
});
