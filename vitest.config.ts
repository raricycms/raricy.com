// `npm test` —— 日常门禁。只含「改了代码跑一遍」的用例；
// 静态守卫、迁移验收、启动生命周期走各自入口（见 package.json 的 guards / test:migrations /
// test:slow，口径见 `docs/plan/test-suite-audit.md` §2/§5）。
import { defineConfig } from 'vitest/config';
import { sharedTestOptions, sharedResolve, sharedEsbuild, MAX_WORKERS } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // E2E 用 Playwright 跑（`npm run e2e`），它的用例引的是 @playwright/test 的 API，
    // 被 vitest 吸进来必崩。两套 runner 共用 tests/ 目录，故显式排除。
    // `tests/.tmp/` 是测试基建的临时目录（数据库副本、审计残留），里面的 *.test.ts 不属于
    // 本项目用例 —— 不排除的话会被当成本仓测试跑。
    exclude: [
      'tests/e2e/**',
      'tests/.tmp/**',
      'node_modules/**',
      // 静态守卫：`npm run guards`（实时扫描源码/文档/素材，属仓库守卫而非行为测试）
      'tests/unit/agent-instructions.test.ts',
      'tests/unit/anonymous-read-guard.test.ts',
      'tests/unit/audit-action-guard.test.ts',
      'tests/unit/audit-json-column-guard.test.ts',
      'tests/unit/avatar-sites-guard.test.ts',
      'tests/unit/blog-visibility-guard.test.ts',
      'tests/unit/cli-docs.test.ts',
      'tests/unit/cli-guards.test.ts',
      'tests/unit/db-reset-tables.test.ts',
      'tests/unit/db-time-guard.test.ts',
      'tests/unit/docs-catalog.test.ts',
      'tests/unit/docs-xref.test.ts',
      'tests/unit/explore-visibility-guard.test.ts',
      'tests/unit/fish-scale-guard.test.ts',
      'tests/unit/frame-assets.test.ts',
      'tests/unit/frame-guard.test.ts',
      'tests/unit/guide-docs.test.ts',
      'tests/unit/lib-index-guard.test.ts',
      'tests/unit/pwa-metadata.test.ts',
      // 空库全量迁移验收：`npm run test:migrations`（300s 级，不该占默认门禁）
      'tests/service/migrate-entry.test.ts',
      // 启动生命周期 / 子进程慢车道：`npm run test:slow`
      'tests/unit/app-start.test.ts',
      'tests/unit/reactive-corpus-cli.test.ts',
    ],
    minWorkers: 1,
    maxWorkers: MAX_WORKERS,
  },
  esbuild: sharedEsbuild,
  resolve: sharedResolve,
});
