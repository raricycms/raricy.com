import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createWandGame } from '../../services/realtime/src/wand';
import type { RealtimePeer } from '../../services/realtime/src/game';
import { decodeWandInput, encodeWandInput, parseWandSnapshot, WAND_INPUT, WAND_SPEED } from '../../shared/wand/protocol';
import { stepWandPosition, wandPositionBlocked } from '../../shared/wand/physics';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Wand 权威移动', () => {
  it('输入帧只承载方向和 uint16 序号，拒绝坐标与未知方向', () => {
    expect(decodeWandInput(encodeWandInput(WAND_INPUT.right, 65535))).toEqual({ buttons: 8, sequence: 65535 });
    for (const input of [new Uint8Array([1, 16, 0, 0]), new Uint8Array([2, 0, 0, 0]), new Uint8Array([1, 0]), new TextEncoder().encode('{"x":200,"y":200}')]) {
      expect(decodeWandInput(input)).toBeNull();
    }
    expect(parseWandSnapshot({ type: 'wand.snapshot', players: [{ id: 'a', name: 'a', x: Infinity, y: 0 }] })).toBeNull();
  });

  it('斜走不加速，卡顿不跳跃，湖泊与边界不能穿过', () => {
    const straight = stepWandPosition({ x: 50, y: 50 }, WAND_INPUT.right, .1);
    const diagonal = stepWandPosition({ x: 50, y: 50 }, WAND_INPUT.right | WAND_INPUT.down, .1);
    expect(straight.x - 50).toBeCloseTo(WAND_SPEED * .1);
    expect(Math.hypot(diagonal.x - 50, diagonal.y - 50)).toBeCloseTo(straight.x - 50);
    expect(stepWandPosition({ x: 50, y: 50 }, WAND_INPUT.right, 100)).toEqual(straight);
    expect(wandPositionBlocked(200, 200)).toBe(true);
    let edge = { x: 12, y: 50 }, lake = { x: 130, y: 125 };
    for (let i = 0; i < 20; i++) {
      edge = stepWandPosition(edge, WAND_INPUT.left, .1);
      lake = stepWandPosition(lake, WAND_INPUT.right, .1);
    }
    expect(edge.x).toBeGreaterThanOrEqual(10);
    expect(lake.x).toBeLessThan(140);
    expect(wandPositionBlocked(lake.x, lake.y)).toBe(false);
  });

  it('多人同步方向输入，忽略旧序号、允许回绕，断输入后停步，离场移除玩家', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    function advance(milliseconds: number) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) { now += 50; vi.advanceTimersByTime(50); }
    }
    const game = createWandGame({ consume: async () => null, validate: async () => true });
    const snapshots: unknown[] = [];
    const peer = (id: string): RealtimePeer => ({
      id, identity: { userId: id, username: id, sessionVersion: 0 },
      send(data) { snapshots.push(JSON.parse(String(data))); return true; }, disconnect: vi.fn(),
    });
    const first = peer('first'), second = peer('second');
    const a = game.connect(first), b = game.connect(second);
    function position() { return parseWandSnapshot(snapshots.at(-1))!.players.find((entry) => entry.id === 'first')!; }
    expect(parseWandSnapshot(snapshots.at(-1))!.players).toHaveLength(2);
    a.receive({ binary: true, data: encodeWandInput(WAND_INPUT.right, 65535) });
    advance(50);
    expect(position().x).toBeGreaterThan(50);
    a.receive({ binary: true, data: encodeWandInput(WAND_INPUT.left, 65534) });
    advance(50);
    const right = position().x;
    a.receive({ binary: true, data: encodeWandInput(WAND_INPUT.left, 0) });
    advance(50);
    expect(position().x).toBeLessThan(right);
    advance(300);
    const stopped = position().x;
    advance(500);
    expect(position().x).toBe(stopped);
    a.receive({ binary: false, data: '{"x":400,"y":400}' });
    expect(first.disconnect).toHaveBeenCalledOnce();
    a.close();
    expect(parseWandSnapshot(snapshots.at(-1))!.players.map((entry) => entry.id)).toEqual(['second']);
    b.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
