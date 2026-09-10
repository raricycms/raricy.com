import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // 默认 node 环境；需要 DOM 的用例在文件顶部用 // @vitest-environment jsdom 覆盖
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // E2E 用 Playwright 跑（npm run e2e），它的用例引的是 @playwright/test 的 API，
    // 被 vitest 吸进来必崩。两套 runner 共用 tests/ 目录，故显式排除。
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // 文件级并行。曾经是 false，因为 service 层用例会互相 rmSync + db push 同一个库
    // （报 "table users already exists" / "readonly database"）。
    //
    // 那个坑的根因是**共享库文件名**，不是并行本身：tests/setup.ts 给每个测试文件发
    // 唯一的库名（pid + 随机串），各文件再从模板库复制自己的副本（见 tests/global-setup.ts），
    // 不存在两个文件写同一 inode 的情况 —— 并行安全。
    //
    // 实测 8 核：串行 175s → 并行 63s。
    fileParallelism: true,
    // 8 核留出余量。每个 worker 都带一个 Prisma client + 独立 SQLite，拉满只会让
    // 本来就在跑真实计时的用例（登录限频的 bcrypt 等）撞超时，收益也早已饱和。
    // minWorkers 必须显式给：它默认取 CPU 数，不写就会 > maxWorkers 而直接抛
    // 「options.minThreads and options.maxThreads must not conflict」。
    minWorkers: 1,
    maxWorkers: 4,
    // 建模板库（一次性）。各测试文件的库副本由 tests/helpers/db.ts 的 ensureSchema() 拷。
    globalSetup: ['tests/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/middleware.ts'],
      exclude: ['src/lib/db.ts'],
    },
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
});
