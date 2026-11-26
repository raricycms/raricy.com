// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-compile-manager.test.ts — 聊天编译管理器（多文档队列 / 顺序 / 缓存 / 资源）
//
// 用注入的假 Worker 钉住「错了也不报错」的调度边界：300 条历史不丢、同一 key 只编译
// 最新 revision、旧 streaming 不覆盖 final、缓存必须核对完整源码、取消不终止 Worker、
// Worker 崩溃 / 超时回退与有限重建、预热幂等且失败静默、滚动期暂停派发、dispose 清理。
//
// 文件末尾附带 Worker 侧 handler 的真实编译用例（同一 Agent 的编译基础设施）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { LocalCompileResult, LocalDocument, LocalNode } from 'reactive-md';
import {
  ChatFinalCache,
  chatCompileIdentity,
  createChatCompileManager,
  type ChatCompileWorkerLike,
  type ChatWorkerRequest,
  type ChatWorkerResponse,
} from '@/lib/chat-rmd/compile-manager';
import { createChatCompileWorkerHandler } from '@/lib/chat-rmd/compile.worker';
import type {
  ChatCompileRequest,
  ChatCompiledSnapshot,
  ChatSourcePhase,
} from '@/lib/chat-rmd/types';

type CompileMessage = Extract<ChatWorkerRequest, { type: 'compile' }>;

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

