// game-bus.ts —— 联机对战的进程内订阅注册表
//
// 【为什么测这些】与 chat-bus 同源：bus 是「投递语义」的落点，写错不会报错，
// 只会静默串房、漏推或内存泄漏：
//   1. 按房间投递必须**只到本房** —— 串房等于把 A 局的棋谱推给 B 局的人。
//   2. 并发连接上限要真的拒掉（返回 null）—— 否则多标签页能把内存吃满。
//   3. 背压必须断开连接（而不是在服务端无限缓冲）。
//   4. closeRoom / kickViewer 要能真正断掉连接（房间回收与封禁/专注模式靠它即时生效）。
//   5. connectionsIn 是上层判断「席位主人掉线」的依据 —— 数错了就误判掉线。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_CONNECTIONS_PER_VIEWER,
  __resetGameBus,
  activeRooms,
  closeRoom,
  connectionsIn,
  kickViewer,
  onlineConnections,
  publishToRoom,
  subscribe,
  type GameSubscriber,
} from '@/lib/game-bus';

beforeEach(() => {
  __resetGameBus();
});

type TestEvent = { type: string; revision?: number };

/** 假订阅者：记录收到的帧，可选在第 N 帧后返回背压。 */
function makeSub(
  roomCode: string,
  viewerId: string,
  opts: { backpressureAfter?: number } = {}
) {
  const chunks: string[] = [];
  const state = { closed: false };
  const sub: GameSubscriber = {
    roomCode,
    viewerId,
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

/** 订阅并断言成功（未超并发上限），返回注销函数。 */
function subscribeOk(sub: GameSubscriber): () => void {
  const off = subscribe(sub);
  expect(off).not.toBeNull();
  return off!;
}

describe('game-bus：按房间投递', () => {
  it('publishToRoom 只推给本房，不串到其它房间', () => {
    const a = makeSub('room-a', 'u-1');
    const b = makeSub('room-b', 'u-2');
    subscribeOk(a.sub);
    subscribeOk(b.sub);

    publishToRoom<TestEvent>('room-a', { type: 'move', revision: 3 }, 3);

    expect(a.chunks).toHaveLength(1);
    expect(a.chunks[0]).toContain('id: 3');
    expect(a.chunks[0]).toContain('"type":"move"');
    expect(b.chunks).toHaveLength(0);
  });

  it('同房多条连接（多标签页 / 观众）都收到同一帧', () => {
    const p1 = makeSub('room-a', 'u-1');
    const p2 = makeSub('room-a', 'u-2');
    const spec = makeSub('room-a', 'u-3');
    subscribeOk(p1.sub);
    subscribeOk(p2.sub);
    subscribeOk(spec.sub);

    publishToRoom<TestEvent>('room-a', { type: 'move' });

    expect(p1.chunks).toHaveLength(1);
    expect(p2.chunks).toHaveLength(1);
    expect(spec.chunks).toHaveLength(1);
  });

  it('推给不存在的房间是安全的 no-op', () => {
    expect(() => publishToRoom<TestEvent>('room-none', { type: 'move' })).not.toThrow();
  });
});

describe('game-bus：并发连接上限', () => {
  it(`同一用户超过 ${MAX_CONNECTIONS_PER_VIEWER} 条连接时 subscribe 返回 null`, () => {
    const subs = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      const s = makeSub('room-a', 'u-heavy');
      expect(subscribe(s.sub)).not.toBeNull();
      subs.push(s);
    }

    const extra = makeSub('room-a', 'u-heavy');
    expect(subscribe(extra.sub)).toBeNull();
    // 被拒的连接不该进入注册表（否则要等 abort 才回收）
    expect(onlineConnections()).toBe(MAX_CONNECTIONS_PER_VIEWER);
  });

  it('上限按用户算，不影响别人', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      subscribeOk(makeSub('room-a', 'u-heavy').sub);
    }
    expect(subscribe(makeSub('room-a', 'u-other').sub)).not.toBeNull();
  });

  it('注销后又能再订阅（上限不是一次性的）', () => {
    const offs = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      offs.push(subscribeOk(makeSub('room-a', 'u-heavy').sub));
    }
    expect(subscribe(makeSub('room-a', 'u-heavy').sub)).toBeNull();

    offs[0]();
    expect(subscribe(makeSub('room-a', 'u-heavy').sub)).not.toBeNull();
  });

  it('上限跨房间累计（同时开着两个房间的标签页也受同一个上限约束）', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      subscribeOk(makeSub(`room-${i}`, 'u-heavy').sub);
    }
    expect(subscribe(makeSub('room-new', 'u-heavy').sub)).toBeNull();
  });
});

