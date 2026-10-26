// ─────────────────────────────────────────────────────────────────────────────
// compile.worker.ts — ReactiveMD 编译 worker 入口
//
// 只做一件事：把上游的编译处理器装到当前 worker 全局对象上。`LocalCompileScheduler`
// 在 worker 不可用或崩溃时会退回主线程 `compileLocal`，所以这里不需要任何兜底。
// 编译选项由主线程随每条消息下发（`reactiveCompileOptions('reactive')`），
// worker 自身不持有一份——两处各写一份就会在改选项时静默不一致。
// ─────────────────────────────────────────────────────────────────────────────

import { startLocalCompileWorker } from 'reactive-md';

startLocalCompileWorker();
