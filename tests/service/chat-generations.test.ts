// chat-generations.test.ts —— 生成任务服务（R2）的状态机 / 预算 / 回执
//
// 【为什么测这些】生成任务的核心风险都是「不报错、只静默错」：
//   · 幂等键与容量判断若不在同步临界段复查，并发创建会突破每作者 1 个；
//   · seq 重放必须区分同内容（幂等）与异内容（冲突），否则会重复追加正文；
//   · complete 必须只落库一次（两次 complete / cancel 竞争），且写库成功后
//     DTO / 广播 / 通知故障不能再变成失败；
//   · 失权、超时、回执淘汰决定任务能否继续读/写，错了会放行或永久卡死。
// 这里跑真实 SQLite（不 mock Prisma）。sendMessage 用「默认直通、按需暂停/注入
// 失败」的包装，用来制造 finalizing 窗口与持久化后的故障；广播故障用 chat-bus
// 的包装注入。时间通过 __setChatGenerationClockForTest 注入，不等待真实 120 秒。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── sendMessage 注入点（默认直通真实实现）────────────────────────────────────
const sendGate = vi.hoisted(() => ({
  hold: false,
  entered: false,
  release: null as null | (() => void),
  calls: 0,
  forced: null as null | 'forbidden' | 'rateLimited',
  throwError: false,
}));

vi.mock('@/lib/chat/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/messages')>();
  return {
    ...actual,
    sendMessage: async (input: Parameters<typeof actual.sendMessage>[0]) => {
      sendGate.calls += 1;
      if (sendGate.throwError) throw new Error('injected write failure');
      if (sendGate.forced === 'forbidden') {
        return { ok: false as const, error: 'forbidden' as const, message: '无权在该会话发言' };
      }
      if (sendGate.forced === 'rateLimited') {
        return { ok: false as const, error: 'rateLimited' as const, message: '发言过于频繁，请稍后再试' };
      }
      if (sendGate.hold) {
        sendGate.entered = true;
        await new Promise<void>((resolve) => {
          sendGate.release = resolve;
        });
      }
      return actual.sendMessage(input);
    },
  };
});

// ── 频道访问鉴权注入点（默认直通；可按住让并发请求都停在异步鉴权窗口）────────
// 只用于创建并发的配额用例：把两个请求都按在 canAccessChannel 里，释放后它们的
// 预检查重都在「谁都没登记」时完成 —— 早期扣配额的实现必然各扣一次，能稳定变红。
const accessGate = vi.hoisted(() => ({
  hold: false,
  entered: 0,
  releases: [] as Array<() => void>,
}));

vi.mock('@/lib/chat/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/channels')>();
  return {
    ...actual,
    canAccessChannel: async (...args: Parameters<typeof actual.canAccessChannel>) => {
      const result = await actual.canAccessChannel(...args);
      if (accessGate.hold) {
        accessGate.entered += 1;
        await new Promise<void>((resolve) => accessGate.releases.push(resolve));
      }
      return result;
    },
  };
});

// ── 广播故障注入（DTO / SSE 推送失败不影响已提交的正式消息）──────────────────
const busGate = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/chat-bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-bus')>();
  return {
    ...actual,
    publishToAll: (...args: Parameters<typeof actual.publishToAll>) => {
      if (busGate.fail) throw new Error('injected bus failure');
      return actual.publishToAll(...args);
    },
    publishToUsers: (...args: Parameters<typeof actual.publishToUsers>) => {
      if (busGate.fail) throw new Error('injected bus failure');
      return actual.publishToUsers(...args);
    },
  };
});

// ── DTO 构建故障注入（create 成功后、attachImagesAndReplies 抛错）──────────────
const frameGate = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/frame-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/frame-service')>();
  return {
    ...actual,
    frameUrlFor: (row: Parameters<typeof actual.frameUrlFor>[0]) => {
      if (frameGate.fail) throw new Error('injected dto failure');
      return actual.frameUrlFor(row);
    },
  };
});

import {
  __resetChatGenerations,
  __setChatGenerationClockForTest,
  appendGenerationChunk,
  cancelGeneration,
  CHAT_GENERATION_IDLE_TIMEOUT_MS,
  completeGeneration,
  createGeneration,
  getGeneration,
} from '@/lib/chat/generations';
import { __resetChatBus, subscribe as subscribeChat, type ChatSubscriber } from '@/lib/chat-bus';
import { __resetRateLimitStore, rateLimit, RULES, recordRateLimitHit } from '@/lib/rate-limit';
import { listChannelsForUser, startDirectChannel } from '@/lib/chat-service';
import { CHAT_LOBBY_ID, CHAT_TEXT_MAX, type ChatStreamEvent } from '@/lib/chat-shared';
import { makeUser, prisma, resetDb } from '../helpers/db';

// ── 时钟 ────────────────────────────────────────────────────────────────────
let fakeNow = 1_000_000;
const advance = (ms: number) => {
  fakeNow += ms;
};

// ── 事件采集 ────────────────────────────────────────────────────────────────
interface CapturedStream {
  frames: ChatStreamEvent[];
  raw: string[];
  off: () => void;
}

const openStreams: CapturedStream[] = [];

