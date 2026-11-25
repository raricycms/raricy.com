// Vitest 公共配置：全量、guards、migrations、slow、fast 五套入口共用同一环境与超时口径。
//
// 【为什么抽公共层】`npm test` 只跑「日常门禁」；静态守卫、空库全量迁移验收、启动
// 生命周期这类用例不该占默认门禁（详见 `docs/testing.md` §1.1），但它们的
// environment / setupFiles / 超时口径必须与全量一致，否则「单跑绿、全量红」会换个地方重演。
//
// 【别在这里放 include/exclude】各入口的选面不同，只放共享项。
import path from 'node:path';

/** 与 4 worker 实测口径一致：默认 8 核留余量，重计时用例（bcrypt/scrypt 等）不易撞线。 */
export const MAX_WORKERS = Number(process.env.VITEST_MAX_WORKERS ?? 4);

export const sharedTestOptions = {
  // 默认 node 环境；需要 DOM 的用例在文件顶部用 // @vitest-environment jsdom 覆盖
  environment: 'node',
  globals: false,
  // 文件级并行。各测试文件的库由 tests/setup.ts 按 pid + 随机串生成，互不共享。
  fileParallelism: true,
  minWorkers: 1,
  maxWorkers: MAX_WORKERS,
  // 【为什么必须显式给超时】vitest 默认 5000ms。真实计时的用例（配额类：bcrypt +
  // 连建 200 个号等）单条就在 0.1–2.4s，并发时集体撞线。详见 vitest.config.ts 的注释。
  testTimeout: 30_000,
  hookTimeout: 30_000,
  // 建模板库（一次性）。各测试文件的库副本由 tests/helpers/db.ts 的 ensureSchema() 拷。
  globalSetup: ['tests/global-setup.ts'],
  setupFiles: ['tests/setup.ts'],
  coverage: {
    provider: 'v8' as const,
    include: ['src/lib/**/*.ts', 'src/middleware.ts'],
    exclude: ['src/lib/db.ts'],
  },
};

/** `@/` 别名与「组件用 JSX automatic 运行时」两边都要，否则组件用例会抛 React is not defined。 */
export const sharedResolve = {
  alias: { '@': path.resolve(import.meta.dirname, 'src') },
};

export const sharedEsbuild = { jsx: 'automatic' as const };