function collectNodes(nodes: readonly LocalNode[], type: string): LocalNode[] {
  const found: LocalNode[] = [];
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      if (node.type === type) found.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

function collectText(nodes: readonly LocalNode[]): string {
  const parts: string[] = [];
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      if (typeof node.value === 'string') parts.push(node.value);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return parts.join('');
}

class FakeWorker implements ChatCompileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: ChatWorkerRequest[] = [];
  terminated = 0;

  postMessage(message: ChatWorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  compiles(): CompileMessage[] {
    return this.posted.filter((entry): entry is CompileMessage => entry.type === 'compile');
  }

  compileAt(index: number): CompileMessage {
    const message = this.compiles()[index];
    if (!message) throw new Error(`缺少第 ${index} 条编译消息`);
    return message;
  }

  respond(message: ChatWorkerResponse): void {
    this.onmessage?.({ data: message });
  }

  respondOk(request: CompileMessage, source = request.source): void {
    this.respond({
      type: 'result',
      id: request.id,
      key: request.key,
      revision: request.revision,
      phase: request.phase,
      result: okResult(source),
    });
  }

  crash(): void {
    this.onerror?.(new Error('worker boom'));
  }
}

function setup(): {
  manager: ReturnType<typeof createChatCompileManager>;
  workers: FakeWorker[];
  worker: () => FakeWorker;
} {
  const workers: FakeWorker[] = [];
  const manager = createChatCompileManager(() => {
    const created = new FakeWorker();
    workers.push(created);
    return created;
  });
  return {
    manager,
    workers,
    worker: () => {
      const current = workers.at(-1);
      if (!current) throw new Error('尚未创建 Worker');
      return current;
    },
  };
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

describe('多文档队列', () => {
  it('300 条历史消息逐条编译，不丢消息', () => {
    const { manager, worker } = setup();
    const received = new Map<string, ChatCompiledSnapshot[]>();

    for (let index = 0; index < 300; index += 1) {
      const key = `msg:${index}`;
      manager.subscribe(request(key, 1, `source-${index}`), (snapshot) => {
        const list = received.get(snapshot.key) ?? [];
        list.push(snapshot);
        received.set(snapshot.key, list);
      });
    }

    const fake = worker();
    for (let index = 0; index < 300; index += 1) {
      const compile = fake.compileAt(index);
      expect(compile.key).toBe(`msg:${index}`);
      fake.respondOk(compile);
    }

    expect(fake.compiles()).toHaveLength(300);
    expect(received.size).toBe(300);
    for (let index = 0; index < 300; index += 1) {
      const snapshots = received.get(`msg:${index}`);
      expect(snapshots).toHaveLength(1);
      expect(snapshots?.[0]).toMatchObject({
        revision: 1,
        phase: 'final',
        errorCode: null,
      });
      expect(snapshots?.[0].document?.source).toBe(`source-${index}`);
    }
  });

  it('同一 key 只保留最新待编译 revision', () => {
    const { manager, worker } = setup();
    const first: ChatCompiledSnapshot[] = [];
    const second: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('gen:1', 1, '甲', 'streaming'), (snapshot) => first.push(snapshot));
    const fake = worker();
    const compile1 = fake.compileAt(0);

    manager.subscribe(request('gen:1', 2, '甲乙', 'streaming'), (snapshot) => second.push(snapshot));
    expect(fake.compiles()).toHaveLength(1);

    fake.respondOk(compile1);
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    const compile2 = fake.compileAt(1);
    expect(compile2.revision).toBe(2);
    fake.respondOk(compile2);
    expect(first.map((snapshot) => snapshot.revision)).toEqual([2]);
    expect(second.map((snapshot) => snapshot.revision)).toEqual([2]);
  });

  it('按 visible final → 最新生成快照 → nearby 调度，并轮转防饥饿', () => {
    const { manager, worker } = setup();

    manager.subscribe(request('A', 1, 'A'), () => {});
    manager.subscribe(request('C', 1, 'C', 'final', 'nearby'), () => {});
    manager.subscribe(request('D', 1, 'D', 'streaming', 'visible'), () => {});
    manager.subscribe(request('E', 1, 'E', 'streaming', 'nearby'), () => {});
    manager.subscribe(request('B', 1, 'B'), () => {});

    const fake = worker();
    expect(fake.compileAt(0).key).toBe('A');
    fake.respondOk(fake.compileAt(0));
    expect(fake.compileAt(1).key).toBe('B');
    fake.respondOk(fake.compileAt(1));
    expect(fake.compileAt(2).key).toBe('D');
    fake.respondOk(fake.compileAt(2));
    expect(fake.compileAt(3).key).toBe('C');
    fake.respondOk(fake.compileAt(3));
    expect(fake.compileAt(4).key).toBe('E');
  });

  it('streaming 快照携带 phase 与源码', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 3, '生成中', 'streaming'), (snapshot) =>
      snapshots.push(snapshot)
    );

    const fake = worker();
    const compile = fake.compileAt(0);
    expect(compile).toMatchObject({ key: 'msg:1', revision: 3, phase: 'streaming' });
    fake.respondOk(compile);

    expect(snapshots).toEqual([
      {
        key: 'msg:1',
        revision: 3,
        phase: 'streaming',
        document: makeDocument('生成中'),
        errorCode: null,
      },
    ]);
  });
});

describe('revision / phase 防过期', () => {
  it('旧 streaming 结果不覆盖 final', () => {
    const { manager, worker } = setup();
    const streamingSnapshots: ChatCompiledSnapshot[] = [];
    const finalSnapshots: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('msg:1', 1, '甲', 'streaming'), (snapshot) =>
      streamingSnapshots.push(snapshot)
    );
    const fake = worker();
    const streamingCompile = fake.compileAt(0);

    manager.subscribe(request('msg:1', 1, '甲', 'final'), (snapshot) =>
      finalSnapshots.push(snapshot)
    );
    fake.respondOk(streamingCompile);
    expect(streamingSnapshots).toEqual([]);
    expect(finalSnapshots).toEqual([]);

    const finalCompile = fake.compileAt(1);
    expect(finalCompile.phase).toBe('final');
    fake.respondOk(finalCompile);
    expect(streamingSnapshots).toHaveLength(1);
    expect(streamingSnapshots[0].phase).toBe('final');
    expect(finalSnapshots).toHaveLength(1);
    expect(finalSnapshots[0].phase).toBe('final');
  });

  it('更新 revision 在飞时，旧结果被丢弃', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    const fake = worker();
    const compile1 = fake.compileAt(0);

    manager.subscribe(request('msg:1', 2, '甲乙'), (snapshot) => snapshots.push(snapshot));
    fake.respondOk(compile1);
    expect(snapshots).toEqual([]);

    fake.respondOk(fake.compileAt(1));
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([2, 2]);
  });

  it('未知 id 的迟到消息被忽略', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

    const fake = worker();
    fake.respond({
      type: 'result',
      id: 999,
      key: 'msg:1',
      revision: 1,
      phase: 'final',
      result: okResult('甲'),
    });
    expect(snapshots).toEqual([]);
  });

  it('编译失败返回稳定诊断码', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

    const fake = worker();
    const compile = fake.compileAt(0);
    fake.respond({
      type: 'result',
      id: compile.id,
      key: compile.key,
      revision: compile.revision,
      phase: compile.phase,
      result: failedResult('local.budget'),
    });

    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: null, errorCode: 'local.budget' },
    ]);
  });
});

