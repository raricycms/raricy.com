// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-compile-manager.test.ts — 聊天编译管理器（订阅 / 顺序 / 缓存 / 池生命周期）
//
// 编译调度交给上游 `LocalCompilePool`，Manager 只保留聊天语义。这里用假池钉住：
// final 缓存同步命中、旧 revision 不覆盖新 revision、streaming 不覆盖 final、
// 策略失败与池失败的稳定错误码、unsubscribe 宽限后 release、hold/resume、
// dispose 清理，以及发给池的 documentId / 单调 scheduleRevision / priority。
// Worker 失败（fallback / ready=degraded）的有限重建与 backpressure 退避重试
// 也在这里覆盖。
//
// 真实编译行为（字面表达式、fallback、表格）在 chat-rmd-options.test.ts 覆盖。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { LocalCompileResult, LocalDocument } from 'reactive-md';
import {
  LocalCompilePoolTaskError,
  type LocalCompilePool,
  type LocalCompilePoolCounts,
  type LocalCompilePoolOutcome,
  type LocalCompilePoolReadyEvent,
  type LocalCompilePoolRequest,
  type LocalCompilePoolTaskErrorKind,
} from 'reactive-md/worker-pool';
import {
  CHAT_RMD_POOL_RETRY_COOLDOWN_MS,
  ChatFinalCache,
  chatCompileIdentity,
  createChatCompileManager,
} from '@/lib/chat-rmd/compile-manager';
import { CHAT_RMD_POLICY_UNSUPPORTED } from '@/lib/chat-rmd/document-policy';
import { CHAT_RMD_COMPILE_OPTIONS } from '@/lib/chat-rmd/options';
import type {
  ChatCompileRequest,
  ChatCompiledSnapshot,
  ChatSourcePhase,
} from '@/lib/chat-rmd/types';

function makeDocument(source: string): LocalDocument {
  return {
    syntax: 'local',
    source,
    nodes: [
      {
        type: 'paragraph',
        id: 'local-1',
        range: { start: 0, end: source.length },
        children: [
          { type: 'text', id: 'local-0', range: { start: 0, end: source.length }, value: source },
        ],
      },
    ],
    initialState: {},
    bindings: {},
  };
}

/** 文档策略无法读取原文的节点会让 `applyChatDocumentPolicy` 整体失败。 */
function unreadableDocument(source: string): LocalDocument {
  return {
    syntax: 'local',
    source,
    nodes: [{ type: 'image', id: 'img-1', range: { start: 5, end: 1 } }],
    initialState: {},
    bindings: {},
  };
}

function okResult(source: string): LocalCompileResult {
  return { ok: true, document: makeDocument(source), diagnostics: [] };
}

function failedResult(code: string): LocalCompileResult {
  return {
    ok: false,
    status: 'failed',
    diagnostics: [
      {
        code,
        message: code,
        severity: 'error',
        range: { start: 0, end: 1 },
        line: 1,
        column: 1,
      },
    ],
  };
}

interface FakePoolTask {
  request: LocalCompilePoolRequest;
  settled: boolean;
  resolve(outcome: LocalCompilePoolOutcome): void;
  reject(error: unknown): void;
}

/** 最小 `LocalCompilePool`：任务挂起由测试手动 settle，记录 hold / resume / release。 */
class FakePool implements LocalCompilePool {
  readonly ready: Promise<LocalCompilePoolReadyEvent>;
  readonly tasks: FakePoolTask[] = [];
  readonly released: string[] = [];
  readonly cancelled: string[] = [];
  readonly priorities: { documentId: string; priority: number }[] = [];
  holdCalls = 0;
  resumeCalls = 0;
  disposeCalls = 0;
  /** 与上游一致：dispose 拒绝仍挂起的任务；置 false 可模拟退役池的迟到结果。 */
  rejectPendingOnDispose = true;

  constructor(readyStatus: LocalCompilePoolReadyEvent['status'] = 'ready') {
    this.ready = Promise.resolve({
      status: readyStatus,
      availableWorkers: readyStatus === 'ready' ? 1 : 0,
      failedWorkers: readyStatus === 'ready' ? 0 : 1,
    });
  }

