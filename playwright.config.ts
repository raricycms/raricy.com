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
// Playwright **先起 webServer、再跑 globalSetup**（实测：globalSetup 里探到 3100/3101
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
const PORT = 3100; // 避开开发用的 3000
const ACCOUNT_PORT = 3101; // 账户服务替身，见 tests/e2e/mock-account-service.ts
const ACCOUNT_INTERNAL_TOKEN = 'e2e-internal-token';

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
      // 账户微服务替身。**不是可选项**：next start 下 NODE_ENV=production，
      // 而注册/签到走 fail-closed 鱼干写路径 —— 未配 ACCOUNT_SERVICE_INTERNAL_TOKEN
      // 时 assertRemoteRequiredInProduction() 直接抛 503。不接远端就跑不了这两条主链路。
      command: `npx tsx tests/e2e/mock-account-service.ts`,
      port: ACCOUNT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_ACCOUNT_PORT: String(ACCOUNT_PORT),
        E2E_ACCOUNT_INTERNAL_TOKEN: ACCOUNT_INTERNAL_TOKEN,
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
      ACCOUNT_SERVICE_URL: `http://127.0.0.1:${ACCOUNT_PORT}`,
      ACCOUNT_SERVICE_INTERNAL_TOKEN: ACCOUNT_INTERNAL_TOKEN,
      ACCOUNT_SYSTEM_KEY: 'e2e-system-key',
      // 站点走 http://127.0.0.1 —— 若下发 Secure cookie，浏览器会丢弃它，
      // 登录会「成功但不粘」。这正是线上踩过的坑；此处显式关掉，
      // 另有专门用例验证该判定逻辑本身。
      COOKIE_SECURE: 'false',
      // 限频桶的快照落盘/回灌必须隔离到 tests/.tmp —— 不设它就会读写项目真实的
      // instance/rate-limit-snapshot.json：跑一次 e2e 就把测试用户的配额写进
      // 那边的持久状态（实测攒出 e2e-user-core 的 like 桶），且下一次启动还会
      // 回灌进来。测试不该碰 instance/ 下的任何东西（同 DATABASE_URL 的纪律）。
      RATE_LIMIT_SNAPSHOT_PATH: path.resolve(__dirname, 'tests/.tmp/e2e-rate-limit.json'),
      AVATARS_DIR: path.resolve(__dirname, 'tests/.tmp/e2e-avatars'),
      IMAGE_UPLOAD_FOLDER: path.resolve(__dirname, 'tests/.tmp/e2e-images'),
    },
    },
  ],
});
