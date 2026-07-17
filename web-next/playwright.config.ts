import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// E2E 配置。
//
// 【为什么需要 E2E】1000+ 后端用例抓不到这类问题 —— 今天线上三个 bug 全是例证：
//   · CSRF 中间件在反代下误杀正常请求（要真发 HTTP 才看得见）
//   · HTTP 站点下 Secure cookie 被浏览器丢弃（要真跑浏览器才看得见）
//   · base.js 在 DOMContentLoaded 之后加载 → 汉堡菜单/头像下拉是死的
//     （页面 200、样式对、图标在，只有真去点才知道）
// 后端测试证明「逻辑对」，E2E 证明「用户真能用」。
//
// 【数据安全】webServer 用独立的 e2e 测试库（tests/.tmp/e2e.db），
// 由 global-setup 从 schema 建表 + 造种子数据，绝不碰 data/ 与 prisma/prod.db。

const E2E_DB = path.resolve(import.meta.dirname, 'tests/.tmp/e2e.db');
const PORT = 3100; // 避开开发用的 3000

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // 共用一个测试库，串行更稳
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 30_000,
  globalSetup: './tests/e2e/global-setup.ts',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],

  webServer: {
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
      // 站点走 http://127.0.0.1 —— 若下发 Secure cookie，浏览器会丢弃它，
      // 登录会「成功但不粘」。这正是线上踩过的坑；此处显式关掉，
      // 另有专门用例验证该判定逻辑本身。
      COOKIE_SECURE: 'false',
      AVATARS_DIR: path.resolve(import.meta.dirname, 'tests/.tmp/e2e-avatars'),
      IMAGE_UPLOAD_FOLDER: path.resolve(import.meta.dirname, 'tests/.tmp/e2e-images'),
    },
  },
});
