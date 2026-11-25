// `npm run guards` —— 静态守卫：扫源码 / 文档 / 素材的文本与台账断言。
//
// 【为什么单独入口】守卫的价值在「拦漂移」，但执行成本全在起 vitest 环境（它们只读文件、
// 不碰库、不碰浏览器）。放进 `npm test` 会让每次改动的门禁为它们付全额环境开销；
// 独立成入口后进 CI / 提交前检查即可（详见 `docs/testing.md` §1.1）。
import { defineConfig } from 'vitest/config';
import { sharedTestOptions, sharedResolve, sharedEsbuild } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: [
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
    ],
    // 守卫全是文件扫描，多 worker 只会抢磁盘；2 个够。
    minWorkers: 1,
    maxWorkers: 2,
  },
  esbuild: sharedEsbuild,
  resolve: sharedResolve,
});