  schedule(request: LocalCompilePoolRequest): Promise<LocalCompilePoolOutcome> {
    return new Promise((resolve, reject) => {
      const task: FakePoolTask = {
        request,
        settled: false,
        resolve: (outcome) => {
          task.settled = true;
          resolve(outcome);
        },
        reject: (error) => {
          task.settled = true;
          reject(error);
        },
      };
      this.tasks.push(task);
    });
  }

  cancel(documentId: string): void {
    this.cancelled.push(documentId);
  }

  release(documentId: string): void {
    this.released.push(documentId);
  }

  setPriority(documentId: string, priority: number): void {
    this.priorities.push({ documentId, priority });
  }

  hold(): void {
    this.holdCalls += 1;
  }

  resume(): void {
    this.resumeCalls += 1;
  }

  getCounts(): LocalCompilePoolCounts {
    return {
      capacity: 1,
      queuedDocuments: 0,
      inFlightWorkers: 0,
      pendingTasks: this.tasks.length,
      oldestPendingMs: 0,
    };
  }

  /** 与上游一致：dispose 拒绝仍挂起的任务，用于验证旧池迟到拒绝被静默忽略。 */
  dispose(): void {
    this.disposeCalls += 1;
    if (!this.rejectPendingOnDispose) return;
    for (const task of this.tasks) {
      if (task.settled) continue;
      task.reject(new LocalCompilePoolTaskError('disposed'));
    }
  }

  taskAt(index: number): FakePoolTask {
    const task = this.tasks[index];
    if (!task) throw new Error(`缺少第 ${index} 个池任务`);
    return task;
  }

  settle(
    index: number,
    result?: LocalCompileResult,
    mode: 'worker' | 'fallback' = 'worker'
  ): void {
    const task = this.taskAt(index);
    task.resolve({
      documentId: task.request.documentId,
      revision: task.request.revision,
      source: task.request.source,
      result: result ?? okResult(task.request.source),
      duration: 1,
      mode,
      sourcePhase: task.request.sourcePhase ?? 'final',
    });
  }

  fail(index: number, kind: LocalCompilePoolTaskErrorKind): void {
    this.taskAt(index).reject(new LocalCompilePoolTaskError(kind));
  }
}

function setup(createPool?: () => LocalCompilePool): {
  manager: ReturnType<typeof createChatCompileManager>;
  pool: FakePool;
} {
  const pool = new FakePool();
  const manager = createChatCompileManager({ createPool: createPool ?? (() => pool) });
  return { manager, pool };
}

/** 按创建顺序记录池；`readyStatus` 用来模拟初始 degraded。 */
function setupSequence(
  readyStatus: (index: number) => LocalCompilePoolReadyEvent['status'] = () => 'ready'
): {
  manager: ReturnType<typeof createChatCompileManager>;
  pools: FakePool[];
} {
  const pools: FakePool[] = [];
  const manager = createChatCompileManager({
    createPool: () => {
      const pool = new FakePool(readyStatus(pools.length));
      pools.push(pool);
      return pool;
    },
  });
  return { manager, pools };
}

function request(
  key: string,
  revision: number,
  source: string,
  phase: ChatSourcePhase = 'final',
  priority: ChatCompileRequest['priority'] = 'visible'
): ChatCompileRequest {
  return { key, revision, source, phase, priority };
}

/** 池返回的 Promise 由 resolve 触发，投递发生在下一个微任务。 */
function tick(): Promise<void> {
  return Promise.resolve();
}

