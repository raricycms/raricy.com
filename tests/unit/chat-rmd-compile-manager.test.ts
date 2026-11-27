// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-compile-manager.test.ts — 聊天编译管理器（订阅 / 顺序 / 缓存 / 池生命周期）
//
// 编译调度交给上游 `LocalCompilePool`，Manager 只保留聊天语义。这里用假池钉住：
// final 缓存同步命中、旧 revision 不覆盖新 revision、streaming 不覆盖 final、
// 策略失败与池失败的稳定错误码、unsubscribe 宽限后 release、hold/resume、
// dispose 清理，以及发给池的 documentId / 单调 scheduleRevision / priority。
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
  resolve(outcome: LocalCompilePoolOutcome): void;
  reject(error: unknown): void;
}

/** 最小 `LocalCompilePool`：任务挂起由测试手动 settle，记录 hold / resume / release。 */
class FakePool implements LocalCompilePool {
  readonly ready: Promise<LocalCompilePoolReadyEvent> = Promise.resolve({
    status: 'ready',
    availableWorkers: 1,
    failedWorkers: 0,
  });
  readonly tasks: FakePoolTask[] = [];
  readonly released: string[] = [];
  readonly cancelled: string[] = [];
  readonly priorities: { documentId: string; priority: number }[] = [];
  holdCalls = 0;
  resumeCalls = 0;
  disposeCalls = 0;

  schedule(request: LocalCompilePoolRequest): Promise<LocalCompilePoolOutcome> {
    return new Promise((resolve, reject) => {
      this.tasks.push({ request, resolve, reject });
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

  dispose(): void {
    this.disposeCalls += 1;
  }

  taskAt(index: number): FakePoolTask {
    const task = this.tasks[index];
    if (!task) throw new Error(`缺少第 ${index} 个池任务`);
    return task;
  }

  settle(index: number, result?: LocalCompileResult): void {
    const task = this.taskAt(index);
    task.resolve({
      documentId: task.request.documentId,
      revision: task.request.revision,
      source: task.request.source,
      result: result ?? okResult(task.request.source),
      duration: 1,
      mode: 'worker',
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