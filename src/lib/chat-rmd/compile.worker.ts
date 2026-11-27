// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/compile.worker.ts — 聊天编译 Worker 入口（上游 handler）
//
// 0.9.3 起 Worker 侧只安装 `startLocalCompileWorker()`：多文档会话、按文档的
// revision 链、增量 patch-v1 与空闲清理都由上游 handler 维护，聊天不再自建
// Worker 协议。聊天策略（embedding 档位、文档收缩）与缓存身份在主线程
// `compile-manager` 完成；Worker 只接收源码、编译选项与 revision，不接收
// cookie、用户资料或权限数据。
//
// 本文件是 Worker 专用入口：被普通页面 import 时上游会尝试在 window 上安装
// onmessage，不要在视图或服务端模块里引用它。
// ─────────────────────────────────────────────────────────────────────────────

import {
  startLocalCompileWorker,
  type LocalCompileWorkerScope,
} from 'reactive-md';

// 显式传入 Worker 作用域，与 `src/lib/reactive/compile.worker.ts` 一致：
// 不依赖上游对 globalThis 的默认取值，模块 Worker 里始终是 self。
startLocalCompileWorker(self as unknown as LocalCompileWorkerScope);