function connect(userId: string, lobbyBlocked = false): CapturedStream {
  const raw: string[] = [];
  const sub: ChatSubscriber = {
    userId,
    lobbyBlocked,
    write: (chunk) => {
      raw.push(chunk);
      return true;
    },
    close: () => {},
  };
  const off = subscribeChat(sub);
  const stream: CapturedStream = { raw, frames: [], off };
  openStreams.push(stream);
  return stream;
}

/** 把已收到的原始帧解析成事件（注释帧 / 心跳忽略）。 */
function framesOf(stream: CapturedStream): ChatStreamEvent[] {
  return stream.raw
    .filter((chunk) => chunk.includes('data: '))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6).trim()) as ChatStreamEvent);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 在「下一次异步等待期间」推进注入时钟。
 *
 * 用法：调用方把操作包进 `run`。这里先登记一个 0ms 定时器并**同步忙等**到它到期
 * （Node 把 0 夹到 1ms），再同步启动 `run`：定时器回调只能在下一次让出主线程时执行，
 * 也就是 `run` 里初始 sweep 之后、首个 `await`（频道访问查询）期间 —— 正是要覆盖的
 * 「异步鉴权窗口」。不用真实睡眠，也不需要给生产代码加钩子。
 */
async function advanceClockDuringNextAwait<T>(
  advanceBy: () => void,
  run: () => Promise<T>
): Promise<T> {
  const timer = setTimeout(advanceBy, 0);
  const due = performance.now() + 5;
  while (performance.now() < due) {
    // spin：仅让定时器到期，不让出主线程（否则会先跑完 run 之前的逻辑）
  }
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetChatGenerations();
  __resetChatBus();
  __resetRateLimitStore();
  fakeNow = 1_000_000;
  __setChatGenerationClockForTest(() => fakeNow);
  sendGate.hold = false;
  sendGate.entered = false;
  sendGate.release = null;
  sendGate.calls = 0;
  sendGate.forced = null;
  sendGate.throwError = false;
  busGate.fail = false;
  frameGate.fail = false;
  accessGate.hold = false;
  accessGate.entered = 0;
  accessGate.releases = [];
});

afterEach(() => {
  while (openStreams.length) openStreams.pop()!.off();
  __resetChatGenerations();
  __resetChatBus();
});

async function makeCore() {
  return makeUser({ role: 'core' });
}