describe('池生命周期与任务映射', () => {
  it('懒创建池：warmup 只建一次、不排任务，subscribe 复用同一池', () => {
    let created = 0;
    const pool = new FakePool();
    const manager = createChatCompileManager({
      createPool: () => {
        created += 1;
        return pool;
      },
    });
    expect(created).toBe(0);

    manager.warmup?.();
    manager.warmup?.();
    expect(created).toBe(1);
    expect(pool.tasks).toHaveLength(0);

    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    expect(created).toBe(1);
    expect(pool.tasks).toHaveLength(1);
  });

  it('warmup 建池失败不抛，首次订阅重试', () => {
    let attempts = 0;
    const pool = new FakePool();
    const manager = createChatCompileManager({
      createPool: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('warmup boom');
        return pool;
      },
    });

    expect(() => manager.warmup?.()).not.toThrow();
    expect(attempts).toBe(1);
    expect(pool.tasks).toHaveLength(0);

    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    expect(attempts).toBe(2);
    expect(pool.tasks).toHaveLength(1);
  });

  it('把聊天请求映射为池任务：documentId / 选项 / 阶段 / 优先级', () => {
    const { manager, pool } = setup();
    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    manager.subscribe(request('gen:1', 1, '生成', 'streaming'), () => {});
    manager.subscribe(request('msg:2', 1, '乙', 'final', 'nearby'), () => {});

    expect(pool.taskAt(0).request).toMatchObject({
      documentId: 'msg:1',
      revision: 1,
      source: '甲',
      sourcePhase: 'final',
      priority: 10,
    });
    expect(pool.taskAt(1).request).toMatchObject({
      documentId: 'gen:1',
      sourcePhase: 'streaming',
      priority: 5,
    });
    expect(pool.taskAt(2).request).toMatchObject({ documentId: 'msg:2', priority: 0 });
    expect(pool.taskAt(0).request.options).toBe(CHAT_RMD_COMPILE_OPTIONS);
  });

  it('聊天 revision 重挂后从 1 重新开始，池 revision 保持单调；release 后一起归零', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const first = manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      pool.settle(0, okResult('一'));
      await tick();
      first();

      const second = manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      expect(pool.tasks).toHaveLength(2);
      // 聊天 revision 仍是 1，但池 revision 必须递增。
      expect(pool.taskAt(1).request).toMatchObject({ documentId: 'gen:1', revision: 2 });
      second();

      // 宽限期到期 release；下一个订阅重新从 1 开始。
      vi.advanceTimersByTime(1_000);
      expect(pool.released).toEqual(['gen:1']);

      manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      expect(pool.taskAt(2).request.revision).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('投递顺序', () => {
  it('旧 revision 的结果被丢弃，多个订阅者按各自 revision 收到最新结果', async () => {
    const { manager, pool } = setup();
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('gen:1', 1, '甲', 'streaming'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('gen:1', 2, '甲乙', 'streaming'), (snapshot) => second.push(snapshot));
    expect(pool.tasks).toHaveLength(2);

    pool.settle(0, okResult('甲'));
    await tick();
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    pool.settle(1, okResult('甲乙'));
    await tick();
    expect(first.map((snapshot) => snapshot.revision)).toEqual([2]);
    expect(second.map((snapshot) => snapshot.revision)).toEqual([2]);
  });

  it('streaming 结果不覆盖 final 订阅', async () => {
    const { manager, pool } = setup();
    const streaming: ChatCompiledSnapshot[] = [];
    const final: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('msg:1', 1, '甲', 'streaming'), (snapshot) =>
      streaming.push(snapshot)
    );
    manager.subscribe(request('msg:1', 1, '甲', 'final'), (snapshot) => final.push(snapshot));
    expect(pool.tasks).toHaveLength(2);

    pool.settle(0, okResult('甲'));
    await tick();
    expect(streaming).toEqual([]);
    expect(final).toEqual([]);

    pool.settle(1, okResult('甲'));
    await tick();
    expect(streaming).toHaveLength(1);
    expect(streaming[0].phase).toBe('final');
    expect(final).toHaveLength(1);
    expect(final[0].phase).toBe('final');
  });

  it('final 已投递后，新的 streaming 不再投递也不再反复入池', async () => {
    const { manager, pool } = setup();
    const final = vi.fn();
    manager.subscribe(request('msg:1', 1, '甲'), final);
    pool.settle(0, okResult('甲'));
    await tick();
    expect(final).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    manager.subscribe(request('msg:1', 2, '甲二', 'streaming'), late);
    expect(pool.tasks).toHaveLength(2);
    pool.settle(1, okResult('甲二'));
    await tick();
    expect(late).not.toHaveBeenCalled();
    // 同一身份被顺序规则拒绝后不再重复编译。
    expect(pool.tasks).toHaveLength(2);
  });

  it('同一文档的多个订阅者各收到一次通知', async () => {
    const { manager, pool } = setup();
    const first = vi.fn();
    const second = vi.fn();
    manager.subscribe(request('msg:1', 1, '正文'), first);
    manager.subscribe(request('msg:1', 1, '正文'), second);

    expect(pool.tasks).toHaveLength(1);
    pool.settle(0, okResult('正文'));
    await tick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('final 缓存', () => {
  it('同 key / 同源码再次订阅同步命中，不重新编译', async () => {
    const { manager, pool } = setup();
    const unsubscribe = manager.subscribe(request('msg:1', 1, '正文'), () => {});
    pool.settle(0, okResult('正文'));
    await tick();
    unsubscribe();

    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 2, '正文'), (snapshot) => snapshots.push(snapshot));

    expect(pool.tasks).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ key: 'msg:1', revision: 2, phase: 'final', errorCode: null });
    expect(snapshots[0].document?.source).toBe('正文');
  });

  it('源码不同不会命中缓存', async () => {
    const { manager, pool } = setup();
    const unsubscribe = manager.subscribe(request('msg:1', 1, '正文'), () => {});
    pool.settle(0, okResult('正文'));
    await tick();
    unsubscribe();

    manager.subscribe(request('msg:1', 2, '另一段正文'), () => {});
    expect(pool.tasks).toHaveLength(2);
    expect(pool.taskAt(1).request).toMatchObject({ revision: 2, source: '另一段正文' });
  });

  it('streaming 结果不写缓存', async () => {
    const { manager, pool } = setup();
    const unsubscribe = manager.subscribe(request('msg:1', 1, '正文', 'streaming'), () => {});
    pool.settle(0, okResult('正文'));
    await tick();
    unsubscribe();

    manager.subscribe(request('msg:1', 2, '正文'), () => {});
    expect(pool.tasks).toHaveLength(2);
    expect(pool.taskAt(1).request.sourcePhase).toBe('final');
  });

  it('键命中后仍核对完整源码', () => {
    const cache = new ChatFinalCache();
    const document = makeDocument('B');
    const identityOfA = chatCompileIdentity('A');

    expect(cache.store('B', document, identityOfA)).toBe(true);
    expect(cache.lookup('A')).toBeUndefined();
    expect(cache.lookup('B', identityOfA)).toBe(document);
  });

  it('按条数淘汰最旧条目', () => {
    const cache = new ChatFinalCache({ maxEntries: 2 });
    cache.store('a', makeDocument('a'));
    cache.store('b', makeDocument('b'));
    cache.store('c', makeDocument('c'));

    expect(cache.size).toBe(2);
    expect(cache.lookup('a')).toBeUndefined();
    expect(cache.lookup('b')).toBeDefined();
    expect(cache.lookup('c')).toBeDefined();
  });

  it('按估算字节淘汰', () => {
    // 单条约 2.2 KiB（源码在 document 里出现两次），6000 字节正好能放 2 条、放不下 3 条。
    const cache = new ChatFinalCache({ maxEntries: 10, maxBytes: 6_000 });
    cache.store('a', makeDocument('a'.repeat(1_000)));
    cache.store('b', makeDocument('b'.repeat(1_000)));
    cache.store('c', makeDocument('c'.repeat(1_000)));

    expect(cache.lookup('a')).toBeUndefined();
    expect(cache.lookup('b')).toBeDefined();
    expect(cache.lookup('c')).toBeDefined();
  });
});

describe('失败与策略', () => {
  it('编译失败返回稳定诊断码', async () => {
    const { manager, pool } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

    pool.settle(0, failedResult('local.budget'));
    await tick();
    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: null, errorCode: 'local.budget' },
    ]);
  });

  it('文档策略失败投递 policy.unsupported 且不缓存', async () => {
    const { manager, pool } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, 'x'), (snapshot) => snapshots.push(snapshot));

    pool.settle(0, { ok: true, document: unreadableDocument('x'), diagnostics: [] });
    await tick();
    expect(snapshots).toEqual([
      {
        key: 'msg:1',
        revision: 1,
        phase: 'final',
        document: null,
        errorCode: CHAT_RMD_POLICY_UNSUPPORTED,
      },
    ]);

    // 失败结果不进 final 缓存：同源码重订阅仍要重新编译。
    manager.subscribe(request('msg:1', 2, 'x'), () => {});
    expect(pool.tasks).toHaveLength(2);
  });

  it('池任务失败映射到稳定错误码', async () => {
    const { manager, pool } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    const record = (snapshot: ChatCompiledSnapshot): void => {
      snapshots.push(snapshot);
    };

    manager.subscribe(request('msg:1', 1, '甲'), record);
    pool.fail(0, 'worker-failed');
    await tick();

    manager.subscribe(request('msg:2', 1, '乙'), record);
    pool.fail(1, 'source-too-large');
    await tick();

    manager.subscribe(request('msg:3', 1, '丙'), record);
    pool.taskAt(2).reject(new Error('boom'));
    await tick();

    expect(snapshots.map((snapshot) => snapshot.errorCode)).toEqual([
      'worker.unavailable',
      'local.budget',
      'local.compile',
    ]);
    expect(snapshots.every((snapshot) => snapshot.document === null)).toBe(true);
  });

  it('superseded / cancelled 静默，不投递失败', async () => {
    const { manager, pool } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

    pool.fail(0, 'superseded');
    await tick();
    expect(snapshots).toEqual([]);
  });
});

