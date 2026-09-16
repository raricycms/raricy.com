// topbar-bus.ts —— 顶栏指示器 SSE 的进程内订阅注册表
//
// 【为什么测这些】与 chat-bus 同一类：写错不会报错，只会静默丢推送或漏推。
//   1. patch 帧必须**不带 id:** —— 顶栏没有断线补齐（重连靠首帧全量快照自愈），
//      带 id 会误导客户端以为有 Last-Event-ID 语义。
//   2. publishToUser 只能推给目标用户（多推 = 把别人的未读数泄露给你）。
//   3. hasSubscriber 必须是**同步**的真值 —— 调用方靠它决定「要不要去算」，
//      报错（返回 true）会让每次通知都白跑几次查询，返回 false 会静默不推。
//   4. 背压必须断开连接（而不是无限缓冲）—— 否则慢客户端 = 内存泄漏。
//   5. kickTopbarUser 要能真正断掉该用户全部连接（重置密码 / 强制下线靠它即时生效）。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  subscribe,
  publishToUser,
  hasSubscriber,
  kickTopbarUser,
  onlineConnections,
  __resetTopbarBus,
  type TopbarPatch,
  type TopbarSubscriber,
} from '@/lib/topbar-bus';

beforeEach(() => {
  __resetTopbarBus();
});

/** 假订阅者：记录收到的帧，可选在第 N 帧后返回背压。 */
function makeSub(userId: string, opts: { backpressureAfter?: number } = {}) {
  const chunks: string[] = [];
  const state = { closed: false };
  const sub: TopbarSubscriber = {
    userId,
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

/** 从帧里取出 patch 对象（帧形如 `data: {...}\n\n`）。 */
function patchOf(frame: string): TopbarPatch {
  return JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
}

describe('topbar-bus：帧格式', () => {
  it('patch 帧不带 id: 行（顶栏没有断线补齐，别给客户端 Last-Event-ID 的错觉）', () => {
    const a = makeSub('u-a');
    subscribe(a.sub);

    publishToUser('u-a', { count: 3 });

    expect(a.chunks).toHaveLength(1);
    expect(a.chunks[0]).toBe('data: {"count":3}\n\n');
  });

  it('patch 的字段原样过 JSON —— 缺省字段不会被补成 null', () => {
    const a = makeSub('u-a');
    subscribe(a.sub);

    publishToUser('u-a', { chatUnread: false });
    publishToUser('u-a', { refresh: true });

    expect(patchOf(a.chunks[0])).toEqual({ chatUnread: false });
    expect(patchOf(a.chunks[1])).toEqual({ refresh: true });
  });
});

describe('topbar-bus：投递', () => {
  it('publishToUser 只推给目标用户，多标签页（多条订阅）都能收到', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const b = makeSub('u-b');
    subscribe(a1.sub);
    subscribe(a2.sub);
    subscribe(b.sub);

    publishToUser('u-a', { count: 7 });

    expect(a1.chunks).toHaveLength(1);
    expect(a2.chunks).toHaveLength(1);
    expect(b.chunks, '别人的未读数不该推给我').toHaveLength(0);
    expect(patchOf(a1.chunks[0])).toEqual({ count: 7 });
  });

  it('没有订阅者时 publishToUser 是安全的 no-op', () => {
    expect(() => publishToUser('u-none', { count: 1 })).not.toThrow();
  });
});

describe('topbar-bus：hasSubscriber（推送方靠它决定要不要去算值）', () => {
  it('反映真实订阅状态，且注销后立刻变 false', () => {
    expect(hasSubscriber('u-a')).toBe(false);

    const a = makeSub('u-a');
    const off = subscribe(a.sub);
    expect(hasSubscriber('u-a')).toBe(true);

    off();
    expect(hasSubscriber('u-a')).toBe(false);
  });

  it('同一用户还有另一条连接时仍为 true', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const off1 = subscribe(a1.sub);
    subscribe(a2.sub);

    off1();
    expect(hasSubscriber('u-a'), '还有一条连接在，不该报 false（会静默不推）').toBe(true);
  });
});

describe('topbar-bus：订阅生命周期', () => {
  it('注销后不再收帧；最后一条注销后在线数归零', () => {
    const a = makeSub('u-a');
    const off = subscribe(a.sub);
    expect(onlineConnections()).toBe(1);

    off();
    expect(onlineConnections()).toBe(0);

    publishToUser('u-a', { count: 1 });
    expect(a.chunks).toHaveLength(0);
  });

  it('重复注销是幂等的（abort 与 cancel 可能都触发）', () => {
    const a = makeSub('u-a');
    const off = subscribe(a.sub);
    off();
    expect(() => off()).not.toThrow();
    expect(onlineConnections()).toBe(0);
  });
});

describe('topbar-bus：背压与踢连接', () => {
  it('写失败（背压）时断开该连接，其余连接不受影响', () => {
    const slow = makeSub('u-slow', { backpressureAfter: 0 }); // 第一帧就返回 false
    const ok = makeSub('u-ok');
    subscribe(slow.sub);
    subscribe(ok.sub);

    publishToUser('u-slow', { count: 1 });
    publishToUser('u-ok', { count: 1 });

    expect(slow.state.closed).toBe(true);
    expect(ok.state.closed).toBe(false);
    expect(ok.chunks).toHaveLength(1);
  });

  it('write 抛错也当作背压处理（已关闭的 controller），且不冒泡给调用方', () => {
    const state = { closed: false };
    subscribe({
      userId: 'u-throw',
      write: () => {
        throw new Error('stream closed');
      },
      close: () => {
        state.closed = true;
      },
    });

    expect(() => publishToUser('u-throw', { count: 1 })).not.toThrow();
    expect(state.closed).toBe(true);
  });

  it('kickTopbarUser 关闭该用户全部连接并从注册表移除', () => {
    const a1 = makeSub('u-a');
    const a2 = makeSub('u-a');
    const b = makeSub('u-b');
    subscribe(a1.sub);
    subscribe(a2.sub);
    subscribe(b.sub);

    kickTopbarUser('u-a');

    expect(a1.state.closed).toBe(true);
    expect(a2.state.closed).toBe(true);
    expect(b.state.closed).toBe(false);
    expect(onlineConnections()).toBe(1);
    expect(hasSubscriber('u-a')).toBe(false);

    publishToUser('u-a', { count: 1 });
    expect(a1.chunks).toHaveLength(0);
  });

  it('kickTopbarUser 对不存在的用户是安全的 no-op', () => {
    expect(() => kickTopbarUser('u-none')).not.toThrow();
  });
});