describe('final 缓存', () => {
  it('同 key / 同源码再次订阅直接命中，不重新编译', () => {
    const { manager, worker } = setup();
    const first = manager.subscribe(request('msg:1', 1, '正文'), () => {});
    const fake = worker();
    fake.respondOk(fake.compileAt(0));
    first();

    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 2, '正文'), (snapshot) => snapshots.push(snapshot));

    expect(fake.compiles()).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ revision: 2, phase: 'final', errorCode: null });
    expect(snapshots[0].document?.source).toBe('正文');
  });

  it('源码不同不会命中缓存', () => {
    const { manager, worker } = setup();
    const first = manager.subscribe(request('msg:1', 1, '正文'), () => {});
    const fake = worker();
    fake.respondOk(fake.compileAt(0));
    first();

    manager.subscribe(request('msg:1', 2, '另一段正文'), () => {});
    expect(fake.compiles()).toHaveLength(2);
    expect(fake.compileAt(1).revision).toBe(2);
  });

  it('streaming 结果不写缓存', () => {
    const { manager, worker } = setup();
    const first = manager.subscribe(request('msg:1', 1, '正文', 'streaming'), () => {});
    const fake = worker();
    fake.respondOk(fake.compileAt(0));
    first();

    manager.subscribe(request('msg:1', 2, '正文'), () => {});
    expect(fake.compiles()).toHaveLength(2);
    expect(fake.compileAt(1).phase).toBe('final');
  });

  it('哈希命中后仍核对完整源码', () => {
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

  it('总容量 300 条：最旧 final 被淘汰，最近仍命中', () => {
    const { manager, worker } = setup();
    for (let index = 0; index < 301; index += 1) {
      manager.subscribe(request(`msg:${index}`, 1, `source-${index}`), () => {});
    }
    const fake = worker();
    for (let index = 0; index < 301; index += 1) fake.respondOk(fake.compileAt(index));
    expect(fake.compiles()).toHaveLength(301);

    manager.subscribe(request('msg:300', 2, 'source-300'), () => {});
    expect(fake.compiles()).toHaveLength(301);

    manager.subscribe(request('msg:0', 2, 'source-0'), () => {});
    expect(fake.compiles()).toHaveLength(302);
    expect(fake.compileAt(301).key).toBe('msg:0');
  });
});