async function createGen(
  authorId: string,
  opts: { channelId?: string; clientRequestId?: string; replyTo?: number | null } = {}
) {
  const outcome = await createGeneration({
    authorId,
    channelId: opts.channelId ?? CHAT_LOBBY_ID,
    lobbyBlocked: false,
    clientRequestId: opts.clientRequestId ?? crypto.randomUUID(),
    replyTo: opts.replyTo ?? null,
  });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.error}`);
  return outcome.result;
}

async function chunk(authorId: string, generationId: string, seq: number, delta: string) {
  return appendGenerationChunk({
    authorId,
    generationId,
    lobbyBlocked: false,
    seq,
    delta,
  });
}

async function complete(authorId: string, generationId: string, lastSeq: number) {
  return completeGeneration({ authorId, generationId, lobbyBlocked: false, lastSeq });
}

async function cancel(authorId: string, generationId: string) {
  return cancelGeneration({ authorId, generationId, lobbyBlocked: false });
}

async function get(authorId: string, generationId: string) {
  return getGeneration({ authorId, generationId, lobbyBlocked: false });
}

/**
 * 并发执行两个创建，并把它们都按在异步鉴权窗口里，一起放行。
 *
 * 释放后两份请求的「预检查重」都在任一方登记之前完成 —— 若创建配额仍在异步查询
 * 之前扣减，这种交错必然各扣一次（早期实现会在这里变红）。
 */
async function createConcurrentlyHeld<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>
): Promise<[A, B]> {
  accessGate.hold = true;
  accessGate.entered = 0;
  accessGate.releases = [];
  const pending = Promise.all([first(), second()]);
  for (let i = 0; i < 400 && accessGate.entered < 2; i++) await sleep(5);
  expect(accessGate.entered).toBe(2);
  accessGate.hold = false;
  for (const release of accessGate.releases.splice(0)) release();
  return pending;
}

describe('创建：幂等、元数据冲突与容量', () => {
  it('同一幂等键重放返回同一个 generation_id；reply_to 不同则 409', async () => {
    const author = await makeCore();
    const first = await createGen(author.id, { clientRequestId: 'idem-1' });
    const replay = await createGen(author.id, { clientRequestId: 'idem-1' });
    expect(replay.generation_id).toBe(first.generation_id);
    expect(replay.next_seq).toBe(1);

    const conflict = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: 'idem-1',
      replyTo: 42,
    });
    expect(conflict).toMatchObject({ ok: false, status: 409, error: 'conflict' });
  });

  it('幂等键在保留期内跨终态复用；cancel 后重放仍给同一个 id 与 next_seq', async () => {
    const author = await makeCore();
    const created = await createGen(author.id, { clientRequestId: 'idem-2' });
    expect((await chunk(author.id, created.generation_id, 1, 'abc')).ok).toBe(true);
    expect((await cancel(author.id, created.generation_id)).ok).toBe(true);

    const replay = await createGen(author.id, { clientRequestId: 'idem-2' });
    expect(replay.generation_id).toBe(created.generation_id);
    expect(replay.next_seq).toBe(2);
  });

  it('每作者同时只能有 1 个活动任务（含 finalizing 之外的状态）；释放后可再建', async () => {
    const author = await makeCore();
    const first = await createGen(author.id);
    const second = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(second).toMatchObject({ ok: false, status: 503, error: 'capacity' });

    await cancel(author.id, first.generation_id);
    const third = await createGen(author.id);
    expect(third.generation_id).not.toBe(first.generation_id);
  });

  it('全站最多 32 个活动任务，第 33 个 503 capacity', async () => {
    const authors = await Promise.all(Array.from({ length: 33 }, () => makeCore()));
    for (const author of authors.slice(0, 32)) {
      await createGen(author.id);
    }
    const overflow = await createGeneration({
      authorId: authors[32].id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(overflow).toMatchObject({ ok: false, status: 503, error: 'capacity' });
  });

  it('创建限频 12 次/分钟/作者；取消不消耗创建额度', async () => {
    const author = await makeCore();
    for (let i = 0; i < RULES.chatGenerationCreateMinute.limit; i++) {
      const created = await createGen(author.id);
      await cancel(author.id, created.generation_id);
    }
    const limited = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(limited).toMatchObject({ ok: false, status: 429, error: 'rate_limited' });
  });

  it('同一 client_request_id 并发创建：同一个 id、只登记一个任务、只扣一次创建配额', async () => {
    const author = await makeCore();
    const createWithKey = (clientRequestId: string) =>
      createGeneration({
        authorId: author.id,
        channelId: CHAT_LOBBY_ID,
        lobbyBlocked: false,
        clientRequestId,
        replyTo: null,
      });

    const [a, b] = await createConcurrentlyHeld(
      () => createWithKey('concurrent-same'),
      () => createWithKey('concurrent-same')
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.result.generation_id).toBe(a.result.generation_id);

    // 只登记了一个活动任务：换 key 再建会撞每作者 1 个（在扣创建配额之前就返回）。
    const blocked = await createWithKey('concurrent-other');
    expect(blocked).toMatchObject({ ok: false, status: 503, error: 'capacity' });

    // 创建桶只应命中 1 次；探针自身消耗一次 → remaining = limit - 2。
    const probe = rateLimit(`chatgen:create:${author.id}`, RULES.chatGenerationCreateMinute);
    expect(probe.remaining).toBe(RULES.chatGenerationCreateMinute.limit - 2);
  });

  it('不同 key 并发创建：一个成功、另一个 503 capacity，且不额外扣创建配额', async () => {
    const author = await makeCore();
    const createWithKey = (clientRequestId: string) =>
      createGeneration({
        authorId: author.id,
        channelId: CHAT_LOBBY_ID,
        lobbyBlocked: false,
        clientRequestId,
        replyTo: null,
      });

    const results = await createConcurrentlyHeld(
      () => createWithKey('concurrent-a'),
      () => createWithKey('concurrent-b')
    );
    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: 503, error: 'capacity' });
    if (!succeeded[0].ok) return;

    // 成功的任务确实可用；失败者没有留下第二份任务或第二次扣费。
    expect((await chunk(author.id, succeeded[0].result.generation_id, 1, 'x')).ok).toBe(true);
    const probe = rateLimit(`chatgen:create:${author.id}`, RULES.chatGenerationCreateMinute);
    expect(probe.remaining).toBe(RULES.chatGenerationCreateMinute.limit - 2);
  });

  it('参数形状与频道访问错误', async () => {
    const author = await makeCore();
    const missingKey = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: undefined,
      replyTo: null,
    });
    expect(missingKey).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });

    const badReply = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: -1,
    });
    expect(badReply).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });

    const missingChannel = await createGeneration({
      authorId: author.id,
      channelId: 'no-such-channel',
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(missingChannel).toMatchObject({ ok: false, status: 404, error: 'not_found' });

    const focusBlocked = await createGeneration({
      authorId: author.id,
      channelId: CHAT_LOBBY_ID,
      lobbyBlocked: true,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(focusBlocked).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });
});

describe('分块：序号、重放与预算', () => {
  it('接受 seq===next_seq 才追加；旧序号同内容幂等、异内容冲突、跳号冲突', async () => {
    const author = await makeCore();
    const stream = connect(author.id);
    const created = await createGen(author.id);

    const first = await chunk(author.id, created.generation_id, 1, '你好');
    expect(first).toMatchObject({ ok: true, result: { accepted_seq: 1, next_seq: 2, revision: 1 } });
    expect(framesOf(stream).filter((f) => f.type === 'generation_snapshot')).toHaveLength(1);

    // 同内容重放：返回原确认，不追加、不广播
    const replay = await chunk(author.id, created.generation_id, 1, '你好');
    expect(replay).toMatchObject({ ok: true, result: { accepted_seq: 1, next_seq: 2, revision: 1 } });
    await sleep(30);
    expect(framesOf(stream).filter((f) => f.type === 'generation_snapshot')).toHaveLength(1);

    const different = await chunk(author.id, created.generation_id, 1, '别的内容');
    expect(different).toMatchObject({ ok: false, status: 409, error: 'conflict', extra: { next_seq: 2 } });

    const gap = await chunk(author.id, created.generation_id, 3, '跳号');
    expect(gap).toMatchObject({ ok: false, status: 409, error: 'conflict', extra: { next_seq: 2 } });

    const second = await chunk(author.id, created.generation_id, 2, '世界');
    expect(second).toMatchObject({ ok: true, result: { accepted_seq: 2, next_seq: 3, revision: 2 } });

    // 任务已经前进到 seq 3：重放 seq 1 仍返回**当时**的确认（next_seq=2/revision=1），
    // 不是当前值 —— 否则调用方可能据此跳过尚未确认的片段。
    const lateReplay = await chunk(author.id, created.generation_id, 1, '你好');
    expect(lateReplay).toMatchObject({
      ok: true,
      result: { accepted_seq: 1, next_seq: 2, revision: 1 },
    });
  });

  it('seq / delta 形状非法 → 400 invalid_request', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    for (const [seq, delta] of [
      [0, 'x'],
      [1.5, 'x'],
      ['1', 'x'],
      [1, ''],
      [1, 42],
    ] as const) {
      const res = await appendGenerationChunk({
        authorId: author.id,
        generationId: created.generation_id,
        lobbyBlocked: false,
        seq,
        delta,
      });
      expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
    }
  });

  it('单片段 1024 字符、累计未 trim 正文 CHAT_TEXT_MAX、片段数 512 上限', async () => {
    const author = await makeCore();

    // 单片段超长
    const single = await createGen(author.id);
    const tooBig = await chunk(author.id, single.generation_id, 1, 'a'.repeat(1025));
    expect(tooBig).toMatchObject({ ok: false, status: 413, error: 'too_large' });
    await cancel(author.id, single.generation_id);

    // 累计正文超长（每片 1024，5 片 > 5000）
    const cumulative = await createGen(author.id);
    for (let seq = 1; seq <= 4; seq++) {
      expect((await chunk(author.id, cumulative.generation_id, seq, 'b'.repeat(1024))).ok).toBe(true);
    }
    const overSource = await chunk(author.id, cumulative.generation_id, 5, 'b'.repeat(1024));
    expect(overSource).toMatchObject({ ok: false, status: 413, error: 'too_large' });
    expect(CHAT_TEXT_MAX).toBe(5000);
    await cancel(author.id, cumulative.generation_id);

    // 片段数上限：512 个 1 字符片段后第 513 个被拒
    const many = await createGen(author.id);
    for (let seq = 1; seq <= 512; seq++) {
      const res = await chunk(author.id, many.generation_id, seq, 'c');
      expect(res.ok, `chunk ${seq}`).toBe(true);
    }
    const overflow = await chunk(author.id, many.generation_id, 513, 'c');
    expect(overflow).toMatchObject({ ok: false, status: 413, error: 'too_large' });
  });

  it('分块限频 600 次/分钟/作者', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    for (let i = 0; i < RULES.chatGenerationChunkMinute.limit; i++) {
      recordRateLimitHit(`chatgen:chunk:${author.id}`);
    }
    const limited = await chunk(author.id, created.generation_id, 1, 'x');
    expect(limited).toMatchObject({ ok: false, status: 429, error: 'rate_limited' });
  });

  it('非作者不能写任务', async () => {
    const author = await makeCore();
    const other = await makeCore();
    const created = await createGen(author.id);
    expect(await chunk(other.id, created.generation_id, 1, 'x')).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
    expect(await complete(other.id, created.generation_id, 0)).toMatchObject({ ok: false, status: 403 });
    expect(await cancel(other.id, created.generation_id)).toMatchObject({ ok: false, status: 403 });
    expect(await get(other.id, created.generation_id)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('完成：一次落库、竞争与错误映射', () => {
  it('两次 complete 只落库一次；重放不再带 chat_message', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '最终正文');

    const first = await complete(author.id, created.generation_id, 1);
    expect(first).toMatchObject({ ok: true, httpStatus: 200 });
    if (!first.ok) return;
    expect(first.result.status).toBe('completed');
    expect(first.result.message_id).toBeTypeOf('number');
    expect(first.result.chat_message?.content).toBe('最终正文');

    const replay = await complete(author.id, created.generation_id, 1);
    expect(replay).toMatchObject({ ok: true, httpStatus: 200 });
    if (!replay.ok) return;
    expect(replay.result.message_id).toBe(first.result.message_id);
    expect(replay.result.chat_message).toBeUndefined();

    expect(await prisma.chatMessage.count()).toBe(1);
    expect(sendGate.calls).toBe(1);
  });

  it('并发 complete（同 last_seq）共用同一个 Promise，只落库一次', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '并发');

    const [a, b] = await Promise.all([
      complete(author.id, created.generation_id, 1),
      complete(author.id, created.generation_id, 1),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.message_id).toBe(b.result.message_id);
    expect(await prisma.chatMessage.count()).toBe(1);
    expect(sendGate.calls).toBe(1);
  });

  it('last_seq 不一致 → 409 conflict 并给 next_seq', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, 'abc');
    const wrong = await complete(author.id, created.generation_id, 0);
    expect(wrong).toMatchObject({ ok: false, status: 409, error: 'conflict', extra: { next_seq: 2 } });
  });

  it('未提交片段时 complete(last_seq:0) 按空正文失败，重复请求结果稳定', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    const first = await complete(author.id, created.generation_id, 0);
    expect(first).toMatchObject({ ok: true, httpStatus: 400 });
    if (!first.ok) return;
    expect(first.result).toEqual({ status: 'failed', error: 'empty' });

    const replay = await complete(author.id, created.generation_id, 0);
    expect(replay).toMatchObject({ ok: true, httpStatus: 400 });
    if (!replay.ok) return;
    expect(replay.result).toEqual({ status: 'failed', error: 'empty' });
    expect(await prisma.chatMessage.count()).toBe(0);

    // 只提交空白片段：trim 后仍为空 → 同样 empty
    const blank = await createGen(author.id);
    await chunk(author.id, blank.generation_id, 1, '   ');
    const blankDone = await complete(author.id, blank.generation_id, 1);
    expect(blankDone).toMatchObject({ ok: true, httpStatus: 400 });
    if (!blankDone.ok) return;
    expect(blankDone.result).toEqual({ status: 'failed', error: 'empty' });
  });

  it('reply_to 指向不存在的消息 → failed reply_invalid（沿用发送内核校验）', async () => {
    const author = await makeCore();
    const created = await createGen(author.id, { replyTo: 999_999 });
    await chunk(author.id, created.generation_id, 1, '引用一个不存在的消息');
    const done = await complete(author.id, created.generation_id, 1);
    expect(done).toMatchObject({ ok: true, httpStatus: 400 });
    if (!done.ok) return;
    expect(done.result).toEqual({ status: 'failed', error: 'reply_invalid' });
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('sendMessage 429/403 → failed + send_rate_limited / send_forbidden，且不重放写入', async () => {
    const author = await makeCore();

    sendGate.forced = 'rateLimited';
    const created429 = await createGen(author.id);
    await chunk(author.id, created429.generation_id, 1, '配额');
    const limited = await complete(author.id, created429.generation_id, 1);
    expect(limited).toMatchObject({ ok: true, httpStatus: 429 });
    if (!limited.ok) return;
    expect(limited.result).toEqual({ status: 'failed', error: 'send_rate_limited' });

    const replay = await complete(author.id, created429.generation_id, 1);
    expect(replay).toMatchObject({ ok: true, httpStatus: 429 });
    expect(sendGate.calls).toBe(1);

    sendGate.forced = 'forbidden';
    const created403 = await createGen(author.id);
    await chunk(author.id, created403.generation_id, 1, '失权');
    const forbidden = await complete(author.id, created403.generation_id, 1);
    expect(forbidden).toMatchObject({ ok: true, httpStatus: 403 });
    if (!forbidden.ok) return;
    expect(forbidden.result).toEqual({ status: 'failed', error: 'send_forbidden' });
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('写库抛错且无 message_id → commit_unknown（retryable:false），重放不重发', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '未知');

    sendGate.throwError = true;
    const first = await complete(author.id, created.generation_id, 1);
    expect(first).toMatchObject({ ok: true, httpStatus: 500 });
    if (!first.ok) return;
    expect(first.result).toEqual({
      status: 'commit_unknown',
      error: 'commit_unknown',
      retryable: false,
    });

    const replay = await complete(author.id, created.generation_id, 1);
    expect(replay).toMatchObject({ ok: true, httpStatus: 500 });
    if (!replay.ok) return;
    expect(replay.result.status).toBe('commit_unknown');
    expect(sendGate.calls).toBe(1);
    expect(await prisma.chatMessage.count()).toBe(0);

    // 不能恢复 active：分块被拒（终态冲突），而非被接受
    const late = await chunk(author.id, created.generation_id, 2, 'x');
    expect(late).toMatchObject({ ok: false, status: 409, error: 'conflict' });
  });

  it('onPersisted 之后 DTO 构建失败仍按 completed 返回原 id', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '持久化成功');

    frameGate.fail = true; // attachImagesAndReplies 抛错（create 已提交，onPersisted 已记录）
    const done = await complete(author.id, created.generation_id, 1);
    frameGate.fail = false;
    expect(done).toMatchObject({ ok: true, httpStatus: 200 });
    if (!done.ok) return;
    expect(done.result.status).toBe('completed');
    expect(done.result.message_id).toBeTypeOf('number');
    expect(done.result.chat_message).toBeUndefined();
    expect(await prisma.chatMessage.count()).toBe(1);

    const replay = await complete(author.id, created.generation_id, 1);
    expect(replay).toMatchObject({ ok: true, httpStatus: 200 });
    if (!replay.ok) return;
    expect(replay.result.message_id).toBe(done.result.message_id);
    expect(await prisma.chatMessage.count()).toBe(1);
    expect(sendGate.calls).toBe(1);
  });

  it('onPersisted 之后广播失败仍按 completed 返回原 id', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '广播失败');

    busGate.fail = true;
    const done = await complete(author.id, created.generation_id, 1);
    busGate.fail = false;
    expect(done).toMatchObject({ ok: true, httpStatus: 200 });
    if (!done.ok) return;
    expect(done.result.status).toBe('completed');
    expect(done.result.message_id).toBeTypeOf('number');
    expect(await prisma.chatMessage.count()).toBe(1);
  });

  it('正式发送只在 complete 扣一次 chatMinute；create/chunk 不占正式配额', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '配额一次');
    expect((await complete(author.id, created.generation_id, 1)).ok).toBe(true);

    // 探针本身消耗 1 次：完成 1 次 + 探针 1 次 → remaining = limit - 2
    const probe = rateLimit(`chat:m:${author.id}`, RULES.chatMinute);
    expect(probe.remaining).toBe(RULES.chatMinute.limit - 2);

    // 重放不再发送：再探一次 → 完成 1 + 探针 2 → remaining = limit - 3
    await complete(author.id, created.generation_id, 1);
    const probe2 = rateLimit(`chat:m:${author.id}`, RULES.chatMinute);
    expect(probe2.remaining).toBe(RULES.chatMinute.limit - 3);
  });
});

describe('取消与竞争', () => {
  it('cancel 先成功 → complete 409，不发布；cancel 重放幂等', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '取消我');

    const cancelled = await cancel(author.id, created.generation_id);
    expect(cancelled).toMatchObject({ ok: true, result: { status: 'cancelled' } });

    const again = await cancel(author.id, created.generation_id);
    expect(again).toMatchObject({ ok: true, result: { status: 'cancelled' } });

    const lateComplete = await complete(author.id, created.generation_id, 1);
    expect(lateComplete).toMatchObject({
      ok: false,
      status: 409,
      error: 'conflict',
      extra: { status: 'cancelled' },
    });
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('complete 进入 finalizing：拒绝 chunk 与 cancel，不同 last_seq 拒绝，同参数共用一个 Promise', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '冻结');

    sendGate.hold = true;
    const completing = complete(author.id, created.generation_id, 1);
    // 等 sendMessage 真正被调用（说明 active→finalizing 已完成）
    for (let i = 0; i < 200 && !sendGate.entered; i++) await sleep(5);
    expect(sendGate.entered).toBe(true);

    expect(await chunk(author.id, created.generation_id, 2, '再塞')).toMatchObject({
      ok: false,
      status: 409,
      error: 'conflict',
    });
    expect(await cancel(author.id, created.generation_id)).toMatchObject({
      ok: false,
      status: 409,
      error: 'conflict',
    });
    expect(await complete(author.id, created.generation_id, 0)).toMatchObject({
      ok: false,
      status: 409,
      error: 'conflict',
    });

    // finalizing 不被清扫：推进到总时长之后仍保持 finalizing
    advance(20 * 60 * 1000);
    const status = await get(author.id, created.generation_id);
    expect(status).toMatchObject({ ok: true, result: { status: 'finalizing' } });

    const shared = complete(author.id, created.generation_id, 1);
    sendGate.release?.();
    const [first, second] = await Promise.all([completing, shared]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.status).toBe('completed');
    expect(second.result.message_id).toBe(first.result.message_id);
    expect(await prisma.chatMessage.count()).toBe(1);
    expect(sendGate.calls).toBe(1);
  });

  it('complete 已完成后 cancel 返回已有终态（completed）', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '已完成');
    await complete(author.id, created.generation_id, 1);

    const cancelled = await cancel(author.id, created.generation_id);
    expect(cancelled).toMatchObject({ ok: true, result: { status: 'completed' } });
  });

  it('终态取消合并中的快照计时器：终态后不再广播快照', async () => {
    const author = await makeCore();
    const stream = connect(author.id);
    const created = await createGen(author.id);

    // 第一片立即广播；第二片落在 200ms 节流窗口里，登记了合并计时器
    await chunk(author.id, created.generation_id, 1, '一');
    await chunk(author.id, created.generation_id, 2, '二');
    await cancel(author.id, created.generation_id);
    await sleep(300);

    const frames = framesOf(stream);
    const snapshots = frames.filter((f) => f.type === 'generation_snapshot');
    const terminals = frames.filter((f) => f.type === 'generation_terminal');
    expect(snapshots).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    // 终态帧在快照之后；不允许出现「终态之后又补一帧快照」
    expect(frames.indexOf(terminals[0])).toBeGreaterThan(frames.indexOf(snapshots[0]));
    expect(frames.slice(frames.indexOf(terminals[0]) + 1).some((f) => f.type === 'generation_snapshot')).toBe(false);
  });
});

describe('超时、失权与回执', () => {
  it('空闲 120 秒过期：GET 200 expired，chunk/complete/cancel 均 410 gone', async () => {
    const author = await makeCore();
    const stream = connect(author.id);
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, '半截');
    await sleep(30);

    advance(120_000);
    const status = await get(author.id, created.generation_id);
    expect(status).toMatchObject({ ok: true, result: { status: 'expired' } });
    expect(
      framesOf(stream).filter(
        (f) => f.type === 'generation_terminal' && (f as { status?: string }).status === 'expired'
      )
    ).toHaveLength(1);

    expect(await chunk(author.id, created.generation_id, 2, '过期后')).toMatchObject({
      ok: false,
      status: 410,
      error: 'gone',
    });
    expect(await complete(author.id, created.generation_id, 1)).toMatchObject({
      ok: false,
      status: 410,
      error: 'gone',
    });
    expect(await cancel(author.id, created.generation_id)).toMatchObject({
      ok: false,
      status: 410,
      error: 'gone',
    });
  });

  it('总时长 10 分钟：即使每 100 秒有新片段，到点仍过期', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    for (let i = 1; i <= 5; i++) {
      advance(100_000);
      expect((await chunk(author.id, created.generation_id, i, 'c')).ok).toBe(true);
    }
    advance(100_000); // 总时长 600s；距最后片段仅 100s（空闲未到 120s）
    const status = await get(author.id, created.generation_id);
    expect(status).toMatchObject({ ok: true, result: { status: 'expired' } });
  });

  it('鉴权 await 期间越过空闲截止点：chunk 同步复查后 410，不续期、不再发快照', async () => {
    const author = await makeCore();
    const stream = connect(author.id);
    const created = await createGen(author.id);
    expect((await chunk(author.id, created.generation_id, 1, '第一段')).ok).toBe(true);
    await sleep(30);

    // 距空闲截止点只差 1ms：chunk 入口的 sweep 会放行；鉴权 await 期间时钟被推过线。
    advance(CHAT_GENERATION_IDLE_TIMEOUT_MS - 1);
    const res = await advanceClockDuringNextAwait(
      () => {
        fakeNow += 2;
      },
      () => chunk(author.id, created.generation_id, 2, '不该被接受')
    );

    expect(res).toMatchObject({ ok: false, status: 410, error: 'gone', extra: { next_seq: 2 } });
    // 分块没有续期：任务已过期，序号停在 2。
    expect(await get(author.id, created.generation_id)).toMatchObject({
      ok: true,
      result: { status: 'expired', next_seq: 2 },
    });
    const frames = framesOf(stream);
    expect(frames.filter((f) => f.type === 'generation_snapshot')).toHaveLength(1);
    const terminals = frames.filter(
      (f) => f.type === 'generation_terminal' && (f as { status?: string }).status === 'expired'
    );
    expect(terminals).toHaveLength(1);
  });

  it('鉴权 await 期间越过空闲截止点：complete 不给提交权，任务 expired 且不落库', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    expect((await chunk(author.id, created.generation_id, 1, '将不发布')).ok).toBe(true);

    advance(CHAT_GENERATION_IDLE_TIMEOUT_MS - 1);
    const done = await advanceClockDuringNextAwait(
      () => {
        fakeNow += 2;
      },
      () => complete(author.id, created.generation_id, 1)
    );

    expect(done).toMatchObject({ ok: false, status: 410, error: 'gone' });
    expect(sendGate.calls).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
    expect(await get(author.id, created.generation_id)).toMatchObject({
      ok: true,
      result: { status: 'expired' },
    });
  });

  it('回执保留 15 分钟后淘汰：GET 404，幂等键失效后可重新创建', async () => {
    const author = await makeCore();
    const created = await createGen(author.id, { clientRequestId: 'ttl-key' });
    await chunk(author.id, created.generation_id, 1, '短');
    await complete(author.id, created.generation_id, 1);

    const before = await get(author.id, created.generation_id);
    expect(before).toMatchObject({ ok: true, result: { status: 'completed' } });

    advance(15 * 60 * 1000 + 1);
    expect(await get(author.id, created.generation_id)).toMatchObject({
      ok: false,
      status: 404,
      error: 'not_found',
    });

    // 回执淘汰 → 同一 client_request_id 视为全新任务（不承诺跨淘汰幂等）
    const recreated = await createGen(author.id, { clientRequestId: 'ttl-key' });
    expect(recreated.generation_id).not.toBe(created.generation_id);
  });

  it('失权（不再是私聊成员）：任务停止接收并广播 failed/forbidden', async () => {
    const author = await makeCore();
    const peer = await makeCore();
    const direct = await startDirectChannel(author.id, peer.id);
    if (!direct.ok) throw new Error('direct failed');
    const stream = connect(peer.id);

    const created = await createGen(author.id, { channelId: direct.channel.id });
    await chunk(author.id, created.generation_id, 1, '缓冲');
    await sleep(30);

    await prisma.chatMember.deleteMany({ where: { channelId: direct.channel.id, userId: author.id } });
    const denied = await chunk(author.id, created.generation_id, 2, '失权后');
    expect(denied).toMatchObject({ ok: false, status: 403, error: 'forbidden' });

    const terminal = framesOf(stream).filter(
      (f) => f.type === 'generation_terminal'
    ) as Array<{ status: string; error?: string; source?: string }>;
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(terminal[0].source).toBeUndefined();
  });

  it('finalizing 期间失权不提前终结：名额不释放，最终由发送内核给出 completed', async () => {
    const author = await makeCore();
    const peer = await makeCore();
    const direct = await startDirectChannel(author.id, peer.id);
    if (!direct.ok) throw new Error('direct failed');
    const created = await createGen(author.id, { channelId: direct.channel.id });
    await chunk(author.id, created.generation_id, 1, '冻结后失权');

    sendGate.hold = true;
    const completing = complete(author.id, created.generation_id, 1);
    for (let i = 0; i < 200 && !sendGate.entered; i++) await sleep(5);
    expect(sendGate.entered).toBe(true);

    // 唯一提交权冻结后失权：chunk / GET 都复核访问，但不能把 finalizing 终结掉。
    await prisma.chatMember.deleteMany({
      where: { channelId: direct.channel.id, userId: author.id },
    });
    expect(await chunk(author.id, created.generation_id, 2, '失权后')).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
    expect(await get(author.id, created.generation_id)).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    });

    // 恢复成员资格：名额仍被 finalizing 任务占用，不能另建第二个任务并发发布。
    await prisma.chatMember.create({
      data: { channelId: direct.channel.id, userId: author.id, createdAt: new Date() },
    });
    const second = await createGeneration({
      authorId: author.id,
      channelId: direct.channel.id,
      lobbyBlocked: false,
      clientRequestId: crypto.randomUUID(),
      replyTo: null,
    });
    expect(second).toMatchObject({ ok: false, status: 503, error: 'capacity' });

    // 放行在途发送：原任务正常完成，只落一条正式消息。
    sendGate.release?.();
    const result = await completing;
    expect(result).toMatchObject({ ok: true, result: { status: 'completed' } });
    if (!result.ok) return;
    expect(result.result.message_id).toBeTypeOf('number');
    expect(await prisma.chatMessage.count({ where: { channelId: direct.channel.id } })).toBe(1);
  });

  it('过期回执被淘汰后，cancel/complete 404；不同 last_seq 的重放 409', async () => {
    const author = await makeCore();
    const created = await createGen(author.id);
    await chunk(author.id, created.generation_id, 1, 'abc');
    await complete(author.id, created.generation_id, 1);

    const wrongSeq = await complete(author.id, created.generation_id, 0);
    expect(wrongSeq).toMatchObject({ ok: false, status: 409, error: 'conflict' });

    advance(15 * 60 * 1000 + 1);
    expect(await cancel(author.id, created.generation_id)).toMatchObject({ ok: false, status: 404 });
    expect(await complete(author.id, created.generation_id, 1)).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('广播：权限投递、无 SSE 游标与副作用', () => {
  it('大区快照跳过专注屏蔽连接；事件不带 SSE id', async () => {
    const author = await makeCore();
    const normal = await makeCore();
    const blocked = await makeCore();
    const normalStream = connect(normal.id, false);
    const blockedStream = connect(blocked.id, true);

    const created = await createGen(author.id, { channelId: CHAT_LOBBY_ID });
    await chunk(author.id, created.generation_id, 1, '大区快照');
    await sleep(30);

    const normalFrames = framesOf(normalStream);
    expect(normalFrames.some((f) => f.type === 'generation_snapshot')).toBe(true);
    expect(framesOf(blockedStream).some((f) => f.type === 'generation_snapshot')).toBe(false);

    const snapshotRaw = normalStream.raw.find((chunk) => chunk.includes('generation_snapshot'));
    expect(snapshotRaw).toBeDefined();
    expect(snapshotRaw!.startsWith('id:')).toBe(false);
    expect(snapshotRaw!.includes('\nid:')).toBe(false);
  });

  it('私聊快照只投递成员，第三方收不到', async () => {
    const author = await makeCore();
    const peer = await makeCore();
    const outsider = await makeCore();
    const direct = await startDirectChannel(author.id, peer.id);
    if (!direct.ok) throw new Error('direct failed');
    const peerStream = connect(peer.id);
    const outsiderStream = connect(outsider.id);

    const created = await createGen(author.id, { channelId: direct.channel.id });
    await chunk(author.id, created.generation_id, 1, '私聊快照');
    await sleep(30);

    expect(framesOf(peerStream).some((f) => f.type === 'generation_snapshot')).toBe(true);
    expect(framesOf(outsiderStream)).toEqual([]);
  });

  it('临时事件不产生消息 / 未读 / last_message / 通知；正式消息仍走原逻辑一次', async () => {
    const author = await makeCore();
    const peer = await makeCore();
    const direct = await startDirectChannel(author.id, peer.id);
    if (!direct.ok) throw new Error('direct failed');
    const channelId = direct.channel.id;

    const created = await createGen(author.id, { channelId });
    await chunk(author.id, created.generation_id, 1, `@${peer.username} 临时内容`);
    await sleep(30);

    // 生成中：没有任何正式副作用
    expect(await prisma.chatMessage.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.chatMember.findMany({ where: { channelId } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: author.id, lastReadMessageId: 0 }),
        expect.objectContaining({ userId: peer.id, lastReadMessageId: 0 }),
      ])
    );
    const during = await listChannelsForUser(peer.id);
    const duringChannel = during.find((c) => c.id === channelId);
    // 空私聊不进侧栏；生成中的临时内容也不应让它出现
    expect(duringChannel).toBeUndefined();
    expect(await prisma.chatMessage.count({ where: { channelId } })).toBe(0);

    // 正式发布：消息、提及通知与未读按既有规则各出现一次
    const done = await complete(author.id, created.generation_id, 1);
    expect(done.ok).toBe(true);
    expect(await prisma.chatMessage.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
    const after = await listChannelsForUser(peer.id);
    expect(after.find((c) => c.id === channelId)?.last_message?.content).toContain('临时内容');
    expect(after.find((c) => c.id === channelId)?.unread_count).toBe(1);
  });

  it('正式 message 事件外层带 generation_id，快照/终态事件不带 source 之外的额外内容', async () => {
    const author = await makeCore();
    const peer = await makeCore();
    const direct = await startDirectChannel(author.id, peer.id);
    if (!direct.ok) throw new Error('direct failed');
    const stream = connect(peer.id);

    const created = await createGen(author.id, { channelId: direct.channel.id });
    await chunk(author.id, created.generation_id, 1, '交接');
    await sleep(30);
    await complete(author.id, created.generation_id, 1);
    await sleep(30);

    const frames = framesOf(stream);
    const formal = frames.find((f) => f.type === 'message') as
      | { generation_id?: string; message?: { generation_id?: unknown } }
      | undefined;
    expect(formal?.generation_id).toBe(created.generation_id);
    expect(formal?.message?.generation_id).toBeUndefined();

    const terminal = frames.find((f) => f.type === 'generation_terminal') as
      | { status?: string; message_id?: number; source?: unknown; author?: unknown }
      | undefined;
    expect(terminal?.status).toBe('completed');
    expect(terminal?.message_id).toBeTypeOf('number');
    expect(terminal?.source).toBeUndefined();
    expect(terminal?.author).toBeUndefined();
  });
});