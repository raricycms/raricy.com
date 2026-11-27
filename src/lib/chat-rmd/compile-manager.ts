// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/compile-manager.ts — 聊天页面的多文档编译管理器（上游 Worker 池）
//
// 一个 viewerScope 一个 Manager / 一个 `LocalCompilePool`（默认 1 个 Worker，跨路由复用）。池已经按
// documentId 维护 revision 链、增量会话、超时与失败回退；这里只保留聊天语义：
//   · 订阅：按 key 保存 subs / latest / delivered / attempted；final 命中本地缓存
//     时同步投递；
//   · 调度：把每个 key 的最新请求交给池；visible final=10、streaming=5、
//     nearby final=0，其余轮转与老化交给池的优先级队列；
//   · 顺序：旧 revision 丢弃；streaming 不覆盖已投递的 final；同一文档不重复通知；
//   · 收缩：池返回的文档先过 `applyChatDocumentPolicy`，失败投递
//     `policy.unsupported` 并显示源码；
//   · 缓存：只缓存 final 成功文档（300 条 / 16 MiB），身份由上游
//     `localCompileCacheKey`（源码 + 选项 + 配置 + 阶段 + 策略版本）承担；
//   · 降级：Worker 失败后上游池不会自愈，同一池的后续任务都会在主线程同步编译；
//     管理器先投递本次 fallback 结果，再重建一次池，重建用尽后投递
//     `worker.unavailable` 并停止派发（视图显示源码）；
//   · 压力：池队列回满（backpressure）是瞬时状态，不记为失败，退避重试，
//     用尽才投递 `pool.backpressure`；
//   · 滚动：`setScrolling(active)` 映射到池的 hold / resume（不取消在途编译）；
//   · 资源：最后一个订阅者离开后保留 1s 再 `pool.release(key)`，dispose 立即清。
//
// 【scheduleRevision】聊天请求的 revision 由视图给出，组件重挂后会从 1 重新开始；
// 上游池却要求同一 documentId 的 revision 单调递增。因此这里为每个 key 另外发一套
// 只增不减的 `scheduleRevision`（1 起步），只有 `pool.release(key)` 清空池内
// revision 链时才一起重置。
//
// 池只在首次 subscribe / warmup 时懒创建；模块顶层不访问 window / Worker，
// SSR import 时只注册工厂，没有副作用。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileResult, LocalCompileWorker, LocalDocument } from 'reactive-md';
import { localCompileCacheKey } from 'reactive-md/compiler/session';
import {
  LocalCompilePoolTaskError,
  createLocalCompilePool,
  type LocalCompilePool,
  type LocalCompilePoolOutcome,
  type LocalCompilePoolTaskErrorKind,
} from 'reactive-md/worker-pool';
import { BoundedLruCache } from '../reactive/bounded-cache';
import { CHAT_RMD_COMPILE_OPTIONS } from './options';
import {
  CHAT_RMD_POLICY_UNSUPPORTED,
  CHAT_RMD_POLICY_VERSION,
  applyChatDocumentPolicy,
} from './document-policy';
import type {
  ChatCompileListener,
  ChatCompileManager,
  ChatCompileRequest,
  ChatCompiledSnapshot,
  ChatSourcePhase,
} from './types';

/** 池内单次编译超时；超时由池终止 Worker 并转本地回退。 */
export const CHAT_RMD_COMPILE_TIMEOUT_MS = 10_000;

/** 池的待处理任务上限；聊天页面一次可挂 300 条历史，留足突发余量。 */
const CHAT_RMD_MAX_PENDING = 512;

const CHAT_RMD_FINAL_CACHE_MAX_ENTRIES = 300;
const CHAT_RMD_FINAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CHAT_RMD_SESSION_RELEASE_GRACE_MS = 1_000;

/**
 * Worker 全部失败后自动重建池的次数。上游池把失败 Worker 永久标记为 failed，
 * 同池后续任务都会在主线程同步编译；Worker 正常完成一次编译后预算恢复，
 * 持续 fallback 则不恢复，避免故障时无限重建。
 */