describe('Worker 降级与重建', () => {
  it('fallback 结果先投递，再重建一次池；其他 key 进入新池，旧池拒绝被忽略', async () => {
    const { manager, pools } = setupSequence();
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));
    expect(pools).toHaveLength(1);
    expect(pools[0]?.tasks).toHaveLength(2);

    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    // 本次 fallback 结果是有效文档，先正常投递。
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ key: 'msg:1', revision: 1, errorCode: null });
    // 旧池被丢弃，仍在订阅且未投递的 key 重新进入新池。
    expect(pools).toHaveLength(2);
    expect(pools[0]?.disposeCalls).toBe(1);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);

    // 旧池 dispose 的拒绝与新池结果之间不产生重复投递。
    await tick();
    expect(pools[0]?.tasks[1]?.settled).toBe(true);
    expect(second).toEqual([]);
    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.document?.source).toBe('乙');
  });

  it('重建预算用尽后再 fallback：投递 worker.unavailable 且不再创建新池', async () => {
    const { manager, pools } = setupSequence();
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];
    const third: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));
    manager.subscribe(request('msg:3', 1, '丙'), (snapshot) => third.push(snapshot));

    // 第一次 fallback 消耗重建预算：未投递的 key 进入第二个池。
    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(pools).toHaveLength(2);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2', 'msg:3']);

    // 第二个池再次 fallback：当前结果照常投递，其余 key 收到稳定失败码。
    pools[1]?.settle(0, okResult('乙'), 'fallback');
    await tick();
    expect(pools).toHaveLength(2);
    expect(pools[1]?.disposeCalls).toBe(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ key: 'msg:2', errorCode: null });
    expect(second[0]?.document?.source).toBe('乙');
    expect(third).toEqual([
      {
        key: 'msg:3',
        revision: 1,
        phase: 'final',
        document: null,
        errorCode: 'worker.unavailable',
        retryable: true,
      },
    ]);

    // 之后的新订阅不再建池，直接投递失败码让视图显示源码。
    const late = vi.fn();
    manager.subscribe(request('msg:4', 1, '丁'), late);
    expect(pools).toHaveLength(2);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]?.[0]).toMatchObject({
      key: 'msg:4',
      document: null,
      errorCode: 'worker.unavailable',
      retryable: true,
    });
  });

  it('池初始 ready=degraded：先投递同步 fallback 结果，只编译一次，随后才重建', async () => {
    const { manager, pools } = setupSequence((index) => (index === 0 ? 'degraded' : 'ready'));
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));
    expect(pools).toHaveLength(1);
    expect(pools[0]?.tasks).toHaveLength(2);

    // ready 先解析为 degraded，但仍有在途任务：先不重建，等它走 fallback 投递。
    await tick();
    expect(pools).toHaveLength(1);
    expect(pools[0]?.disposeCalls).toBe(0);
    expect(first).toEqual([]);

    // 任务随后以 fallback 结束：结果先投递，然后才丢弃旧池并重建。
    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(first).toHaveLength(1);
    expect(first[0]?.document?.source).toBe('甲');
    expect(pools).toHaveLength(2);
    expect(pools[0]?.disposeCalls).toBe(1);
    // 已投递的 msg:1 不再进新池：整条消息只编译一次。
    expect(pools[0]?.tasks).toHaveLength(2);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);

    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.document?.source).toBe('乙');
  });

  it('warmup 建池 ready=degraded：无在途任务时直接丢弃，不消耗重建预算', async () => {
    const { manager, pools } = setupSequence((index) => (index === 0 ? 'degraded' : 'ready'));
    manager.warmup?.();
    expect(pools).toHaveLength(1);

    await tick();
    expect(pools[0]?.disposeCalls).toBe(1);

    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));
    expect(pools).toHaveLength(2);
    expect(pools[1]?.tasks).toHaveLength(2);

    // 首次 fallback 仍能消费完整预算：msg:2 进入第三个池，而不是直接停用。
    pools[1]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(first).toHaveLength(1);
    expect(pools).toHaveLength(3);
    expect(pools[1]?.disposeCalls).toBe(1);
    expect(pools[2]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);
    expect(second).toEqual([]);

    pools[2]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
  });

  it('Worker 正常完成一次编译后重建预算恢复：再次 fallback 仍能重建', async () => {
    const { manager, pools } = setupSequence();
    const snapshots: ChatCompiledSnapshot[] = [];
    const record = (snapshot: ChatCompiledSnapshot): void => {
      snapshots.push(snapshot);
    };

    manager.subscribe(request('msg:1', 1, '甲'), record);
    manager.subscribe(request('msg:2', 1, '乙'), record);
    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(pools).toHaveLength(2);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);

    // 新池成功编译一次：预算恢复到上限。
    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(snapshots.map((snapshot) => snapshot.key)).toEqual(['msg:1', 'msg:2']);

    manager.subscribe(request('msg:3', 1, '丙'), record);
    manager.subscribe(request('msg:4', 1, '丁'), record);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual([
      'msg:2',
      'msg:3',
      'msg:4',
    ]);

    // 再次 fallback 仍能重建，而不是直接投递 worker.unavailable。
    pools[1]?.settle(1, okResult('丙'), 'fallback');
    await tick();
    expect(snapshots.map((snapshot) => snapshot.key)).toEqual(['msg:1', 'msg:2', 'msg:3']);
    expect(snapshots.every((snapshot) => snapshot.errorCode === null)).toBe(true);
    expect(pools).toHaveLength(3);
    expect(pools[1]?.disposeCalls).toBe(1);
    expect(pools[2]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:4']);
  });

  it('worker-failed 拒绝同样触发重建：当前 key 显示源码，其他 key 进新池', async () => {
    const { manager, pools } = setupSequence();
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));

    pools[0]?.fail(0, 'worker-failed');
    await tick();
    expect(first).toEqual([
      {
        key: 'msg:1',
        revision: 1,
        phase: 'final',
        document: null,
        errorCode: 'worker.unavailable',
      },
    ]);
    expect(pools).toHaveLength(2);
    expect(pools[0]?.disposeCalls).toBe(1);
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);

    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.document?.source).toBe('乙');
  });

  it('重建预算用尽后冷却到点重新武装并重试仍订阅的内容', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pools } = setupSequence();
      const third: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), () => {});
      manager.subscribe(request('msg:2', 1, '乙'), () => {});
      manager.subscribe(request('msg:3', 1, '丙'), (snapshot) => third.push(snapshot));

      pools[0]?.settle(0, okResult('甲'), 'fallback');
      await tick();
      pools[1]?.settle(0, okResult('乙'), 'fallback');
      await tick();
      expect(pools).toHaveLength(2);
      expect(third[0]?.errorCode).toBe('worker.unavailable');

      vi.advanceTimersByTime(CHAT_RMD_POOL_RETRY_COOLDOWN_MS - 1);
      expect(pools).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(pools).toHaveLength(3);
      expect(pools[2]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:3']);

      pools[2]?.settle(0, okResult('丙'));
      await tick();
      expect(third.at(-1)?.document?.source).toBe('丙');
      expect(third.at(-1)?.errorCode).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 清理冷却计时器：到点不再建池', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pools } = setupSequence();
      manager.subscribe(request('msg:1', 1, '甲'), () => {});
      manager.subscribe(request('msg:2', 1, '乙'), () => {});
      manager.subscribe(request('msg:3', 1, '丙'), () => {});

      pools[0]?.settle(0, okResult('甲'), 'fallback');
      await tick();
      pools[1]?.settle(0, okResult('乙'), 'fallback');
      await tick();
      expect(pools).toHaveLength(2);

      manager.dispose();
      vi.advanceTimersByTime(CHAT_RMD_POOL_RETRY_COOLDOWN_MS);
      expect(pools).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('createPool 抛错按冷却重试：首次失败不写 delivered', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pool = new FakePool();
      const manager = createChatCompileManager({
        createPool: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('spawn failed');
          return pool;
        },
      });
      const snapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

      expect(attempts).toBe(1);
      expect(snapshots).toEqual([
        {
          key: 'msg:1',
          revision: 1,
          phase: 'final',
          document: null,
          errorCode: 'worker.unavailable',
          retryable: true,
        },
      ]);

      vi.advanceTimersByTime(CHAT_RMD_POOL_RETRY_COOLDOWN_MS);
      expect(attempts).toBe(2);
      expect(pool.tasks).toHaveLength(1);

      pool.settle(0, okResult('甲'));
      await tick();
      expect(snapshots.at(-1)?.document?.source).toBe('甲');
      expect(snapshots.at(-1)?.errorCode).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('退役池的迟到 reject 被忽略：不投递失败也不额外重建', async () => {
    const { manager, pools } = setupSequence();
    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));

    (pools[0] as FakePool).rejectPendingOnDispose = false;
    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(pools).toHaveLength(2);
    expect(pools[1]?.tasks).toHaveLength(1);

    pools[0]?.fail(1, 'worker-failed');
    await tick();
    expect(second).toEqual([]);
    expect(pools).toHaveLength(2);

    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.document?.source).toBe('乙');
  });

  it('退役池的迟到 resolve 被忽略：不重复投递', async () => {
    const { manager, pools } = setupSequence();
    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));

    (pools[0] as FakePool).rejectPendingOnDispose = false;
    pools[0]?.settle(0, okResult('甲'), 'fallback');
    await tick();
    expect(pools[1]?.tasks.map((task) => task.request.documentId)).toEqual(['msg:2']);

    // 旧池 msg:2 的迟到成功结果：本地 scheduled 已是新池任务，旧结果被忽略。
    pools[0]?.settle(1, okResult('乙'));
    await tick();
    expect(second).toEqual([]);
    expect(pools[1]?.tasks).toHaveLength(1);

    pools[1]?.settle(0, okResult('乙'));
    await tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.document?.source).toBe('乙');
  });
});

