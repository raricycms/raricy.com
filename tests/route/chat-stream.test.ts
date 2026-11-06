// GET /api/chat/stream —— 断线补齐的权限边界（R3-260）
//
// 【为什么测这个】补齐走的是与实时帧**不同的入口**（首帧之后一次性补发上次断线期间
// 漏掉的消息），两件事都是「不报错、只静默越权」的形态：
//   1. 它若用外层的裸 write，就绕开了逐帧复核 —— 从建立连接到这里之间发生的撤权 /
//      降级 / 禁言 / 大区屏蔽变更拦不住，会把「本人此刻已无权看」的几帧写出去；
//   2. 它若按「所有可见频道」取消息、不带连接的大区屏蔽快照，会把大区消息灌给本来看
//      不到大区的连接（客户端还会给大区累加未读，而红点闸门对他是 false）。
// 两条都不在 service 层用例的覆盖面上（那边测的是「拉回来什么」，这里测「写不写出去」）。
//
// 本文件打真实 route handler（不 mock Prisma），只 mock 登录态；第 2 条用可控的
// listMessagesSince 闸门制造「取回数据 → 撤权 → 开始写帧」这个精确时序。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 会话由 cookie 决定：单测里没有请求上下文，用可变 holder 模拟「有 / 没有会话」。
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

// 断线补齐的「取回后先别写」闸门：默认直通，只有第 2 条用例打开它。
const gate = vi.hoisted(() => ({
  enabled: false,
  fetched: false,
  release: null as null | (() => void),
}));
vi.mock('@/lib/chat-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-service')>();
  return {
    ...actual,
    listMessagesSince: async (...args: Parameters<typeof actual.listMessagesSince>) => {
      const result = await actual.listMessagesSince(...args);
      if (!gate.enabled) return result;
      gate.fetched = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return result;
    },
  };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { CHAT_LOBBY_ID } from '@/lib/chat-shared';
import { startDirectChannel, sendMessage } from '@/lib/chat-service';
import { __resetChatBus } from '@/lib/chat-bus';
import { GET } from '@/app/api/chat/stream/route';

type StreamEvent = {
  type?: string;
  channel_id?: string;
  message?: { id: number; content: string };
};

/**
 * 后台读流，把 data 帧解析成对象追加进 frames；注释帧（`retry:` / `: connected` /
 * `: ping`）直接丢掉。返回的 cancel() 用于收尾 —— 不取消的话，下一条用例的 resetDb
 * 会撞上还开着的流。
 */
function pump(res: Response) {
  const frames: StreamEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)) as StreamEvent);
        }
      }
    } catch {
      /* 被 cancel 掉了 */
    } finally {
      finished = true;
    }
  })();
  return {
    frames,
    done,
    isFinished: () => finished,
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

/** 轮询等待条件成立（帧是异步到达的，没有可 await 的信号）。 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const openStreams: Array<() => void> = [];

beforeEach(async () => {
  await resetDb();
  __resetChatBus();
  session.token = undefined;
  gate.enabled = false;
  gate.fetched = false;
  gate.release = null;
});

afterEach(() => {
  while (openStreams.length) openStreams.pop()!();
  __resetChatBus();
});

async function open(userId: string, lastEventId: number) {
  session.token = await createSessionToken({ uid: userId, sv: 0 });
  const res = await GET(
    new Request('http://localhost/api/chat/stream', {
      headers: { 'last-event-id': String(lastEventId) },
    })
  );
  if (!res.body) return { res, frames: [] as StreamEvent[], isFinished: () => true, cancel: () => {} };
  const p = pump(res);
  openStreams.push(() => {
    p.cancel();
    void p.done;
  });
  return { res, ...p };
}

describe('GET /api/chat/stream — 断线补齐（R3-260）', () => {
  it('专注屏蔽大区的连接：补齐跳过全部大区消息，私聊照常补', async () => {
    const me = await makeUser({ role: 'core' });
    const peer = await makeUser({ role: 'core' });
    const dm = (await startDirectChannel(me.id, peer.id)) as { channel: { id: string } };

    // 断线前的一条（作 Last-Event-ID 游标）；断线期间分别来了大区与私聊各一条
    const before = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: peer.id, content: '断线前' });
    if (!before.ok) throw new Error('send failed');
    const cursor = before.message.id;
    const lobbyDuring = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: peer.id,
      content: '断线期间的大区',
    });
    if (!lobbyDuring.ok) throw new Error('send failed');
    const dmDuring = await sendMessage({
      channelId: dm.channel.id,
      authorId: peer.id,
      content: '断线期间的私聊',
    });
    if (!dmDuring.ok) throw new Error('send failed');

    // 专注模式：总开关 + 屏蔽大区（isFocusLobbyBlocked 的口径）
    await prisma.user.update({
      where: { id: me.id },
      data: { focusMode: true, focusBlockLobby: true },
    });

    const p = await open(me.id, cursor);
    expect(await waitFor(() => p.frames.length >= 1), '私聊消息应当补到').toBe(true);
    // 再给一拍，让「错误地补了大区」的那一帧也有机会到达（负向断言需要）
    await new Promise((r) => setTimeout(r, 100));

    expect(p.frames.map((f) => f.channel_id)).toEqual([dm.channel.id]);
    expect(p.frames[0].message?.content).toBe('断线期间的私聊');
  });

  it('补齐期间被撤权：一帧都不写出，直接断开（补齐帧与实时帧同一条复核）', async () => {
    const me = await makeUser({ role: 'core' });
    const peer = await makeUser({ role: 'core' });
    await startDirectChannel(me.id, peer.id);

    const before = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: peer.id, content: '断线前' });
    if (!before.ok) throw new Error('send failed');
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: peer.id, content: '断线期间' });

    gate.enabled = true;
    const p = await open(me.id, before.message.id);
    expect(await waitFor(() => gate.fetched), '补齐数据应当已取回（此时复核还通过）').toBe(true);

    // 在「数据已取回、还没开始写帧」的窗口里撤权：补齐帧必须被逐帧复核拦下
    await prisma.user.update({ where: { id: me.id }, data: { role: 'user' } });
    gate.release?.();

    expect(await waitFor(() => p.isFinished()), '撤权后应主动断流').toBe(true);
    expect(p.frames, '撤权后不得再写出任何补齐帧').toEqual([]);
  });
});
