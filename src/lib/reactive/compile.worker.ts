// ─────────────────────────────────────────────────────────────────────────────
// compile.worker.ts — ReactiveMD 编译 worker 入口（站点兼容层在 worker 内）
//
// 【兼容扫描必须在 worker 内】`applyLegacyHtmlCompat` 对 200k 混合正文实测约
// 25ms（等长扫描，不是编译）；放到主线程的每次按键上仍然是可感的卡顿。这里给
// 上游 session 包一层：收到的源码先过兼容层再编译。兼容层保证**与输入等长**，
// 所以 worker 的增量 edit / revision 协议仍然成立（源码偏移不变）。
//
// 编译选项仍由主线程随每条消息下发；worker 自己不持有一份，避免两处选项静默
// 不一致。worker 不可用时调度器会退回主线程 `compileLocal`（那条路径由调用方
// 自己先做 compat，见 client-compile / format-observer）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  createLocalCompileSession,
  startLocalCompileWorker,
  type LocalCompileWorkerScope,
} from 'reactive-md';
import { applyLegacyHtmlCompat } from './legacy-compat';

const session = createLocalCompileSession();
const compile = session.compile.bind(session);
const compileShared = session.compileShared.bind(session);

session.compile = (source, options) => compile(applyLegacyHtmlCompat(source).source, options);
session.compileShared = (source, options) =>
  compileShared(applyLegacyHtmlCompat(source).source, options);

startLocalCompileWorker(self as unknown as LocalCompileWorkerScope, {
  createSession: () => session,
});