const CHAT_RMD_POOL_MAX_REBUILDS = 1;

/** backpressure 退避：从 200ms 起指数翻倍，最多重试 5 次（约 6.2s 窗口）。 */
const CHAT_RMD_BACKPRESSURE_RETRY_BASE_MS = 200;
const CHAT_RMD_BACKPRESSURE_MAX_RETRIES = 5;

/**
 * 重建预算用尽后的冷却：到点重新武装预算并重试订阅中的文档。Manager 会被
 * 跨路由复用 10 分钟，若用尽即永久停用，两次 Worker 超时就能让整段会话只剩源码。
 */
export const CHAT_RMD_POOL_RETRY_COOLDOWN_MS = 60_000;

/** Worker / 池不可用的稳定错误码；视图据此显示源码。 */
const CHAT_RMD_WORKER_UNAVAILABLE = 'worker.unavailable';

/** backpressure 重试用尽后的稳定错误码。 */
const CHAT_RMD_BACKPRESSURE_EXHAUSTED = 'pool.backpressure';

/** 池优先级：可见 final 最先，生成中的快照次之，离屏历史最后。 */
const CHAT_RMD_PRIORITY_VISIBLE_FINAL = 10;
const CHAT_RMD_PRIORITY_STREAMING = 5;
const CHAT_RMD_PRIORITY_NEARBY_FINAL = 0;

// ── final 缓存 ────────────────────────────────────────────────────────────────

function estimateDocumentBytes(document: LocalDocument): number | null {
  try {
    const encoded = JSON.stringify(document);
    return typeof encoded === 'string' ? encoded.length : null;
  } catch {
    return null;
  }
}

/**
 * final 缓存键：上游 `localCompileCacheKey` 组合精确源码、已验证选项、组件配置、
 * 生效阶段与聊天文档策略版本。键只用于定位；命中后仍必须核对完整源码
 * （见 `ChatFinalCache.lookup`）。
 */
export function chatCompileIdentity(source: string): string {
  return localCompileCacheKey(source, CHAT_RMD_COMPILE_OPTIONS, {
    entry: 'session',
    sourcePhase: 'final',
    policyVersion: CHAT_RMD_POLICY_VERSION,
  });
}

interface ChatFinalCacheEntry {
  source: string;
  document: LocalDocument;
}

/** 有界 final 文档缓存；`identity` 参数用于测试「键撞车后核对源码」。 */
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
    // 键命中不代表源码一致：碰撞或键构造错误时宁可重编译。
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

/** 一次编译请求的身份（不含 key / priority）。 */
type CompileStamp = Pick<ChatCompileRequest, 'revision' | 'phase' | 'source'>;

interface Subscription {
  id: number;
  request: ChatCompileRequest;
  listener: ChatCompileListener;
}

/** 已交给池的任务；`scheduleRevision` 是发给池的单调 revision。 */
interface ScheduledTask extends CompileStamp {
  scheduleRevision: number;
}

/** backpressure 退避重试；等待期间不写 attempted，内容变化或编译结束即作废。 */
interface BackpressureRetry {
  stamp: CompileStamp;
  /** 已安排的退避次数；跨重试派发保留，指数延迟按它计算。 */
  attempts: number;
  /** 待触发的退避计时器；`null` 表示计时器已触发、正在重新派发。 */
  timer: ReturnType<typeof setTimeout> | null;
}

