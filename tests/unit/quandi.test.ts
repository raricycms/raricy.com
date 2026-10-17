import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { parseQuandiCommand, QUANDI_MAX_ROOMS, QUANDI_ROUND_MAX_MS } from '../../shared/quandi/protocol';
import { TerritoryGrid } from '../../shared/quandi/territory-grid';
import { createQuandiGame } from '../../services/realtime/src/quandi';
import ServerEngine from '../../services/realtime/src/quandi-engine/ServerEngine.js';
import type { RealtimePeer } from '../../services/realtime/src/game';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  const game = createQuandiGame({ consume: async () => null, validate: async () => true });
  const sessions: ReturnType<typeof game.connect>[] = [];
  function connect(id: string, userId = id) {
    const packets: { type: string; data: any }[] = [];
    const peer: RealtimePeer = { id, identity: { userId, username: `账号-${id}`, sessionVersion: 0 },
      send(data) { packets.push(JSON.parse(String(data))); return true; }, disconnect: vi.fn() };
    const session = game.connect(peer); sessions.push(session);
    return { peer, packets, session,
      send(type: string, data: object = {}) { session.receive({ binary: false, data: JSON.stringify({ type, data }) }); },
      last(type: string) { return [...packets].reverse().find((packet) => packet.type === type)?.data; },
    };
  }
  return { connect, close: () => sessions.forEach((session) => session.close()) };
}

