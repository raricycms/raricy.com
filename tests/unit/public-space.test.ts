import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createPublicSpaceGame } from '../../services/realtime/src/public-space';
import type { RealtimePeer, RealtimeSession } from '../../services/realtime/src/game';
import { PUBLIC_SPACE_TIMEOUT_MS, PUBLIC_SPACE_MAX_USERS, parsePublicSpaceCommand, parsePublicSpaceSnapshot } from '../../shared/public-space/protocol';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const game = createPublicSpaceGame({ consume: async () => null, validate: async () => true });
  const frames: Record<string, unknown>[] = [];
  function join(id: string, userId = id) {
    const peer: RealtimePeer = { id, identity: { userId, username: userId, sessionVersion: 0, frameUrl: '/frame.png' },
      send(data) { frames.push(JSON.parse(String(data))); return true; }, disconnect: vi.fn() };
    return { peer, session: game.connect(peer) };
  }
  const snapshot = () => parsePublicSpaceSnapshot([...frames].reverse().find((frame) => frame.type === 'public-space.snapshot'))!;
  return { join, snapshot, frames };
}
function move(session: RealtimeSession, cell: number | null) {
  session.receive({ binary: false, data: JSON.stringify({ type: 'public-space.move', cell }) });
}

describe('公共空间', () => {
  it('从观众席加入，独占格子、原子换位，回观众席释放位置', () => {
    const { join, snapshot, frames } = setup();
    const a = join('a'), b = join('b');
    expect(snapshot().users.map((user) => user.cell)).toEqual([null, null]);
    move(a.session, 0);
    move(b.session, 0);
    expect(frames.at(-1)).toEqual({ type: 'public-space.occupied' });
    expect(snapshot().users.map((user) => user.cell)).toEqual([0, null]);
    move(a.session, 24);
    move(b.session, 0);
    expect(snapshot().users.map((user) => user.cell)).toEqual([24, 0]);
    move(b.session, 24);
    expect(snapshot().users.map((user) => user.cell)).toEqual([24, 0]);
    move(a.session, null);
    move(b.session, 24);
    expect(snapshot().users.map((user) => user.cell)).toEqual([null, 24]);
    expect(snapshot().users[0].frameUrl).toBe('/frame.png');
    a.session.close(); b.session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('同账号多标签只显示一个头像，最后一条连接离开时才移除', () => {
    const { join, snapshot } = setup();
    const a = join('tab1', 'same'), b = join('tab2', 'same'), observer = join('observer');
    move(a.session, 7);
    expect(snapshot().users).toHaveLength(2);
    a.session.close(); a.session.close();
    expect(snapshot().users.find((user) => user.userId === 'same')?.cell).toBe(7);
    move(b.session, 10);
    expect(snapshot().users[0].cell).toBe(10);
    b.session.close();
    expect(snapshot().users.map((user) => user.userId)).toEqual(['observer']);
    move(observer.session, 10);
    expect(snapshot().users[0].cell).toBe(10);
    observer.session.close();
  });

  it('失联连接超时后释放座位，在线观众可继续入座，迟到指令不能复活连接', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { join, snapshot } = setup();
    const a = join('a'), observer = join('observer');
    move(a.session, 12);
    now = PUBLIC_SPACE_TIMEOUT_MS;
    observer.session.receive({ binary: false, data: '{"type":"public-space.ping"}' });
    vi.advanceTimersByTime(5_000);
    expect(a.peer.disconnect).toHaveBeenCalledOnce();
    expect(snapshot().users.map((user) => user.userId)).toEqual(['observer']);
    move(a.session, 0);
    move(observer.session, 12);
    expect(snapshot().users[0].cell).toBe(12);
    observer.session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('网格坐满后新用户仍在观众席', () => {
    const { join, snapshot } = setup();
    const players = Array.from({ length: 26 }, (_, i) => join(String(i)));
    players.slice(0, 25).forEach(({ session }, cell) => move(session, cell));
    expect(snapshot().users.filter((user) => user.cell !== null)).toHaveLength(25);
    expect(snapshot().users.at(-1)?.cell).toBeNull();
    players.forEach(({ session }) => session.close());
  });

  it('达到人数上限时拒绝新账号，同账号仍可连接', () => {
    const { join, snapshot, frames } = setup();
    const players = Array.from({ length: PUBLIC_SPACE_MAX_USERS }, (_, i) => join(String(i)));
    const extra = join('extra');
    expect(frames.at(-1)).toEqual({ type: 'public-space.full' });
    expect(extra.peer.disconnect).toHaveBeenCalledOnce();
    const duplicate = join('duplicate', '0');
    expect(snapshot().users).toHaveLength(PUBLIC_SPACE_MAX_USERS);
    duplicate.session.close();
    players.forEach(({ session }) => session.close());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bad json', '{"type":"public-space.move","cell":-1}', '{"type":"public-space.move","cell":25}',
    '{"type":"public-space.move","cell":0.5}', '{"type":"public-space.move","cell":"0"}', '{"type":"unknown"}'])('拒绝非法指令 %s', (data) => {
    const { join } = setup();
    const a = join('a');
    a.session.receive({ binary: false, data });
    expect(a.peer.disconnect).toHaveBeenCalledOnce();
    a.session.close();
  });

  it('契约拒绝重复用户、重复位置与无效坐标', () => {
    const user = { userId: 'a', name: 'A', frameUrl: null, cell: 0 };
    for (const users of [[user, user], [user, { ...user, userId: 'b' }], [{ ...user, cell: 25 }]]) {
      expect(parsePublicSpaceSnapshot({ type: 'public-space.snapshot', users })).toBeNull();
    }
    expect(parsePublicSpaceCommand({ type: 'public-space.move' })).toBeNull();
    expect(parsePublicSpaceSnapshot({ type: 'public-space.snapshot', users: [user, { ...user, userId: 'b', cell: null }] })).not.toBeNull();
  });
});
