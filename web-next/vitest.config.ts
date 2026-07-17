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
    // service 层用例共用一个临时 SQLite，多文件并行会互相 rmSync + db push 同一个库
    // （报 "table users already exists" / "readonly database"）。
    // 注意：Vitest 2.x 的**文件级**并行由 fileParallelism 控制，
    // poolOptions.threads.singleThread 拦不住它（默认 pool 还是 forks）。
    fileParallelism: false,
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