describe('圈地运动协议和资源边界', () => {
  it('拒绝非对象、伪造身份/坐标、越界方向、非有限数、非法模式与序号', () => {
    for (const value of [null, [], 'text', {}, { type: 'C2S_CREATE_ROOM', data: null },
      { type: 'C2S_CREATE_ROOM', data: { mode: '__proto__', difficulty: 'medium' } },
      { type: 'C2S_CREATE_ROOM', data: { mode: 'fight', difficulty: 'medium', playerName: '伪造' } },
      { type: 'C2S_START_GAME', data: { roomId: 'other-room' } },
      ...[NaN, Infinity, -Infinity, 2, '1', null].map((x) => ({ type: 'C2S_PLAYER_INPUT', data: { direction: { x, y: 0 }, seq: 1 } })),
      ...[-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1].map((seq) => ({ type: 'C2S_PLAYER_INPUT', data: { direction: { x: 1, y: 0 }, seq } })),
      { type: 'C2S_PLAYER_INPUT', data: { direction: { x: 1, y: 0 }, seq: 1, score: 100 } },
    ]) expect(parseQuandiCommand(value)).toBeNull();
    expect(parseQuandiCommand({ type: 'C2S_PLAYER_INPUT', data: { direction: { x: -1, y: 1 }, seq: 2 } })).not.toBeNull();
  });

  it('一个账号只能有一个连接，退出后可以重新连接；畸形 JSON 不抛异常', () => {
    const game = setup();
    const first = game.connect('a', 'same'), duplicate = game.connect('b', 'same');
    expect(duplicate.peer.disconnect).toHaveBeenCalledOnce();
    expect(duplicate.last('S2C_ERROR').code).toBe('CONNECTION_LIMIT');
    duplicate.session.close();
    expect(() => first.session.receive({ binary: false, data: 'null' })).not.toThrow();
    expect(first.peer.disconnect).toHaveBeenCalledOnce();
    first.session.close(); first.session.close();
    expect(game.connect('c', 'same').peer.disconnect).not.toHaveBeenCalled();
    game.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('房间数有上限，不能重复建房挤占资源；离开和超时会释放房间', () => {
    const game = setup();
    for (let i = 0; i < QUANDI_MAX_ROOMS; i++) game.connect(`p${i}`).send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    const extra = game.connect('extra');
    extra.send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    expect(extra.last('S2C_ERROR').code).toBe('ROOMS_FULL');
    vi.advanceTimersByTime(301_000);
    extra.send('C2S_PING');
    extra.send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    expect(extra.last('S2C_ROOM_UPDATE').room.maxPlayers).toBe(2);
    extra.send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    expect(extra.last('S2C_ERROR').code).toBe('ALREADY_IN_ROOM');
    game.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('高频控制操作断开连接，移动不能跨房间，非房主不能开局', () => {
    const game = setup(), a = game.connect('a'), b = game.connect('b'), outsider = game.connect('outsider');
    a.send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    b.send('C2S_JOIN_ROOM', { roomCode: a.last('S2C_ROOM_UPDATE').room.roomCode });
    b.send('C2S_START_GAME'); expect(b.last('S2C_ERROR').code).toBe('NOT_HOST');
    a.send('C2S_START_GAME'); expect(a.last('S2C_ERROR').code).toBe('NOT_READY');
    outsider.send('C2S_FORFEIT');
    expect(a.last('S2C_GAME_END')).toBeUndefined();
    for (let i = 0; i < 13; i++) outsider.send('C2S_START_GAME');
    expect(outsider.peer.disconnect).toHaveBeenCalled();
    game.close();
  });
});

describe('圈地运动权威引擎', () => {
  it.each(['explore', 'fight', 'infinite', 'survival', 'capture', 'daynight'])('%s：双人开局、权威移动、过期输入停止、断线弃权并可再开一局', (mode) => {
    const game = setup(), a = game.connect('a'), b = game.connect('b');
    a.send('C2S_CREATE_ROOM', { mode, difficulty: 'medium' });
    b.send('C2S_JOIN_ROOM', { roomCode: a.last('S2C_ROOM_UPDATE').room.roomCode });
    a.send('C2S_SET_READY', { isReady: true }); b.send('C2S_SET_READY', { isReady: true }); a.send('C2S_START_GAME');
    expect(a.last('S2C_GAME_START').players.map((player: any) => player.name)).toEqual(['账号-a', '账号-b']);
    expect(a.last('S2C_GAME_STATE').isDelta).toBe(false);
    vi.advanceTimersByTime(3100);
    const position = () => a.packets.filter((packet) => packet.type === 'S2C_GAME_STATE')
      .map((packet) => packet.data.players.find((player: any) => player.id === 'a'))
      .reverse().find((player) => player?.x !== undefined)?.x;
    a.send('C2S_PLAYER_INPUT', { direction: { x: 1, y: 0 }, seq: 1 });
    vi.advanceTimersByTime(96); expect(position()).toBeGreaterThan(180);
    const before = position();
    a.send('C2S_PLAYER_INPUT', { direction: { x: -1, y: 0 }, seq: 1 });
    vi.advanceTimersByTime(96); expect(position()).toBeGreaterThanOrEqual(before);
    vi.advanceTimersByTime(350); const stopped = position();
    vi.advanceTimersByTime(100); expect(position()).toBe(stopped);
    b.session.close();
    expect(a.last('S2C_GAME_END').winner.id).toBe('a');
    expect(a.last('S2C_ROOM_UPDATE').room.players).toHaveLength(1);
    const c = game.connect('c'); c.send('C2S_JOIN_ROOM', { roomCode: a.last('S2C_ROOM_UPDATE').room.roomCode });
    a.send('C2S_SET_READY', { isReady: true }); c.send('C2S_SET_READY', { isReady: true }); a.send('C2S_START_GAME');
    expect(a.last('S2C_GAME_START').players.map((player: any) => player.id)).toEqual(['a', 'c']);
    game.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('增量计分区分形状，重叠只算一次，不同玩家互不污染', () => {
    const grid = new TerritoryGrid();
    const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    grid.add('a', rectangle(0, 0, 600, 600)); expect(grid.score('a')).toBe(50);
    grid.add('a', rectangle(0, 0, 600, 600).reverse()); expect(grid.score('a')).toBe(50);
    grid.add('a', rectangle(600, 0, 600, 600)); expect(grid.score('a')).toBe(100);
    grid.add('b', rectangle(0, 0, 300, 300)); expect(grid.score('b')).toBe(12.5);
    grid.clear(); expect(grid.score('a')).toBe(0);
  });

  it('凹多边形、交叉、边界与反向路径的增量计分等于原版非零环绕采样', () => {
    const polygons = [
      [{ x: 0, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }, { x: 80, y: 0 }],
      [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 60, y: 40 }, { x: 120, y: 80 }, { x: 0, y: 80 }],
      [{ x: 2.3, y: 7.9 }, { x: 112.5, y: 3.1 }, { x: 80.2, y: 99.7 }, { x: 12.4, y: 50.6 }],
    ];
    function inside(x: number, y: number, polygon: { x: number; y: number }[]) {
      let winding = 0;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const left = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
        if (a.y <= y && b.y > y && left > 0) winding++;
        else if (a.y > y && b.y <= y && left < 0) winding--;
      }
      return winding !== 0;
    }
    const grid = new TerritoryGrid();
    for (const [index, polygon] of polygons.entries()) {
      let count = 0;
      for (let y = 0; y < 600; y += 4) for (let x = 0; x < 1200; x += 4) if (inside(x, y, polygon)) count++;
      grid.add(String(index), polygon); grid.add(String(index), [...polygon].reverse());
      expect(grid.score(String(index))).toBe(count / 450);
    }
  });

  it('无限模式到达一局时限会结算，异步异常只回收该房间并允许重新建房', () => {
    const game = setup(), a = game.connect('a'), b = game.connect('b');
    a.send('C2S_CREATE_ROOM', { mode: 'infinite', difficulty: 'slow' });
    const code = a.last('S2C_ROOM_UPDATE').room.roomCode;
    b.send('C2S_JOIN_ROOM', { roomCode: code });
    a.send('C2S_SET_READY', { isReady: true }); b.send('C2S_SET_READY', { isReady: true }); a.send('C2S_START_GAME');
    vi.setSystemTime(Date.now() + QUANDI_ROUND_MAX_MS + 1);
    a.send('C2S_PING'); b.send('C2S_PING'); vi.advanceTimersByTime(1000);
    expect(a.last('S2C_GAME_END')).toBeTruthy();
    vi.spyOn(ServerEngine.prototype, 'tick').mockImplementation(() => { throw new Error('engine failure'); });
    a.send('C2S_SET_READY', { isReady: true }); b.send('C2S_SET_READY', { isReady: true }); a.send('C2S_START_GAME');
    vi.advanceTimersByTime(16);
    expect(a.last('S2C_ERROR').code).toBe('ROUND_CLOSED');
    expect(b.last('S2C_ROOM_LEFT')).toEqual({});
    a.send('C2S_CREATE_ROOM', { mode: 'fight', difficulty: 'medium' });
    expect(a.last('S2C_ROOM_UPDATE').room.roomCode).not.toBe(code);
    game.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('每局领地复杂度和轨迹长度有上限，异步引擎异常关闭本局而不逃逸', () => {
    const engine = new ServerEngine({ gameConfig: { mode: 'fight', difficulty: 'medium' }, getPlayers: () => [
      { playerId: 'a', name: 'a', color: '#E6194B' }, { playerId: 'b', name: 'b', color: '#0047AB' },
    ] });
    engine.players[0].addLength(100000); expect(engine.players[0].trailLength).toBe(1000);
    engine.territory.addTerritory('closed', [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }, { x: 0, y: 0 }]);
    expect(engine.territory.getPlayerTerritories('closed')[0]).toHaveLength(4);
    expect(engine.territory.calculateScore('closed')).toBe(12.5);
    const polygon = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    for (let i = 0; i < 128; i++) engine.territory.addTerritory('a', polygon);
    expect(() => engine.territory.addTerritory('a', polygon)).toThrow('territory_limit');
    const failed = vi.fn();
    engine.tick = () => { throw new Error('internal details'); };
    engine.start(() => {}, () => {}, () => {}, failed);
    expect(() => vi.advanceTimersByTime(16)).not.toThrow();
    expect(failed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