describe('game-bus：订阅生命周期', () => {
  it('注销后不再收帧；最后一条注销后在线数与房间数归零', () => {
    const a = makeSub('room-a', 'u-1');
    const off = subscribeOk(a.sub);
    expect(onlineConnections()).toBe(1);
    expect(activeRooms()).toBe(1);

    off();
    expect(onlineConnections()).toBe(0);
    expect(activeRooms()).toBe(0);

    publishToRoom<TestEvent>('room-a', { type: 'move' });
    expect(a.chunks).toHaveLength(0);
  });

  it('同房注销其中一条不影响另一条', () => {
    const a1 = makeSub('room-a', 'u-1');
    const a2 = makeSub('room-a', 'u-1');
    const off1 = subscribeOk(a1.sub);
    subscribeOk(a2.sub);

    off1();
    publishToRoom<TestEvent>('room-a', { type: 'move' });

    expect(a1.chunks).toHaveLength(0);
    expect(a2.chunks).toHaveLength(1);
  });

  it('重复注销是幂等的（abort 与 cancel 可能都触发）', () => {
    const a = makeSub('room-a', 'u-1');
    const off = subscribeOk(a.sub);
    off();
    expect(() => off()).not.toThrow();
    expect(onlineConnections()).toBe(0);
  });
});

describe('game-bus：connectionsIn（上层判「掉线」的依据）', () => {
  it('按房间 + 用户计数，不混入他人与其它房间', () => {
    subscribeOk(makeSub('room-a', 'u-1').sub);
    subscribeOk(makeSub('room-a', 'u-1').sub);
    subscribeOk(makeSub('room-a', 'u-2').sub);
    subscribeOk(makeSub('room-b', 'u-1').sub);

    expect(connectionsIn('room-a', 'u-1')).toBe(2);
    expect(connectionsIn('room-a', 'u-2')).toBe(1);
    expect(connectionsIn('room-b', 'u-1')).toBe(1);
    expect(connectionsIn('room-a', 'u-nobody')).toBe(0);
    expect(connectionsIn('room-none', 'u-1')).toBe(0);
  });

  it('全部断开后归零（席位主人据此被判定掉线）', () => {
    const s = makeSub('room-a', 'u-1');
    const off = subscribeOk(s.sub);
    expect(connectionsIn('room-a', 'u-1')).toBe(1);

    off();
    expect(connectionsIn('room-a', 'u-1')).toBe(0);
  });
});

describe('game-bus：背压与踢连接', () => {
  it('写失败（背压）时断开该连接，其余连接不受影响', () => {
    const slow = makeSub('room-a', 'u-slow', { backpressureAfter: 0 }); // 第一帧就返回 false
    const ok = makeSub('room-a', 'u-ok');
    subscribeOk(slow.sub);
    subscribeOk(ok.sub);

    publishToRoom<TestEvent>('room-a', { type: 'move' });

    expect(slow.state.closed).toBe(true);
    expect(ok.state.closed).toBe(false);
    expect(ok.chunks).toHaveLength(1);
  });

  it('write 抛错也当作背压处理（已关闭的 controller）', () => {
    const state = { closed: false };
    subscribeOk({
      roomCode: 'room-a',
      viewerId: 'u-throw',
      write: () => {
        throw new Error('stream closed');
      },
      close: () => {
        state.closed = true;
      },
    });

    expect(() => publishToRoom<TestEvent>('room-a', { type: 'move' })).not.toThrow();
    expect(state.closed).toBe(true);
  });

  it('closeRoom 关掉本房全部连接，其它房间不受影响', () => {
    const a1 = makeSub('room-a', 'u-1');
    const a2 = makeSub('room-a', 'u-2');
    const b = makeSub('room-b', 'u-1');
    subscribeOk(a1.sub);
    subscribeOk(a2.sub);
    subscribeOk(b.sub);

    closeRoom('room-a');

    expect(a1.state.closed).toBe(true);
    expect(a2.state.closed).toBe(true);
    expect(b.state.closed).toBe(false);
    expect(onlineConnections()).toBe(1);
    expect(activeRooms()).toBe(1);

    publishToRoom<TestEvent>('room-a', { type: 'move' });
    expect(a1.chunks).toHaveLength(0);
  });

  it('closeRoom 对不存在的房间是安全的 no-op', () => {
    expect(() => closeRoom('room-none')).not.toThrow();
  });

  it('kickViewer 跨房间踢掉该用户全部连接，不影响他人', () => {
    const a1 = makeSub('room-a', 'u-1');
    const a2 = makeSub('room-b', 'u-1');
    const other = makeSub('room-a', 'u-2');
    subscribeOk(a1.sub);
    subscribeOk(a2.sub);
    subscribeOk(other.sub);

    kickViewer('u-1');

    expect(a1.state.closed).toBe(true);
    expect(a2.state.closed).toBe(true);
    expect(other.state.closed).toBe(false);
    expect(onlineConnections()).toBe(1);

    publishToRoom<TestEvent>('room-a', { type: 'move' });
    expect(a1.chunks).toHaveLength(0);
    expect(other.chunks).toHaveLength(1);
  });

  it('kickViewer 对不存在的用户是安全的 no-op', () => {
    expect(() => kickViewer('u-none')).not.toThrow();
  });

  it('踢掉后并发配额随之释放', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      subscribeOk(makeSub('room-a', 'u-heavy').sub);
    }
    expect(subscribe(makeSub('room-a', 'u-heavy').sub)).toBeNull();

    kickViewer('u-heavy');
    expect(subscribe(makeSub('room-a', 'u-heavy').sub)).not.toBeNull();
  });
});