interface KeyState {
  key: string;
  subs: Map<number, Subscription>;
  /** 所有订阅者里最大（revision → phase → priority）的请求。 */
  latest: ChatCompileRequest | null;
  /** 最近一次真正投递（含错误投递）过的编译身份。 */
  delivered: CompileStamp | null;
  /** 最近一次编译结束的身份（可能因顺序规则未投递）；避免对同一身份反复入池。 */
  attempted: CompileStamp | null;
  /** 已交给池、尚未 settle 的任务；同一身份不重复排队。 */
  scheduled: ScheduledTask | null;
  /** 正在等待退避的 backpressure 重试；同一 key 同时至多一个。 */
  backpressureRetry: BackpressureRetry | null;
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

function sameCompile(a: CompileStamp, b: CompileStamp): boolean {
  return a.revision === b.revision && a.phase === b.phase && a.source === b.source;
}

function compileErrorCode(result: Extract<LocalCompileResult, { ok: false }>): string {
  const diagnostic =
    result.diagnostics.find((entry) => entry.severity === 'error') ?? result.diagnostics[0];
  return diagnostic?.code ?? 'local.compile';
}

/** 池任务失败的稳定错误码；只用于投递，不展示给用户。 */
function poolTaskErrorCode(kind: LocalCompilePoolTaskErrorKind | null): string {
  switch (kind) {
    case 'worker-failed':
      return CHAT_RMD_WORKER_UNAVAILABLE;
    case 'invalid-request':
      return 'request.invalid';
    case 'source-too-large':
      return 'local.budget';
    default:
      return 'local.compile';
  }
}

function notify(listener: ChatCompileListener, snapshot: ChatCompiledSnapshot): void {
  try {
    listener(snapshot);
  } catch {
    // 单个订阅者的渲染异常不能中断其他消息或调度。
  }
}

export interface ChatCompileManagerOptions {
  /** 测试缝：替换默认 Worker 池工厂；生产不传，首次订阅时才创建。 */
  createPool?: () => LocalCompilePool;
}

export function createChatCompileManager(
  options: ChatCompileManagerOptions = {}
): ChatCompileManager {
  const createPool = options.createPool ?? defaultPoolFactory;
  const keys = new Map<string, KeyState>();
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每 key 发给池的单调 revision，跨订阅状态重建保留，直到 pool.release。 */
  const scheduleRevisions = new Map<string, number>();
  const cache = new ChatFinalCache();

  let pool: LocalCompilePool | null = null;
  let disposed = false;
  /** 重建预算用尽后不再创建池：上游对失败 Worker 的兜底是主线程同步编译。 */
  let poolUnavailable = false;
  let poolRebuildsRemaining = CHAT_RMD_POOL_MAX_REBUILDS;
  /** 预算用尽后的冷却计时器；到点重新允许建池并重试订阅中的文档。 */
  let poolRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 滚动期暂停池派发；池尚未创建时记下来，创建后补 hold。 */
  let scrollingActive = false;
  let nextSubscriptionId = 1;

  function ensurePool(): LocalCompilePool | null {
    if (disposed || poolUnavailable) return null;
    if (pool) return pool;
    let created: LocalCompilePool;
    try {
      created = createPool();
    } catch {
      return null;
    }
    // 上游池创建即 spawn Worker；滚动期内创建也要先 hold，避免立即派发。
    if (scrollingActive) created.hold();
    pool = created;
    // ready 只解析一次且不随之后的重建更新：初始 degraded 说明首个 Worker 已失败，
    // 同池任务都会退到主线程同步编译。上游先 resolve ready、任务随后才走 fallback：
    // 仍有 scheduled 时先不重建，等 `settleOutcome` 投递该结果时再恢复，否则
    // `retirePool` 会丢弃已同步编译的 fallback 结果；没有在途任务（如仅 warmup）
    // 才立即重建。
    created.ready.then(
      (event) => {
        if (event.status !== 'degraded' || pool !== created) return;
        for (const state of keys.values()) {
          if (state.scheduled !== null) return;
        }
        recoverFromWorkerFailure();
      },
      () => {}
    );
    return created;
  }

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
        delivered: null,
        attempted: null,
        scheduled: null,
        backpressureRetry: null,
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

  function nextScheduleRevision(key: string): number {
    const next = (scheduleRevisions.get(key) ?? 0) + 1;
    scheduleRevisions.set(key, next);
    return next;
  }

  function poolPriority(request: ChatCompileRequest): number {
    if (request.phase === 'streaming') return CHAT_RMD_PRIORITY_STREAMING;
    return request.priority === 'visible'
      ? CHAT_RMD_PRIORITY_VISIBLE_FINAL
      : CHAT_RMD_PRIORITY_NEARBY_FINAL;
  }

  /** 只有能通过投递检查的结果才值得占用池任务。 */
  function isSettled(state: KeyState, request: CompileStamp): boolean {
    if (state.delivered !== null && sameCompile(state.delivered, request)) return true;
    return state.attempted !== null && sameCompile(state.attempted, request);
  }

  function scheduleLatest(state: KeyState): void {
    if (disposed) return;
    const latest = state.latest;
    if (!latest) return;
    if (state.scheduled && sameCompile(state.scheduled, latest)) return;

    const retry = state.backpressureRetry;
    if (retry) {
      if (!sameCompile(retry.stamp, latest)) {
        // 内容已经变化：作废旧重试，立即按新内容调度。
        clearBackpressureRetry(state);
      } else if (isSettled(state, latest)) {
        // 同一内容已通过其他路径（如 final 缓存）投递：重试作废。
        clearBackpressureRetry(state);
        return;
      } else if (retry.timer !== null) {
        // 同一内容仍在退避等待：计时器触发后才会派发，不绕过 backpressure。
        return;
      }
    }

    if (isSettled(state, latest)) return;
    // 比已投递结果更旧的 revision 会被投递检查丢弃，不再浪费池槽位。
    if (state.delivered && latest.revision < state.delivered.revision) return;

    const activePool = ensurePool();
    if (!activePool) {
      if (!disposed && !poolUnavailable) {
        // 这里只可能是 createPool 抛错（warmup 的失败不落状态）：按不可用处理并冷却，
        // 本次失败不能写 delivered，冷却后同一内容还会再试。
        poolUnavailable = true;
        schedulePoolRetryCooldown();
      }
      publishFailure(state, latest, CHAT_RMD_WORKER_UNAVAILABLE, poolUnavailable);
      return;
    }

    const task: ScheduledTask = {
      revision: latest.revision,
      phase: latest.phase,
      source: latest.source,
      scheduleRevision: nextScheduleRevision(state.key),
    };
    state.scheduled = task;

    let pending: Promise<LocalCompilePoolOutcome>;
    try {
      pending = activePool.schedule({
        documentId: state.key,
        revision: task.scheduleRevision,
        source: task.source,
        options: CHAT_RMD_COMPILE_OPTIONS,
        sourcePhase: task.phase,
        priority: poolPriority(latest),
      });
    } catch {
      settleFailure(state.key, task, 'local.compile');
      return;
    }
    pending.then(
      (outcome) => settleOutcome(state.key, task, outcome),
      (error: unknown) => settleRejection(state.key, task, error)
    );
  }

  function canDeliver(state: KeyState, stamp: CompileStamp): boolean {
    if (state.subs.size === 0) return false;
    const latest = state.latest;
    if (!latest) return false;
    if (latest.revision !== stamp.revision || latest.source !== stamp.source) return false;
    // 已有 final 订阅时，streaming 快照不再投递。
    if (stamp.phase === 'streaming' && latest.phase === 'final') return false;

    const delivered = state.delivered;
    if (delivered) {
      if (stamp.phase === 'streaming' && delivered.phase === 'final') return false;
      if (stamp.revision < delivered.revision) return false;
      if (
        stamp.revision === delivered.revision &&
        !(stamp.phase === 'final' && delivered.phase === 'streaming')
      ) {
        return false;
      }
    }
    return true;
  }

  function markDelivered(state: KeyState, stamp: CompileStamp): void {
    const delivered = state.delivered;
    if (!delivered || stamp.revision > delivered.revision) {
      state.delivered = stamp;
      return;
    }
    if (
      stamp.revision === delivered.revision &&
      stamp.phase === 'final' &&
      delivered.phase === 'streaming'
    ) {
      state.delivered = stamp;
    }
  }

  /** 投递成功结果或错误快照；final 成功文档同时写入缓存。transient 不写 delivered。 */
  function publish(
    state: KeyState,
    stamp: CompileStamp,
    document: LocalDocument | null,
    errorCode: string | null,
    transient = false
  ): void {
    if (!canDeliver(state, stamp)) return;
    // 这一身份已经投递（可能是池不可用时的失败兜底）：backpressure 重试不再需要。
    const retry = state.backpressureRetry;
    if (retry && sameCompile(retry.stamp, stamp)) clearBackpressureRetry(state);
    if (document && stamp.phase === 'final' && errorCode === null) {
      cache.store(stamp.source, document);
    }
    if (!transient) markDelivered(state, stamp);

    const snapshot: ChatCompiledSnapshot = {
      key: state.key,
      revision: stamp.revision,
      phase: stamp.phase,
      document,
      errorCode,
    };
    for (const sub of state.subs.values()) {
      if (sub.request.revision > stamp.revision) continue;
      if (stamp.phase === 'streaming' && sub.request.phase === 'final') continue;
      notify(sub.listener, snapshot);
    }
  }

  function publishFailure(
    state: KeyState,
    stamp: CompileStamp,
    code: string,
    transient = false
  ): void {
    publish(state, stamp, null, code, transient);
  }

  function settleFailure(key: string, task: ScheduledTask, code: string): void {
    const state = keys.get(key);
    if (!state || state.scheduled !== task) return;
    state.scheduled = null;
    state.attempted = task;
    clearBackpressureRetry(state);
    publishFailure(state, task, code);
    scheduleLatest(state);
  }

  function settleOutcome(
    key: string,
    task: ScheduledTask,
    outcome: LocalCompilePoolOutcome
  ): void {
    if (disposed) return;
    const state = keys.get(key);
    if (!state || state.scheduled !== task) return;
    state.scheduled = null;
    state.attempted = task;
    clearBackpressureRetry(state);

    const result = outcome.result;
    if (!result.ok) {
      publishFailure(state, task, compileErrorCode(result));
    } else {
      let sanitized: LocalDocument | null = null;
      try {
        const policy = applyChatDocumentPolicy(result.document);
        if (policy.ok) sanitized = policy.document;
      } catch {
        sanitized = null;
      }
      if (sanitized) publish(state, task, sanitized, null);
      else publishFailure(state, task, CHAT_RMD_POLICY_UNSUPPORTED);
    }

    // `mode === 'fallback'` 说明 Worker 已失败：先投递本次结果，再重建池；
    // 重建会清空各 key 的 scheduled，提前处理会丢掉这一次投递。
    if (outcome.mode === 'fallback') {
      recoverFromWorkerFailure();
      return;
    }
    // Worker 正常完成一次编译（无论结果成败）说明池仍可用：重建预算恢复到
    // 上限，避免长期复用后第二次故障就永久停用；持续 fallback 不会走到这里。
    poolRebuildsRemaining = CHAT_RMD_POOL_MAX_REBUILDS;
    scheduleLatest(state);
  }

  function settleRejection(key: string, task: ScheduledTask, error: unknown): void {
    if (disposed) return;
    const state = keys.get(key);
    if (!state || state.scheduled !== task) return;
    state.scheduled = null;

    const kind = error instanceof LocalCompilePoolTaskError ? error.kind : null;
    if (kind === 'superseded' || kind === 'cancelled' || kind === 'disposed') {
      // 池内被更新请求顶掉 / 文档释放 / 池销毁：没有可投递的失败。
      return;
    }
    if (kind === 'backpressure') {
      // 队列回满只是瞬时压力：不写 attempted，退避后重试同一内容。
      scheduleBackpressureRetry(state, task);
      return;
    }

    state.attempted = task;
    clearBackpressureRetry(state);
    publishFailure(state, task, poolTaskErrorCode(kind));
    // 回退编译本身失败（worker-failed）同样说明 Worker 已不可用，与 fallback
    // 结果同等处理，避免后续任务继续在主线程同步编译。
    if (kind === 'worker-failed') {
      recoverFromWorkerFailure();
      return;
    }
    scheduleLatest(state);
  }

  /** 清掉未触发的 backpressure 重试；成功、换内容或卸载时调用。 */
  function clearBackpressureRetry(state: KeyState): void {
    const retry = state.backpressureRetry;
    if (!retry) return;
    if (retry.timer !== null) clearTimeout(retry.timer);
    state.backpressureRetry = null;
  }

  /**
   * backpressure 退避重试：只对仍是 latest 的内容生效。超过上限才把这次编译
   * 记为 attempted 并投递失败码，避免同一内容无休止重排。
   */
  function scheduleBackpressureRetry(state: KeyState, task: ScheduledTask): void {
    const latest = state.latest;
    if (!latest) return;
    if (!sameCompile(task, latest)) {
      // 内容已经更新：旧内容不必再试，直接按最新内容调度。
      scheduleLatest(state);
      return;
    }

    const previous = state.backpressureRetry;
    const attempts = previous && sameCompile(previous.stamp, task) ? previous.attempts + 1 : 1;
    if (previous && previous.timer !== null) clearTimeout(previous.timer);

    if (attempts > CHAT_RMD_BACKPRESSURE_MAX_RETRIES) {
      clearBackpressureRetry(state);
      state.attempted = task;
      publishFailure(state, task, CHAT_RMD_BACKPRESSURE_EXHAUSTED);
      return;
    }

    const record: BackpressureRetry = { stamp: task, attempts, timer: null };
    record.timer = setTimeout(() => {
      if (disposed) return;
      const current = keys.get(state.key);
      if (current !== state || state.backpressureRetry !== record) return;
      // 保留 attempts 跨重试累计；重新派发失败时 scheduleBackpressureRetry 继续加。
      record.timer = null;
      scheduleLatest(state);
    }, CHAT_RMD_BACKPRESSURE_RETRY_BASE_MS * 2 ** (attempts - 1));
    state.backpressureRetry = record;
  }

  /**
   * Worker 已失败（fallback 结果或 ready=degraded）。上游池不会自愈，同池的
   * 后续任务都会在主线程同步编译；因此先丢开旧池：清 scheduled 让迟到结果在
   * 身份检查处被忽略，再在预算内重建。预算用尽则停止派发并投递
   * `worker.unavailable`，让视图显示源码而不是整页同步编译。
   */
  function recoverFromWorkerFailure(): void {
    if (disposed || poolUnavailable) return;
    if (keys.size === 0) {
      // 只有 warmup 建过池、还没人订阅：直接丢弃失败池，不消耗重建预算，
      // 下一次订阅会按 `ensurePool` 常规路径新建。
      retirePool();
      return;
    }
    if (poolRebuildsRemaining <= 0) {
      poolUnavailable = true;
      retirePool();
      // 投递可能同步触发订阅者回调，先固定待通知的 key 集合。
      // 这是冷却前的临时失败：不写 delivered，冷却后同一内容还会再试。
      for (const state of [...keys.values()]) {
        if (state.latest) {
          publishFailure(state, state.latest, CHAT_RMD_WORKER_UNAVAILABLE, true);
        }
      }
      schedulePoolRetryCooldown();
      return;
    }
    poolRebuildsRemaining -= 1;
    retirePool();
    for (const state of keys.values()) {
      if (state.subs.size > 0) scheduleLatest(state);
    }
  }

  /** 冷却后重新武装预算，并重试仍订阅的内容；无订阅时只恢复标志。 */
  function schedulePoolRetryCooldown(): void {
    if (disposed || poolRetryTimer !== null) return;
    poolRetryTimer = setTimeout(() => {
      poolRetryTimer = null;
      if (disposed) return;
      poolUnavailable = false;
      poolRebuildsRemaining = CHAT_RMD_POOL_MAX_REBUILDS;
      for (const state of keys.values()) {
        if (state.subs.size > 0 && state.latest) scheduleLatest(state);
      }
    }, CHAT_RMD_POOL_RETRY_COOLDOWN_MS);
    (poolRetryTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 丢弃当前池；先清本地派发身份，旧池排队任务的 resolve / reject 都被忽略。 */
  function retirePool(): void {
    for (const state of keys.values()) {
      state.scheduled = null;
      clearBackpressureRetry(state);
    }
    const current = pool;
    pool = null;
    if (!current) return;
    try {
      current.dispose();
    } catch {
      // 池可能已被上游销毁；重复 dispose 不应影响重建。
    }
  }

  function scheduleRelease(key: string): void {
    const previousTimer = releaseTimers.get(key);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    releaseTimers.set(
      key,
      setTimeout(() => {
        releaseTimers.delete(key);
        if (disposed || keys.has(key)) return;
        // release 会清空池内 revision 链；本地的 scheduleRevision 同时归零，
        // 下次订阅从 1 重新开始，两边再次对齐。
        scheduleRevisions.delete(key);
        pool?.release(key);
      }, CHAT_RMD_SESSION_RELEASE_GRACE_MS)
    );
  }

  function unsubscribe(state: KeyState, subscription: Subscription): void {
    if (disposed) return;
    if (!state.subs.delete(subscription.id)) return;
    updateLatest(state);

    if (state.subs.size > 0) {
      scheduleLatest(state);
      return;
    }

    keys.delete(state.key);
    clearBackpressureRetry(state);
    // 流式快照常因短暂离屏（滚动、频道切换）先取消再订阅同一 key：留 1s 宽限，
    // 重订阅时 getKeyState 撤销这个定时器；到期仍无人回来才真正释放池文档。
    scheduleRelease(state.key);
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
    const subscription: Subscription = {
      id: nextSubscriptionId,
      request: normalized,
      listener,
    };
    nextSubscriptionId += 1;
    state.subs.set(subscription.id, subscription);
    updateLatest(state);

    if (normalized.phase === 'final') {
      const cached = cache.lookup(normalized.source);
      if (cached) {
        markDelivered(state, normalized);
        notify(listener, {
          key: normalized.key,
          revision: normalized.revision,
          phase: 'final',
          document: cached,
          errorCode: null,
        });
        // 同一 key 的其他订阅者可能仍在等更新的 revision。
        scheduleLatest(state);
        return () => unsubscribe(state, subscription);
      }
    }

    scheduleLatest(state);
    return () => unsubscribe(state, subscription);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (poolRetryTimer !== null) {
      clearTimeout(poolRetryTimer);
      poolRetryTimer = null;
    }
    for (const timer of releaseTimers.values()) clearTimeout(timer);
    releaseTimers.clear();
    for (const state of keys.values()) {
      state.subs.clear();
      state.scheduled = null;
      clearBackpressureRetry(state);
    }
    keys.clear();
    scheduleRevisions.clear();
    cache.clear();
    const current = pool;
    pool = null;
    if (current) {
      try {
        current.dispose();
      } catch {
        // 重复 dispose 或已销毁的池不再抛。
      }
    }
  }

  /** 预创建池（上游池创建即 spawn Worker），缩短首条消息的冷启动等待。 */
  function warmup(): void {
    if (disposed) return;
    ensurePool();
  }

  /** 滚动期暂停 / 恢复池的文档派发；不取消在途编译，dispose 后为 no-op。 */
  function setScrolling(active: boolean): void {
    if (disposed) return;
    if (scrollingActive === active) return;
    scrollingActive = active;
    if (!pool) return;
    if (active) pool.hold();
    else pool.resume();
  }

  return { subscribe, warmup, dispose, setScrolling };
}

/**
 * 默认池工厂。`new URL('./compile.worker.ts', …)` 必须保持字面量相对路径，
 * webpack 靠它静态打包 Worker 入口。不提供 `fallbackCompile`：池的默认回退
 * 会在 Worker 不可用时于主线程用同一套选项编译。
 */
function defaultPoolFactory(): LocalCompilePool {
  if (typeof Worker === 'undefined') throw new Error('chat-rmd: Worker unavailable');
  return createLocalCompilePool({
    workers: 1,
    timeoutMs: CHAT_RMD_COMPILE_TIMEOUT_MS,
    maxPending: CHAT_RMD_MAX_PENDING,
    snapshotPolicy: 'latest',
    createWorker: () =>
      new Worker(new URL('./compile.worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as LocalCompileWorker,
  });
}