describe('取消与 Worker 生命周期', () => {
  it('短暂取消订阅后同 key 快照复用 Worker 增量会话', () => {
    vi.useFakeTimers();
    try {
      const { manager, worker } = setup();
      const first = manager.subscribe(request('gen:1', 1, '快照一', 'streaming'), () => {});
      const fake = worker();
      fake.respondOk(fake.compileAt(0));
      first();

      vi.advanceTimersByTime(500);
      manager.subscribe(request('gen:1', 2, '快照二', 'streaming'), () => {});

      expect(fake.terminated).toBe(0);
      expect(fake.posted.some((entry) => entry.type === 'release' && entry.key === 'gen:1')).toBe(false);
      expect(fake.compileAt(1)).toMatchObject({ key: 'gen:1', revision: 2, phase: 'streaming' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('取消订阅只撤销队列项，不终止共享 Worker', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    const cancelSecond = manager.subscribe(request('msg:2', 1, '乙'), () => {});
    const fake = worker();
    expect(fake.compiles()).toHaveLength(1);

    cancelSecond();
    expect(fake.terminated).toBe(0);

    fake.respondOk(fake.compileAt(0));
    expect(fake.compiles()).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(fake.terminated).toBe(0);

    manager.subscribe(request('msg:3', 1, '丙'), () => {});
    expect(fake.compiles()).toHaveLength(2);
    expect(fake.compileAt(1).key).toBe('msg:3');
    expect(fake.terminated).toBe(0);
  });

  it('取消在飞订阅后结果不再回调，Worker 仍存活', () => {
    const { manager, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    const unsubscribe = manager.subscribe(request('msg:1', 1, '甲'), (snapshot) =>
      snapshots.push(snapshot)
    );
    const fake = worker();
    const compile = fake.compileAt(0);

    unsubscribe();
    expect(fake.terminated).toBe(0);
    fake.respondOk(compile);
    expect(snapshots).toEqual([]);
    expect(fake.terminated).toBe(0);
    expect(fake.posted.some((entry) => entry.type === 'release' && entry.key === 'msg:1')).toBe(true);
  });

  it('Worker 崩溃回调 worker.error，并有限重建一次', () => {
    const { manager, workers, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    const first = worker();

    first.crash();
    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: null, errorCode: 'worker.error' },
    ]);
    expect(first.terminated).toBe(1);

    const secondSnapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => secondSnapshots.push(snapshot));
    expect(workers).toHaveLength(2);
    const second = worker();
    second.respondOk(second.compileAt(0));
    expect(secondSnapshots).toHaveLength(1);

    second.crash();
    expect(second.terminated).toBe(1);

    const thirdSnapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:3', 1, '丙'), (snapshot) => thirdSnapshots.push(snapshot));
    expect(workers).toHaveLength(2);
    expect(thirdSnapshots[0]).toMatchObject({ document: null, errorCode: 'worker.unavailable' });
  });

  it('Worker 构造失败回退 worker.unavailable，不循环重建', () => {
    let created = 0;
    const manager = createChatCompileManager(() => {
      created += 1;
      throw new Error('no worker');
    });
    const snapshots: ChatCompiledSnapshot[] = [];

    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: null, errorCode: 'worker.unavailable' },
    ]);
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => snapshots.push(snapshot));
    expect(created).toBe(1);
    expect(snapshots).toHaveLength(2);
  });

  it('编译超时回调 timeout，终止卡死的 Worker 后可重建', () => {
    vi.useFakeTimers();
    try {
      const { manager, workers, worker } = setup();
      const snapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

      const first = worker();
      vi.advanceTimersByTime(10_000);
      expect(snapshots).toEqual([
        { key: 'msg:1', revision: 1, phase: 'final', document: null, errorCode: 'timeout' },
      ]);
      expect(first.terminated).toBe(1);

      const secondSnapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => secondSnapshots.push(snapshot));
      expect(workers).toHaveLength(2);
      worker().respondOk(worker().compileAt(0));
      expect(secondSnapshots).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 终止 Worker、丢弃回调，并可重复调用', () => {
    const { manager, workers, worker } = setup();
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    const fake = worker();
    const compile = fake.compileAt(0);

    manager.dispose();
    expect(fake.terminated).toBe(1);
    fake.respondOk(compile);
    expect(snapshots).toEqual([]);

    manager.dispose();
    expect(fake.terminated).toBe(1);

    manager.subscribe(request('msg:2', 1, '乙'), () => {});
    expect(workers).toHaveLength(1);
  });

  it('dispose 清理超时定时器', () => {
    vi.useFakeTimers();
    try {
      const { manager, worker } = setup();
      const snapshots: ChatCompiledSnapshot[] = [];
      manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
      expect(worker().compiles()).toHaveLength(1);

      manager.dispose();
      vi.advanceTimersByTime(20_000);
      expect(snapshots).toEqual([]);
      expect(worker().terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('滚动暂停', () => {
  it('setScrolling(true) 不派发新编译，恢复后继续并正常投递快照', () => {
    const { manager, worker } = setup();
    expect(manager.setScrolling).toBeTypeOf('function');

    const first: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    const fake = worker();
    fake.respondOk(fake.compileAt(0));
    expect(first).toHaveLength(1);

    manager.setScrolling?.(true);
    const paused: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => paused.push(snapshot));
    expect(fake.compiles()).toHaveLength(1);
    expect(paused).toEqual([]);

    manager.setScrolling?.(false);
    expect(fake.compiles()).toHaveLength(2);
    expect(fake.compileAt(1)).toMatchObject({ key: 'msg:2', revision: 1, phase: 'final' });
    fake.respondOk(fake.compileAt(1));
    expect(paused).toEqual([
      {
        key: 'msg:2',
        revision: 1,
        phase: 'final',
        document: makeDocument('乙'),
        errorCode: null,
      },
    ]);
  });

  it('暂停期间在途任务完成仍投递结果，但不取下一个任务', () => {
    const { manager, worker } = setup();
    const first: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => first.push(snapshot));
    const fake = worker();
    const inFlight = fake.compileAt(0);

    const second: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:2', 1, '乙'), (snapshot) => second.push(snapshot));
    manager.setScrolling?.(true);

    fake.respondOk(inFlight);
    expect(first).toEqual([
      {
        key: 'msg:1',
        revision: 1,
        phase: 'final',
        document: makeDocument('甲'),
        errorCode: null,
      },
    ]);
    expect(fake.compiles()).toHaveLength(1);
    expect(second).toEqual([]);

    manager.setScrolling?.(false);
    expect(fake.compileAt(1).key).toBe('msg:2');
    fake.respondOk(fake.compileAt(1));
    expect(second).toHaveLength(1);
  });

  it('dispose 后 setScrolling 为 no-op', () => {
    const { manager, workers, worker } = setup();
    manager.subscribe(request('msg:1', 1, '甲'), () => {});
    const fake = worker();
    manager.dispose();

    expect(() => {
      manager.setScrolling?.(true);
      manager.setScrolling?.(false);
    }).not.toThrow();
    expect(workers).toHaveLength(1);
    expect(fake.compiles()).toHaveLength(1);
    expect(fake.terminated).toBe(1);
  });
});

describe('Worker 预热', () => {
  it('warmup 只创建一个 Worker，后续 subscribe 复用它', () => {
    const { manager, workers, worker } = setup();
    expect(manager.warmup).toBeTypeOf('function');
    expect(workers).toHaveLength(0);

    manager.warmup?.();
    manager.warmup?.();

    expect(workers).toHaveLength(1);
    const fake = worker();
    // 预热只建 Worker：不发消息、不入队、不 terminate。
    expect(fake.posted).toEqual([]);
    expect(fake.terminated).toBe(0);

    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));

    expect(workers).toHaveLength(1);
    fake.respondOk(fake.compileAt(0));
    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: makeDocument('甲'), errorCode: null },
    ]);
  });

  it('预热失败不抛给调用方，后续 subscribe 仍能创建 Worker 并编译', () => {
    let created = 0;
    const workers: FakeWorker[] = [];
    const manager = createChatCompileManager(() => {
      created += 1;
      if (created === 1) throw new Error('warmup boom');
      const fake = new FakeWorker();
      workers.push(fake);
      return fake;
    });

    expect(() => manager.warmup?.()).not.toThrow();
    expect(workers).toHaveLength(0);

    // 预热失败不把 Manager 判成 worker.unavailable：首次订阅照常建 Worker 并编译。
    const snapshots: ChatCompiledSnapshot[] = [];
    manager.subscribe(request('msg:1', 1, '甲'), (snapshot) => snapshots.push(snapshot));
    expect(workers).toHaveLength(1);
    const fake = workers[0];
    fake.respondOk(fake.compileAt(0));
    expect(snapshots).toEqual([
      { key: 'msg:1', revision: 1, phase: 'final', document: makeDocument('甲'), errorCode: null },
    ]);
  });

  it('dispose 后 warmup 为 no-op', () => {
    const neverStarted = setup();
    neverStarted.manager.dispose();
    expect(() => neverStarted.manager.warmup?.()).not.toThrow();
    expect(neverStarted.workers).toHaveLength(0);

    const { manager, workers, worker } = setup();
    manager.warmup?.();
    expect(workers).toHaveLength(1);
    const fake = worker();

    manager.dispose();
    expect(fake.terminated).toBe(1);

    manager.warmup?.();
    expect(workers).toHaveLength(1);
    expect(fake.terminated).toBe(1);
  });
});