describe('backpressure 退避', () => {
  it('不永久失败：退避 200ms 后重试同一内容并成功', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const snapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

      pool.fail(0, 'backpressure');
      await tick();
      expect(snapshots).toEqual([]);
      expect(pool.tasks).toHaveLength(1);

      vi.advanceTimersByTime(199);
      expect(pool.tasks).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(pool.tasks).toHaveLength(2);
      expect(pool.taskAt(1).request).toMatchObject({ documentId: 'msg:1', source: '甲' });

      pool.settle(1, okResult('甲'));
      await tick();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.document?.source).toBe('甲');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过重试上限投递 pool.backpressure，且不再自动重试', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const snapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

      pool.fail(0, 'backpressure');
      await tick();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        vi.advanceTimersByTime(200 * 2 ** attempt);
        await tick();
        pool.fail(pool.tasks.length - 1, 'backpressure');
        await tick();
      }

      expect(pool.tasks).toHaveLength(6);
      expect(snapshots).toEqual([
        {
          key: 'msg:1',
          revision: 1,
          phase: 'final',
          document: null,
          errorCode: 'pool.backpressure',
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(60_000);
      expect(pool.tasks).toHaveLength(6);
      expect(snapshots).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('等待重试期间内容更新：取消旧重试，按新内容立即调度', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      pool.fail(0, 'backpressure');
      await tick();
      expect(vi.getTimerCount()).toBe(1);

      manager.subscribe(request('gen:1', 2, '一二', 'streaming'), () => {});
      expect(pool.tasks).toHaveLength(2);
      expect(pool.taskAt(1).request).toMatchObject({ source: '一二', sourcePhase: 'streaming' });
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(5_000);
      expect(pool.tasks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribe 清理退避计时器：推进计时器不再派发任务', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const unsubscribe = manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      pool.fail(0, 'backpressure');
      await tick();
      expect(vi.getTimerCount()).toBe(1);

      unsubscribe();
      vi.advanceTimersByTime(60_000);
      expect(pool.tasks).toHaveLength(1);
      expect(pool.released).toEqual(['gen:1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 清理退避计时器：推进计时器不再派发任务', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      manager.subscribe(request('msg:1', 1, '甲'), () => {});
      pool.fail(0, 'backpressure');
      await tick();
      expect(vi.getTimerCount()).toBe(1);

      manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(pool.tasks).toHaveLength(1);
      expect(pool.disposeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('取消与 dispose', () => {
  it('取消订阅后保留 1s 宽限再 release', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const unsubscribe = manager.subscribe(request('gen:1', 1, '快照', 'streaming'), () => {});
      pool.settle(0, okResult('快照'));
      await tick();
      unsubscribe();

      expect(pool.released).toEqual([]);
      vi.advanceTimersByTime(999);
      expect(pool.released).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(pool.released).toEqual(['gen:1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期内重新订阅撤销 release，并继续递增池 revision', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const first = manager.subscribe(request('gen:1', 1, '一', 'streaming'), () => {});
      pool.settle(0, okResult('一'));
      await tick();
      first();

      vi.advanceTimersByTime(500);
      const second = vi.fn();
      manager.subscribe(request('gen:1', 2, '二', 'streaming'), second);
      expect(pool.taskAt(1).request).toMatchObject({ documentId: 'gen:1', revision: 2 });

      pool.settle(1, okResult('二'));
      await tick();
      expect(second).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      expect(pool.released).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 清理宽限定时器与池，丢弃迟到结果，可重复调用', async () => {
    vi.useFakeTimers();
    try {
      const { manager, pool } = setup();
      const snapshots: ChatCompiledSnapshot[] = [];
      const unsubscribe = manager.subscribe(request('msg:1', 1, '甲'), (snapshot) =>
        snapshots.push(snapshot)
      );
      expect(vi.getTimerCount()).toBe(0);

      unsubscribe();
      expect(vi.getTimerCount()).toBe(1);

      manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(pool.disposeCalls).toBe(1);

      pool.settle(0, okResult('甲'));
      await tick();
      expect(snapshots).toEqual([]);

      vi.advanceTimersByTime(5_000);
      expect(pool.released).toEqual([]);

      manager.dispose();
      expect(pool.disposeCalls).toBe(1);

      const late = vi.fn();
      manager.subscribe(request('msg:2', 1, '乙'), late);
      expect(pool.tasks).toHaveLength(1);
      expect(late).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('滚动暂停', () => {
  it('setScrolling 映射池的 hold / resume，重复调用不重复通知', () => {
    const { manager, pool } = setup();
    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    expect(pool.holdCalls).toBe(0);

    manager.setScrolling?.(true);
    expect(pool.holdCalls).toBe(1);
    manager.setScrolling?.(true);
    expect(pool.holdCalls).toBe(1);

    manager.setScrolling?.(false);
    expect(pool.resumeCalls).toBe(1);
    manager.setScrolling?.(false);
    expect(pool.resumeCalls).toBe(1);
  });

  it('池尚未创建时先进入滚动期，创建后立即 hold', () => {
    const { manager, pool } = setup();
    manager.setScrolling?.(true);
    expect(pool.holdCalls).toBe(0);

    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    expect(pool.holdCalls).toBe(1);

    manager.setScrolling?.(false);
    expect(pool.resumeCalls).toBe(1);
  });
});