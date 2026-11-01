import path from 'node:path';

// vite-node 的**运维专用**最小配置。
//
// 为什么不复用 vitest.config.ts：那份配置会自动带上测试用的 globalSetup / setupFiles，
// 而迁移数据阶段是运维 CLI，绝不能被测试环境（尤其 DATABASE_URL）潜移默化地接管。
// 这里只保留源码需要的别名；ESM-only 的 reactive-md 由 vite-node 正常解析。
//
// 【不写 defineConfig】项目根没有直接安装 `vite`（它嵌套在 vite-node 里），
// 从 'vite' import 会在加载配置时 MODULE_NOT_FOUND。导出一个普通对象即可。
export default {
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, '../src') },
  },
};
