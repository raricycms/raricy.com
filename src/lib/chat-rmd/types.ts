// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/types.ts — 聊天 ReactiveMD 编译与引用适配的共享接口（M0 冻结）
//
// 浏览器侧模块：编译管理器（compile-manager）、文档策略（document-policy）、
// 引用适配（references）和 React 视图（ChatRmd*）都只依赖这里的形状，避免各自
// 漂移。类型可以 import reactive-md 的 `LocalDocument`（纯类型，运行时擦除）。
//
// 不要在这里塞服务端对象、React 组件或取数实现。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalDocument } from 'reactive-md';

export type ChatSourcePhase = 'streaming' | 'final';

/** 视口内优先；nearby 只在可见任务清空后处理。 */
export type ChatCompilePriority = 'visible' | 'nearby';

export interface ChatCompileRequest {
  /** 页面内唯一：正式消息用 `msg:<id>`，生成任务用 `gen:<generation_id>`。 */
  key: string;
  /** 同一 key 的源码版本；单调递增，旧结果不得覆盖新结果。 */
  revision: number;
  source: string;
  phase: ChatSourcePhase;
  priority: ChatCompilePriority;
}

export interface ChatCompiledSnapshot {
  key: string;
  revision: number;
  phase: ChatSourcePhase;
  /** 成功时的编译文档；失败/取消时为 null，调用方显示转义源码。 */
  document: LocalDocument | null;
  /** 稳定诊断码（如 `local.budget`、`worker.error`），不展示给用户。 */
  errorCode: string | null;
}

export type ChatCompileListener = (snapshot: ChatCompiledSnapshot) => void;

/** 页面级编译管理器：一个 Chat 页面一个 Worker，多文档订阅互不覆盖。 */
export interface ChatCompileManager {
  subscribe(request: ChatCompileRequest, listener: ChatCompileListener): () => void;
  /**
   * 可选：空闲时预创建 Worker，缩短首条消息的冷启动等待。
   * 只预创建 Worker，不入队、不编译；预热失败静默，不影响后续 subscribe
   * （首次订阅仍按既有逻辑创建或重试）。
   */
  warmup?(): void;
  /**
   * 可选：滚动期暂停 / 恢复**新任务**的派发。只影响排队任务何时交给 Worker，
   * 不取消在途编译，结果照常投递（结果提交层的降优先级由视图另行处理）。
   */
  setScrolling?(active: boolean): void;
  /** 释放 Worker、队列与缓存；provider 卸载时调用。 */
  dispose(): void;
}

/**
 * 引用适配后的不可变结果。`document` 已把受控引用节点改写成宿主组件，
 * `hostData` 以槽位 id 为键（同一资源出现两次不能共享失败状态）。
 */
export interface ChatReferenceDocument {
  document: LocalDocument;
  hostData: Record<string, unknown>;
  /** 满足裸图规则的候选槽位；由宿主层结合 DTO 与媒体失败状态决定最终类名。 */
  bareImageCandidateSlot: string | null;
}

/** 单条消息的引用预算（§4 兼容矩阵）。 */
export interface ChatReferenceBudget {
  images: number;
  audio: number;
  stickers: number;
  users: number;
  clipboard: number;
}

export interface ChatReferenceContext {
  /** 查看者作用域（用户 id 或页面会话令牌），用于取数去重与切号清理。 */
  viewerScope: string;
  signal: AbortSignal;
  /** 子剪贴板重新排队编译；父文档不得占着唯一执行槽等待。 */
  compileChild: (source: string, signal: AbortSignal) => Promise<LocalDocument | null>;
  budget: ChatReferenceBudget;
  /** 0 = 父正文；>=1 的子剪贴板不再展开剪贴板。 */
  depth: number;
}