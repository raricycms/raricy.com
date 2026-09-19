// ─────────────────────────────────────────────────────────────────────────────
// instrumentation.ts — Next 的进程启动钩子（本站**唯一**的后台任务入口）
//
// register() 在服务进程启动时被 Next 调一次，是本站第一个「不在请求里跑的」代码。
// 目前只做一件事：起回调投递的定时器。
//
// ⚠️ 三条纪律
//   1. **只在这里启动**，不要在某个模块里「被 import 时自动启动」—— vitest 会直接
//      import src/lib/*，那样每个测试文件都会起一个后台循环去发真实 HTTP。
//   2. 用动态 import：register() 在 edge 与 nodejs 两个 runtime 都会被调用，
//      而 webhook-drainer 拖着 prisma（node-only）。顶层静态 import 会让 edge 构建
//      期就炸。
//   3. 这里**不能抛**。启动钩子里抛异常会让整个进程起不来 —— 而回调只是个附加
//      功能，不该有这个权限。所以整段包 try/catch，失败只记一行。
//
// 【agent 与进程边界】Next 15 里 instrumentation 在**每个** server 进程启动时跑一次
// （本项目单进程，见 docs/architecture.md §2）。多实例部署时会各起一个 drainer：
// 投递不会重复（认领是条件 UPDATE），只是多几次空扫。
// ─────────────────────────────────────────────────────────────────────────────

export async function register(): Promise<void> {
  // ★ 动态 import 必须写在 if 块**里面** ★
  //   本文件会被 Next **同时**编译给 nodejs 与 edge 两个 runtime。`NEXT_RUNTIME`
  //   在构建期被替换成字面量，于是 edge 那一份里这个 if 是 `if ('edge' === 'nodejs')`
  //   —— 整块被消掉，`node:dns` / `node:https` 才不会进 edge 的包。
  //   写成「早退 return + 块外 await import(...)」是不行的：webpack 不会把
  //   return 之后的语句当死代码删掉，构建会以
  //   `UnhandledSchemeError: Reading from "node:https" is not handled` 失败（实测）。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startWebhookDrainer } = await import('./lib/webhook-drainer');
      startWebhookDrainer();
    } catch (e) {
      // 绝不因为回调的启动失败而拖垮整个站点
      console.error('[instrumentation] 回调投递定时器启动失败（站点继续运行）:', e);
    }
  }
}
