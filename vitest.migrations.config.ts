// `npm run test:migrations` —— 空库全量 SQL 迁移验收。
//
// 【为什么单独入口】每条迁移都 spawn 一次 `prisma db execute`（43 次，单次冷启动实测
// 4.1s），空库全量 up 在空闲机上约 124s，并发跑全量时会被打穿 300s 上限。它属于
// 部署验收（改了 prisma/schema 或 migrations 时跑），不该占日常门禁。
// 详见 `docs/testing.md` §1.1。
import { defineConfig } from 'vitest/config';
import { sharedTestOptions, sharedResolve, sharedEsbuild } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: ['tests/service/migrate-entry.test.ts'],
    // 保留 300s 上限：它保护的是「迁移真挂起」；真挂起仍然要被发现。
    testTimeout: 300_000,
    hookTimeout: 300_000,
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
  esbuild: sharedEsbuild,
  resolve: sharedResolve,
});