describe('Worker handler（真实编译 + 策略）', () => {
  it('final 编译套用文档策略，图片不进入聊天 AST', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:1',
        revision: 1,
        source: '![外链](https://evil.example/x.png)',
        phase: 'final',
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      expect(message.result.ok).toBe(true);
      if (!message.result.ok) throw new Error('unreachable');
      expect(JSON.stringify(message.result.document)).not.toContain('"type":"image"');
      expect(message.result.document.capabilities?.policy).toEqual({
        enableCss: false,
        enableJavaScript: false,
        enableExtendedHtml: false,
      });
    } finally {
      handler.dispose();
    }
  });

  it('未声明插值按字面文本编译，表格不再整段回退源码', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:2',
        revision: 1,
        phase: 'final',
        source: [
          '| Item | Cost |',
          '| --- | ---: |',
          '| Venue | {{ venueCost }} |',
          '| Materials | {{ materialsCost }} |',
        ].join('\n'),
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      expect(message.result.ok).toBe(true);
      if (!message.result.ok) throw new Error('unreachable');

      const types: string[] = [];
      const values: string[] = [];
      const walk = (nodes: readonly LocalNode[]) => {
        for (const node of nodes) {
          types.push(node.type);
          if (typeof node.value === 'string') values.push(node.value);
          if (node.children) walk(node.children);
        }
      };
      walk(message.result.document.nodes);

      expect(types).toContain('table');
      expect(types).not.toContain('fallback');
      expect(values.join('')).toContain('{{ venueCost }}');
      expect(values.join('')).toContain('{{ materialsCost }}');
    } finally {
      handler.dispose();
    }
  });

  it('同一 key 连续 streaming 走增量会话，final / release 后释放', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'gen:1',
        revision: 1,
        source: '生成中的段落 '.repeat(400),
        phase: 'streaming',
      });
      expect(handler.sessionCount).toBe(1);
      const streaming = outputs[0];
      if (streaming.type !== 'result' || !streaming.result.ok) throw new Error('streaming 编译失败');
      expect(streaming.result.status).toBe('partial');

      handler.handle({
        type: 'compile',
        id: 2,
        key: 'gen:1',
        revision: 2,
        source: `${'生成中的段落 '.repeat(400)}结尾`,
        phase: 'final',
      });
      expect(handler.sessionCount).toBe(0);
      expect(outputs.map((message) => message.type)).toEqual(['result', 'result']);
      const final = outputs[1];
      if (final.type !== 'result' || !final.result.ok) throw new Error('final 编译失败');
      expect(final.result.status).toBe('valid');

      handler.handle({ type: 'release', key: 'gen:1' });
      expect(handler.sessionCount).toBe(0);
    } finally {
      handler.dispose();
    }
  });

  it('会话数上限 8（LRU）', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      for (let index = 0; index < 9; index += 1) {
        handler.handle({
          type: 'compile',
          id: index + 1,
          key: `gen:${index}`,
          revision: 1,
          source: `快照 ${index}`,
          phase: 'streaming',
        });
      }
      expect(handler.sessionCount).toBe(8);
      expect(outputs).toHaveLength(9);
    } finally {
      handler.dispose();
    }
  });

  it('final 不支持的 if 组件只降级自身，前后文照常渲染', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      const source = '前文\n\n<if test="{{ 1 }}">是</if>\n\n后文';
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:if',
        revision: 1,
        source,
        phase: 'final',
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      expect(message.result.ok, JSON.stringify(message.result)).toBe(true);
      if (!message.result.ok) throw new Error('unreachable');

      const document = message.result.document;
      expect(document.source).toBe(source);
      // 字面文本已从掩码恢复，组件以外的结构都保留。
      const paragraphs = collectNodes(document.nodes, 'paragraph');
      expect(paragraphs.map((node) => collectText(node.children ?? []))).toEqual([
        '前文',
        '后文',
      ]);
      expect(collectNodes(document.nodes, 'fallback').map((node) => node.value)).toEqual([
        '<if test="{{ 1 }}">是</if>',
      ]);
      // 不允许出现包裹整条消息的 fallback。
      expect(
        collectNodes(document.nodes, 'fallback').some((node) => node.value === source)
      ).toBe(false);
      expect(handler.sessionCount).toBe(0);
    } finally {
      handler.dispose();
    }
  });

  it('同一段落里坏的 alert 降级为源码，合法 alert 仍是组件', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      const source = '前文\n\n<alert tone="nope">坏</alert> <alert>好</alert>\n\n后文';
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:alert',
        revision: 1,
        source,
        phase: 'final',
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      expect(message.result.ok, JSON.stringify(message.result)).toBe(true);
      if (!message.result.ok) throw new Error('unreachable');

      const document = message.result.document;
      const alerts = collectNodes(document.nodes, 'component').filter(
        (node) => node.name === 'alert'
      );
      expect(alerts).toHaveLength(1);
      expect(collectText(alerts[0].children ?? [])).toBe('好');
      expect(collectNodes(document.nodes, 'fallback').map((node) => node.value)).toEqual([
        '<alert tone="nope">坏</alert>',
      ]);
      // 不存在包裹整条消息的 fallback。
      expect(
        collectNodes(document.nodes, 'fallback').some((node) => node.value === source)
      ).toBe(false);
      expect(collectText(document.nodes)).toContain('前文');
      expect(collectText(document.nodes)).toContain('后文');
      expect(collectText(document.nodes)).not.toContain('<alert>好</alert>');
    } finally {
      handler.dispose();
    }
  });

  it('final 不支持的 jump 组件局部降级为源码文本', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      const source = '<jump target="x">跳</jump>';
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:jump',
        revision: 1,
        source,
        phase: 'final',
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      expect(message.result.ok, JSON.stringify(message.result)).toBe(true);
      if (!message.result.ok) throw new Error('unreachable');

      expect(message.result.document.source).toBe(source);
      expect(message.result.document.nodes).toHaveLength(1);
      expect(message.result.document.nodes[0]).toMatchObject({
        type: 'fallback',
        value: source,
      });
      expect(collectNodes(message.result.document.nodes, 'component')).toEqual([]);
    } finally {
      handler.dispose();
    }
  });

  it('final 未闭合插值超限返回失败诊断，不抛异常', () => {
    const outputs: ChatWorkerResponse[] = [];
    const handler = createChatCompileWorkerHandler((message) => outputs.push(message));

    try {
      handler.handle({
        type: 'compile',
        id: 1,
        key: 'msg:1',
        revision: 1,
        source: `${'段落'.repeat(1_900)}${'{{ '.repeat(130)}`,
        phase: 'final',
      });

      expect(outputs).toHaveLength(1);
      const message = outputs[0];
      expect(message.type).toBe('result');
      if (message.type !== 'result') throw new Error('unreachable');
      // 预算失败是宿主主动拒绝，不做 streaming 降级。
      expect(message.result.ok).toBe(false);
      if (message.result.ok) throw new Error('unreachable');
      expect(message.result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'local.budget'
      );
      expect(handler.sessionCount).toBe(0);
    } finally {
      handler.dispose();
    }
  });
});
