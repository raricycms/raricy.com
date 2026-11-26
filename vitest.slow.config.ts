// `npm run test:slow` —— 起子进程 / 占端口的慢车道：共同启动生命周期、只读语料 CLI。
//
// 【为什么单独入口】它们要 spawn node 子进程 / vite-node（单条 2–10s），占的是全量门禁的
// 墙钟而不是失败信号；进 CI 或发布前检查即可。详见 `docs/testing.md` §1.1。
import { defineConfig } from 'vitest/config';
import { sharedTestOptions, sharedResolve, sharedEsbuild } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: ['tests/unit/app-start.test.ts', 'tests/unit/reactive-corpus-cli.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
  esbuild: sharedEsbuild,
  resolve: sharedResolve,
});
