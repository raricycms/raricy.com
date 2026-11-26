// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/compile-manager.ts — 聊天页面的多文档编译管理器
//
// 一个页面一个 Manager / 一个 Worker（Worker 串行执行）。与上游
// `LocalCompileScheduler` 的 latest-wins 不同，这里按 key（消息 / 生成任务）保存
// 独立队列：300 条历史不会互相顶掉，同一 key 只保留最新待编译 revision。
//
// 职责边界：
//   · 调度：visible final → 生成中的最新快照 → nearby，流式与历史轮转防饥饿；
//   · 顺序：Manager 层按 revision / phase 丢弃过期结果，final 不被旧 streaming 覆盖；
//   · 缓存：只缓存 final 成功文档（300 条 / 16 MiB），流式结果不缓存；
//   · 滚动抑制：`setScrolling(true)` 期间不派发新任务（在途编译与结果投递不变），
//     `setScrolling(false)` 立即恢复排队任务的派发；
//   · 资源：短暂离订阅时保留 Worker 会话供同 key 快照续用；dispose 才 terminate。
//
// 不在模块顶层访问 window / Worker；SSR import 时只注册工厂，首次 subscribe 或
// warmup() 才建 Worker（warmup 只预创建，不改变调度 / 缓存 / 失败判定语义）。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileResult, LocalDocument } from 'reactive-md';
import { BoundedLruCache } from '../reactive/bounded-cache';
import {
  CHAT_RMD_COMPILER_VERSION,
  CHAT_RMD_OPTIONS_VERSION,
} from './options';
import { CHAT_RMD_POLICY_VERSION } from './document-policy';
import type {
  ChatCompileListener,
  ChatCompileManager,
  ChatCompileRequest,
  ChatCompiledSnapshot,
  ChatSourcePhase,
} from './types';

/** Worker 内编译超时；超时视为 Worker 卡死，终止并按有限次数重建。 */
export const CHAT_RMD_COMPILE_TIMEOUT_MS = 10_000;

/** Worker 运行时崩溃后的最大重建次数（不含首次创建）。 */
const CHAT_RMD_MAX_WORKER_RESTARTS = 1;

const CHAT_RMD_FINAL_CACHE_MAX_ENTRIES = 300;
const CHAT_RMD_FINAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CHAT_RMD_SESSION_RELEASE_GRACE_MS = 1_000;

// ── Worker 协议（自定义；不包上游 startLocalCompileWorker）────────────────────

