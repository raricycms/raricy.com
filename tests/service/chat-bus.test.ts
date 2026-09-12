// chat-bus.ts —— 聊天 SSE 的进程内订阅注册表
//
// 【为什么测这些】bus 是「投递语义」的落点，写错不会报错、只会静默丢消息或漏推：
//   1. 帧格式（id: + data:）—— 浏览器靠 id: 回传 Last-Event-ID 做断线补齐，格式错了
//      重连就补不回消息，而且不报错。
//   2. 大区广播必须跳过专注模式连接 —— 专注模式是服务端访问控制，漏过滤等于把
//      大区消息推给了本该看不到的人。
//   3. 背压必须断开连接（而不是在服务端无限缓冲）—— 否则慢客户端 = 内存泄漏。
//   4. kickUser 要能真正断掉该用户全部连接（封禁/降权靠它即时生效）。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  subscribe,
  publishToUsers,
  publishToAll,
  kickUser,
  onlineConnections,
  sseFrame,
  __resetChatBus,
  type ChatSubscriber,
} from '@/lib/chat-bus';
import type { ChatStreamEvent } from '@/lib/chat-shared';

beforeEach(() => {
  __resetChatBus();
});

/** 假订阅者：记录收到的帧，可选在第 N 帧后返回背压。 */
function makeSub(
  userId: string,
  opts: { focusMode?: boolean; backpressureAfter?: number } = {}
) {
  const chunks: string[] = [];
  const state = { closed: false };
  const sub: ChatSubscriber = {
    userId,
    focusMode: opts.focusMode ?? false,
    write: (chunk) => {
      chunks.push(chunk);
      return opts.backpressureAfter == null || chunks.length <= opts.backpressureAfter;
    },
    close: () => {
      state.closed = true;
    },
  };
  return { sub, chunks, state };
}

const msgEvent = (channelId: string, id: number): ChatStreamEvent => ({
  type: 'message',
  channel_id: channelId,
  message: { id } as never,
});

describe('chat-bus：帧格式', () => {
  it('带 id 的帧形如 "id: N\\ndata: {...}\\n\\n"（Last-Event-ID 的依据）', () => {
    const frame = sseFrame({ type: 'resync' }, 42);
    expect(frame).toBe('id: 42\ndata: {"type":"resync"}\n\n');
  });

  it('不带 id 的帧没有 id: 行', () => {
    expect(sseFrame({ type: 'resync' })).toBe('data: {"type":"resync"}\n\n');
  });
});

describe('chat-bus：投递', () => {
  it('publishToUsers 只推给指定用户，多标签页（多条订阅）都能收到', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const b = makeSub('u-b');
    subscribe(a1.sub);
    subscribe(a2.sub);
    subscribe(b.sub);

    publishToUsers(['u-a'], msgEvent('ch-1', 7), 7);

    expect(a1.chunks).toHaveLength(1);
    expect(a2.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(0);
    expect(a1.chunks[0]).toContain('id: 7');
    expect(a1.chunks[0]).toContain('"channel_id":"ch-1"');
  });

  it('publishToAll 广播给所有在线连接', () => {
    const a = makeSub('u-a');
    const b = makeSub('u-b');
    subscribe(a.sub);
    subscribe(b.sub);

    publishToAll(msgEvent('lobby', 9), 9);

    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(1);
  });

  it('skipFocusMode 跳过专注模式连接（大区消息不该推给看不到大区的人）', () => {
    const normal = makeSub('u-normal');
    const focused = makeSub('u-focused', { focusMode: true });
    subscribe(normal.sub);
    subscribe(focused.sub);

    publishToAll(msgEvent('lobby', 11), 11, { skipFocusMode: true });

    expect(normal.chunks).toHaveLength(1);
    expect(focused.chunks).toHaveLength(0);
  });

  it('私聊推送不过滤专注模式（专注模式只禁大区）', () => {
    const focused = makeSub('u-focused', { focusMode: true });
    subscribe(focused.sub);

    publishToUsers(['u-focused'], msgEvent('ch-dm', 12), 12);

    expect(focused.chunks).toHaveLength(1);
  });
});

describe('chat-bus：订阅生命周期', () => {
  it('注销后不再收消息；最后一条注销后在线数归零', () => {
    const a = makeSub('u-a');
    const off = subscribe(a.sub);
    expect(onlineConnections()).toBe(1);

    off();
    expect(onlineConnections()).toBe(0);

    publishToUsers(['u-a'], msgEvent('ch-1', 1), 1);
    expect(a.chunks).toHaveLength(0);
  });

  it('同一用户多条连接：注销其中一条不影响另一条', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const off1 = subscribe(a1.sub);
    subscribe(a2.sub);
    expect(onlineConnections()).toBe(2);

    off1();
    publishToUsers(['u-a'], msgEvent('ch-1', 2), 2);

    expect(a1.chunks).toHaveLength(0);
    expect(a2.chunks).toHaveLength(1);
  });

  it('重复注销是幂等的（abort 与 cancel 可能都触发）', () => {
    const a = makeSub('u-a');
    const off = subscribe(a.sub);
    off();
    expect(() => off()).not.toThrow();
    expect(onlineConnections()).toBe(0);
  });
});

describe('chat-bus：背压与踢连接', () => {
  it('写失败（背压）时断开该连接，其余连接不受影响', () => {
    const slow = makeSub('u-slow', { backpressureAfter: 0 }); // 第一帧就返回 false
    const ok = makeSub('u-ok');
    subscribe(slow.sub);
    subscribe(ok.sub);

    publishToAll(msgEvent('lobby', 3), 3);

    expect(slow.state.closed).toBe(true);
    expect(ok.state.closed).toBe(false);
    expect(ok.chunks).toHaveLength(1);
  });

  it('write 抛错也当作背压处理（已关闭的 controller）', () => {
    const chunks: string[] = [];
    const state = { closed: false };
    subscribe({
      userId: 'u-throw',
      focusMode: false,
      write: () => {
        throw new Error('stream closed');
      },
      close: () => {
        state.closed = true;
      },
    });

    expect(() => publishToAll(msgEvent('lobby', 4), 4)).not.toThrow();
    expect(state.closed).toBe(true);
    expect(chunks).toHaveLength(0);
  });

  it('kickUser 关闭该用户全部连接并从注册表移除', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const b = makeSub('u-b');
    subscribe(a1.sub);
    subscribe(a2.sub);
    subscribe(b.sub);

    kickUser('u-a');

    expect(a1.state.closed).toBe(true);
    expect(a2.state.closed).toBe(true);
    expect(b.state.closed).toBe(false);
    expect(onlineConnections()).toBe(1);

    publishToUsers(['u-a'], msgEvent('ch-1', 5), 5);
    expect(a1.chunks).toHaveLength(0);
  });

  it('kickUser 对不存在的用户是安全的 no-op', () => {
    expect(() => kickUser('u-none')).not.toThrow();
  });
});