export interface ChatCompileWorkerLike {
  postMessage(message: ChatWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
}

export type ChatCompileWorkerFactory = () => ChatCompileWorkerLike;

export type ChatWorkerRequest =
  | {
      type: 'compile';
      id: number;
      key: string;
      revision: number;
      source: string;
      phase: ChatSourcePhase;
    }
  | { type: 'release'; key: string }
  | { type: 'dispose' };

export type ChatWorkerResponse =
  | {
      type: 'result';
      id: number;
      key: string;
      revision: number;
      phase: ChatSourcePhase;
      result: LocalCompileResult;
    }
  | {
      type: 'error';
      id: number;
      key: string;
      revision: number;
      phase: ChatSourcePhase;
      code: string;
      message: string;
    };

// ── final 缓存 ────────────────────────────────────────────────────────────────

function estimateDocumentBytes(document: LocalDocument): number | null {
  try {
    const encoded = JSON.stringify(document);
    return typeof encoded === 'string' ? encoded.length : null;
  } catch {
    return null;
  }
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * final 缓存键：源码身份（长度 + 32 位哈希）+ RMD / Chat 配置 / 文档策略版本。
 * 哈希只用于定位；命中后仍必须核对完整源码（见 `ChatFinalCache.lookup`）。
 */
export function chatCompileIdentity(source: string): string {
  const hash = fnv1a32(source).toString(16).padStart(8, '0');
  return [
    'chat-rmd',
    CHAT_RMD_COMPILER_VERSION,
    CHAT_RMD_OPTIONS_VERSION,
    CHAT_RMD_POLICY_VERSION,
    `${source.length}:${hash}`,
  ].join('|');
}

interface ChatFinalCacheEntry {
  source: string;
  document: LocalDocument;
}

/** 有界 final 文档缓存；`identity` 参数用于测试「哈希撞车后核对源码」。 */
export class ChatFinalCache {
  private readonly cache: BoundedLruCache<ChatFinalCacheEntry>;

  constructor(limits: { maxEntries?: number; maxBytes?: number } = {}) {
    this.cache = new BoundedLruCache<ChatFinalCacheEntry>({
      maxEntries: limits.maxEntries ?? CHAT_RMD_FINAL_CACHE_MAX_ENTRIES,
      maxBytes: limits.maxBytes ?? CHAT_RMD_FINAL_CACHE_MAX_BYTES,
      sizeOf: (entry) => estimateDocumentBytes(entry.document),
    });
  }

  store(source: string, document: LocalDocument, identity = chatCompileIdentity(source)): boolean {
    return this.cache.set(identity, { source, document });
  }

  lookup(source: string, identity = chatCompileIdentity(source)): LocalDocument | undefined {
    const entry = this.cache.get(identity);
    if (!entry) return undefined;
    // 哈希命中不代表源码一致：碰撞或版本键构造错误时宁可重编译。
    if (entry.source !== source) return undefined;
    return entry.document;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

type QueueBucket = 'visible-final' | 'streaming' | 'nearby';

interface QueueEntry {
  key: string;
  request: ChatCompileRequest;
  bucket: QueueBucket;
}

interface Subscription {
  id: number;
  request: ChatCompileRequest;
  listener: ChatCompileListener;
}

interface InFlight {
  id: number;
  request: ChatCompileRequest;
  state: KeyState;
  timer: ReturnType<typeof setTimeout> | null;
}

interface KeyState {
  key: string;
  subs: Map<number, Subscription>;
  latest: ChatCompileRequest | null;
  queued: QueueEntry | null;
  inFlight: InFlight | null;
  delivered: { revision: number; phase: ChatSourcePhase } | null;
  releaseAfterFlight: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidRequest(request: ChatCompileRequest): boolean {
  return (
    isRecord(request) &&
    typeof request.key === 'string' &&
    request.key.length > 0 &&
    request.key.length <= 512 &&
    typeof request.source === 'string' &&
    Number.isSafeInteger(request.revision) &&
    request.revision >= 0
  );
}

function normalizeRequest(request: ChatCompileRequest): ChatCompileRequest {
  return {
    key: request.key,
    revision: request.revision,
    source: request.source,
    phase: request.phase === 'streaming' ? 'streaming' : 'final',
    priority: request.priority === 'visible' ? 'visible' : 'nearby',
  };
}

function bucketOf(request: ChatCompileRequest): QueueBucket {
  if (request.phase !== 'final') return 'streaming';
  return request.priority === 'visible' ? 'visible-final' : 'nearby';
}

function phaseRank(phase: ChatSourcePhase): number {
  return phase === 'final' ? 2 : 1;
}

function priorityRank(priority: ChatCompileRequest['priority']): number {
  return priority === 'visible' ? 2 : 1;
}

function compareRequests(a: ChatCompileRequest, b: ChatCompileRequest): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const phase = phaseRank(a.phase) - phaseRank(b.phase);
  if (phase !== 0) return phase;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

function sameCompile(
  a: Pick<ChatCompileRequest, 'revision' | 'phase' | 'source'>,
  b: Pick<ChatCompileRequest, 'revision' | 'phase' | 'source'>
): boolean {
  return a.revision === b.revision && a.phase === b.phase && a.source === b.source;
}

function compileErrorCode(result: Extract<LocalCompileResult, { ok: false }>): string {
  const diagnostic =
    result.diagnostics.find((entry) => entry.severity === 'error') ?? result.diagnostics[0];
  return diagnostic?.code ?? 'local.compile';
}

function parseWorkerResponse(data: unknown): ChatWorkerResponse | null {
  if (!isRecord(data)) return null;
  if (data.type !== 'result' && data.type !== 'error') return null;
  if (
    typeof data.id !== 'number' ||
    typeof data.key !== 'string' ||
    typeof data.revision !== 'number' ||
    (data.phase !== 'streaming' && data.phase !== 'final')
  ) {
    return null;
  }
  if (data.type === 'error') {
    if (typeof data.code !== 'string' || data.code.length === 0) return null;
    if (typeof data.message !== 'string') return null;
  } else if (!isRecord(data.result) || typeof data.result.ok !== 'boolean') {
    return null;
  }
  return data as unknown as ChatWorkerResponse;
}

function notify(listener: ChatCompileListener, snapshot: ChatCompiledSnapshot): void {
  try {
    listener(snapshot);
  } catch {
    // 单个订阅者的渲染异常不能中断其他消息或调度。
  }
}

export function createChatCompileManager(
  workerFactory: ChatCompileWorkerFactory = defaultWorkerFactory
): ChatCompileManager {
  const keys = new Map<string, KeyState>();
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: Record<QueueBucket, QueueEntry[]> = {
    'visible-final': [],
    streaming: [],
    nearby: [],
  };
  const inFlight = new Map<number, InFlight>();
  const cache = new ChatFinalCache();

  let worker: ChatCompileWorkerLike | null = null;
  let workerFailures = 0;
  let unavailable = false;
  let disposed = false;
  let nextId = 1;
  let roundRobinStreaming = true;
  /** 滚动期暂停新任务派发；在途任务与结果投递不受影响。 */
  let scrollingPaused = false;

  function getKeyState(key: string): KeyState {
    const releaseTimer = releaseTimers.get(key);
    if (releaseTimer !== undefined) {
      clearTimeout(releaseTimer);
      releaseTimers.delete(key);
    }
    let state = keys.get(key);
    if (!state) {
      state = {
        key,
        subs: new Map(),
        latest: null,
        queued: null,
        inFlight: null,
        delivered: null,
        releaseAfterFlight: false,
      };
      keys.set(key, state);
    }
    return state;
  }

  function updateLatest(state: KeyState): void {
    let latest: ChatCompileRequest | null = null;
    for (const sub of state.subs.values()) {
      if (!latest || compareRequests(sub.request, latest) > 0) latest = sub.request;
    }
    state.latest = latest;
  }

  function removeQueueEntry(state: KeyState): void {
    const entry = state.queued;
    if (!entry) return;
    state.queued = null;
    const bucket = queue[entry.bucket];
    const index = bucket.indexOf(entry);
    if (index >= 0) bucket.splice(index, 1);
  }

  function enqueueLatest(state: KeyState): void {
    const latest = state.latest;
    if (!latest) return;
    if (state.inFlight && sameCompile(state.inFlight.request, latest)) return;
    if (state.queued) {
      state.queued.request = latest;
      const bucket = bucketOf(latest);
      if (state.queued.bucket !== bucket) {
        const previous = queue[state.queued.bucket];
        const index = previous.indexOf(state.queued);
        if (index >= 0) previous.splice(index, 1);
        state.queued.bucket = bucket;
        queue[bucket].push(state.queued);
      }
      return;
    }
    const entry: QueueEntry = { key: state.key, request: latest, bucket: bucketOf(latest) };
    state.queued = entry;
    queue[entry.bucket].push(entry);
  }

  function takeNextEntry(): QueueEntry | null {
    const visibleFinal = queue['visible-final'].shift();
    if (visibleFinal) return visibleFinal;

    const streaming = queue.streaming;
    const nearby = queue.nearby;
    if (streaming.length > 0 && nearby.length > 0) {
      const pickStreaming = roundRobinStreaming;
      roundRobinStreaming = !roundRobinStreaming;
      return pickStreaming ? streaming.shift()! : nearby.shift()!;
    }
    return streaming.shift() ?? nearby.shift() ?? null;
  }

  function postToWorker(message: ChatWorkerRequest): void {
    if (!worker) return;
    try {
      worker.postMessage(message);
    } catch {
      handleWorkerFailure('worker.error');
    }
  }

  function sendRelease(key: string): void {
    if (!worker) return;
    postToWorker({ type: 'release', key });
  }

  function failRequest(state: KeyState, request: ChatCompileRequest, code: string): void {
    const latest = state.latest;
    if (!latest || latest.revision !== request.revision || latest.source !== request.source) {
      return;
    }
    const snapshot: ChatCompiledSnapshot = {
      key: request.key,
      revision: request.revision,
      phase: request.phase,
      document: null,
      errorCode: code,
    };
    for (const sub of state.subs.values()) {
      if (sub.request.revision > request.revision) continue;
      notify(sub.listener, snapshot);
    }
  }

  function drainUnavailable(): void {
    for (const bucketName of ['visible-final', 'streaming', 'nearby'] as const) {
      const entries = queue[bucketName];
      while (entries.length > 0) {
        const entry = entries.shift()!;
        const state = keys.get(entry.key);
        if (!state || state.queued !== entry) continue;
        state.queued = null;
        failRequest(state, entry.request, 'worker.unavailable');
      }
    }
  }

  function ensureWorker(): ChatCompileWorkerLike {
    if (worker) return worker;
    const created = workerFactory();
    if (
      !created ||
      typeof created.postMessage !== 'function' ||
      typeof created.terminate !== 'function'
    ) {
      throw new Error('chat-rmd: invalid worker');
    }
    created.onmessage = (event) => onWorkerMessage(event?.data);
    created.onerror = () => handleWorkerFailure('worker.error');
    created.onmessageerror = () => handleWorkerFailure('worker.error');
    worker = created;
    return created;
  }

  function onWorkerMessage(data: unknown): void {
    if (disposed) return;
    const message = parseWorkerResponse(data);
    if (!message) return;

    const record = inFlight.get(message.id);
    if (!record) return;

    if (
      message.key !== record.request.key ||
      message.revision !== record.request.revision ||
      message.phase !== record.request.phase
    ) {
      handleWorkerFailure('worker.error');
      return;
    }

    if (record.timer !== null) clearTimeout(record.timer);
    inFlight.delete(message.id);
    record.state.inFlight = null;

    const state = record.state;
    if (canDeliver(state, message, record.request)) {
      const snapshot: ChatCompiledSnapshot =
        message.type === 'result'
          ? {
              key: message.key,
              revision: message.revision,
              phase: message.phase,
              document: message.result.ok ? message.result.document : null,
              errorCode: message.result.ok ? null : compileErrorCode(message.result),
            }
          : {
              key: message.key,
              revision: message.revision,
              phase: message.phase,
              document: null,
              errorCode: message.code,
            };

      if (message.type === 'result' && message.result.ok && message.phase === 'final') {
        cache.store(record.request.source, message.result.document);
      }

      markDelivered(state, message.revision, message.phase);
      for (const sub of state.subs.values()) {
        if (sub.request.revision > message.revision) continue;
        if (message.phase === 'streaming' && sub.request.phase === 'final') continue;
        notify(sub.listener, snapshot);
      }
    }

    const finishedFinal = message.phase === 'final';
    if (finishedFinal && !state.queued) {
      // Worker 在 final 后已自行释放会话；这里保持与 worker 的显式约定一致。
      sendRelease(state.key);
    } else if (state.releaseAfterFlight && !state.queued && !state.inFlight) {
      sendRelease(state.key);
    }

    pump();
  }

  function canDeliver(
    state: KeyState,
    message: ChatWorkerResponse,
    request: ChatCompileRequest
  ): boolean {
    if (state.subs.size === 0) return false;
    const latest = state.latest;
    if (!latest) return false;
    if (latest.revision !== message.revision || latest.source !== request.source) return false;
    if (message.phase === 'streaming' && latest.phase === 'final') return false;
    const delivered = state.delivered;
    if (delivered) {
      if (message.phase === 'streaming' && delivered.phase === 'final') return false;
      if (message.revision < delivered.revision) return false;
      if (
        message.revision === delivered.revision &&
        !(message.phase === 'final' && delivered.phase === 'streaming')
      ) {
        return false;
      }
    }
    return true;
  }

  function markDelivered(state: KeyState, revision: number, phase: ChatSourcePhase): void {
    const delivered = state.delivered;
    if (!delivered) {
      state.delivered = { revision, phase };
      return;
    }
    if (revision > delivered.revision) {
      state.delivered = { revision, phase };
      return;
    }
    if (revision === delivered.revision && phase === 'final' && delivered.phase === 'streaming') {
      state.delivered = { revision, phase };
    }
  }

  function takeInFlightRecord(): InFlight | null {
    const iterator = inFlight.values().next();
    if (iterator.done) return null;
    const record = iterator.value;
    inFlight.delete(record.id);
    if (record.timer !== null) clearTimeout(record.timer);
    record.state.inFlight = null;
    return record;
  }

  function handleWorkerFailure(code: 'worker.error' | 'timeout'): void {
    if (disposed) return;
    const current = worker;
    worker = null;
    if (current) {
      try {
        current.onmessage = null;
        current.onerror = null;
        current.onmessageerror = null;
        current.terminate();
      } catch {
        // terminate 失败不再放大。
      }
    }
    workerFailures += 1;
    const record = takeInFlightRecord();
    if (record) failRequest(record.state, record.request, code);
    if (workerFailures > CHAT_RMD_MAX_WORKER_RESTARTS) {
      unavailable = true;
      drainUnavailable();
      return;
    }
    pump();
  }

  function handleTimeout(id: number): void {
    if (disposed) return;
    const record = inFlight.get(id);
    if (!record) return;
    handleWorkerFailure('timeout');
  }

  function pump(): void {
    if (disposed || inFlight.size > 0) return;
    if (unavailable) {
      drainUnavailable();
      return;
    }
    // 滚动期不取新任务：队列原样保留，恢复后按既有优先级继续；在途结果已由
    // onWorkerMessage 照常投递，提交层负责降低滚动期间的渲染优先级。
    if (scrollingPaused) return;

    const entry = takeNextEntry();
    if (!entry) return;

    const state = keys.get(entry.key);
    if (
      !state ||
      state.queued !== entry ||
      !state.latest ||
      state.latest.revision !== entry.request.revision ||
      state.latest.source !== entry.request.source
    ) {
      pump();
      return;
    }
    state.queued = null;

    let activeWorker: ChatCompileWorkerLike;
    try {
      activeWorker = ensureWorker();
    } catch {
      unavailable = true;
      failRequest(state, entry.request, 'worker.unavailable');
      drainUnavailable();
      return;
    }

    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => handleTimeout(id), CHAT_RMD_COMPILE_TIMEOUT_MS);
    const record: InFlight = { id, request: entry.request, state, timer };
    state.inFlight = record;
    inFlight.set(id, record);

    try {
      activeWorker.postMessage({
        type: 'compile',
        id,
        key: entry.request.key,
        revision: entry.request.revision,
        source: entry.request.source,
        phase: entry.request.phase,
      });
    } catch {
      handleWorkerFailure('worker.error');
    }
  }

  function unsubscribe(state: KeyState, subscription: Subscription): void {
    if (disposed) return;
    if (!state.subs.delete(subscription.id)) return;
    updateLatest(state);

    if (state.subs.size === 0) {
      removeQueueEntry(state);
      state.releaseAfterFlight = false;
      keys.delete(state.key);
      const previousTimer = releaseTimers.get(state.key);
      if (previousTimer !== undefined) clearTimeout(previousTimer);
      releaseTimers.set(
        state.key,
        setTimeout(() => {
          releaseTimers.delete(state.key);
          if (!disposed && !keys.has(state.key)) sendRelease(state.key);
        }, CHAT_RMD_SESSION_RELEASE_GRACE_MS)
      );
      return;
    }

    enqueueLatest(state);
    pump();
  }

  function subscribe(request: ChatCompileRequest, listener: ChatCompileListener): () => void {
    if (disposed) return () => {};

    if (!isValidRequest(request) || typeof listener !== 'function') {
      const snapshot: ChatCompiledSnapshot = {
        key: typeof request?.key === 'string' ? request.key : '',
        revision: typeof request?.revision === 'number' ? request.revision : 0,
        phase: request?.phase === 'streaming' ? 'streaming' : 'final',
        document: null,
        errorCode: 'request.invalid',
      };
      queueMicrotask(() => notify(listener, snapshot));
      return () => {};
    }

    const normalized = normalizeRequest(request);
    const state = getKeyState(normalized.key);
    const subscription: Subscription = { id: nextId, request: normalized, listener };
    nextId += 1;
    state.subs.set(subscription.id, subscription);
    updateLatest(state);

    if (normalized.phase === 'final') {
      const cached = cache.lookup(normalized.source);
      if (cached) {
        const latest = state.latest;
        if (latest && sameCompile(latest, normalized)) removeQueueEntry(state);
        markDelivered(state, normalized.revision, 'final');
        notify(listener, {
          key: normalized.key,
          revision: normalized.revision,
          phase: 'final',
          document: cached,
          errorCode: null,
        });
        return () => unsubscribe(state, subscription);
      }
    }

    enqueueLatest(state);
    pump();
    return () => unsubscribe(state, subscription);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const record of inFlight.values()) {
      if (record.timer !== null) clearTimeout(record.timer);
    }
    inFlight.clear();
    for (const timer of releaseTimers.values()) clearTimeout(timer);
    releaseTimers.clear();
    for (const state of keys.values()) {
      state.inFlight = null;
      state.queued = null;
      state.subs.clear();
    }
    keys.clear();
    queue['visible-final'].length = 0;
    queue.streaming.length = 0;
    queue.nearby.length = 0;
    cache.clear();
    const current = worker;
    worker = null;
    if (current) {
      try {
        current.onmessage = null;
        current.onerror = null;
        current.onmessageerror = null;
        current.terminate();
      } catch {
        // 重复调用 dispose 或已崩溃的 Worker 不再抛。
      }
    }
  }

  /**
   * 预创建 Worker，缩短首条消息的冷启动等待；不改变编译语义。
   * `ensureWorker` 幂等：已有 Worker 直接复用，不会多建或 terminate。
   * 不排队、不写缓存、不动 workerFailures / unavailable；失败静默吞掉，
   * 等首次 subscribe 走 `pump()` 的既有路径重试并决定是否 unavailable。
   */
  function warmup(): void {
    if (disposed) return;
    try {
      ensureWorker();
    } catch {
      // 静默：预热失败不向调用方抛，也不标记 unavailable。
    }
  }

  /**
   * 滚动期暂停 / 恢复**新任务**派发：置位后 `pump()` 不再取新任务，`false` 时
   * 立即 `pump()` 恢复。不取消在途 Worker 编译，结果照常投递；不改优先级 /
   * 缓存 / 失败预算语义。dispose 后为 no-op（订阅清理竞态下仍可能被调用）。
   */
  function setScrolling(active: boolean): void {
    if (disposed) return;
    if (scrollingPaused === active) return;
    scrollingPaused = active;
    if (!active) pump();
  }

  return { subscribe, warmup, dispose, setScrolling };
}

/**
 * 默认 Worker 工厂。`new URL('./compile.worker.ts', …)` 必须保持字面量相对路径，
 * webpack 靠它静态打包 Worker 入口。
 */
function defaultWorkerFactory(): ChatCompileWorkerLike {
  if (typeof Worker === 'undefined') throw new Error('chat-rmd: Worker unavailable');
  return new Worker(new URL('./compile.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as ChatCompileWorkerLike;
}
