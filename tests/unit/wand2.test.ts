import { afterEach, describe, expect, it, vi } from 'vitest';
import { Meadow, blocked, move } from '../../shared/wand2/world';
import { ATTACK_MS, INPUT, MAX_SLIMES, decodeInput, encodeInput, parseSnapshot } from '../../shared/wand2/protocol';
import { createWand2Game } from '../../services/realtime/src/wand2';
import type { RealtimePeer } from '../../services/realtime/src/game';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (world: Meadow, ms: number) => { for (let i = 0; i < ms; i += 50) world.step(50); };
function arena() {
  const w = new Meadow(() => .4); w.join('a', 'account-a', '猫猫'); w.slimes.clear();
  return w;
}
function slime(w: Meadow, x: number, y: number, id = 900, hp = 2) {
  w.slimes.set(id, { id, x, y, kind: 0, hp, mood: 'wander', phase: 1000, dx: 0, dy: 0 });
  return w.slimes.get(id)!;
}

describe('Wand demo 2 权威战斗', () => {
  it('校验二进制按键和完整快照，拒绝越界/伪造形状', () => {
    expect(decodeInput(encodeInput(INPUT.attack | INPUT.right, 65535))).toEqual({ buttons: 24, sequence: 65535 });
    for (const input of [new Uint8Array(), new Uint8Array([1, 0, 0, 1]), new Uint8Array([2, 32, 0, 1])]) expect(decodeInput(input)).toBeNull();
    const w = arena(), snapshot = w.snapshot(); expect(parseSnapshot(snapshot)).toEqual(snapshot);
    for (const changes of [{ x: Infinity }, { facing: 4 }, { catnip: -1 }, { attack: ATTACK_MS + 1 }]) {
      expect(parseSnapshot({ ...snapshot, players: [{ ...snapshot.players[0], ...changes }] })).toBeNull();
    }
    expect(parseSnapshot({ ...snapshot, players: [snapshot.players[0], snapshot.players[0]] })).toBeNull();
    expect(parseSnapshot({ ...snapshot, slimes: [{ id: 1, x: 20, y: 20, kind: 0, hp: 2, mood: 'invented', phase: 0 }] })).toBeNull();
  });

  it('斜向等速、逐步碰撞与服务端时间步上限', () => {
    const w = arena(), p = w.players.get('a')!; p.buttons = INPUT.up | INPUT.right; const { x, y } = p;
    w.step(10000); expect(Math.hypot(p.x - x, p.y - y)).toBeCloseTo(15);
    const edge = { x: 16, y: 320 }; move(edge, -500, 0); expect(edge.x).toBeGreaterThanOrEqual(12);
    const rock = { x: 180, y: 160 }; move(rock, 180, 0); expect(rock.x).toBeLessThan(200); expect(blocked(rock.x, rock.y)).toBe(false);
  });

  it('长剑按朝向和距离命中，一次挥剑仅伤害一次，击杀奖励仅发一次', () => {
    const w = arena(), p = w.players.get('a')!, front = slime(w, 155, 320), back = slime(w, 45, 320, 901), far = slime(w, 250, 320, 902);
    p.buttons = INPUT.attack; advance(w, 100); expect(front.hp).toBe(1); expect(back.hp).toBe(2); expect(far.hp).toBe(2);
    advance(w, 200); expect(front.hp).toBe(1); expect(p.catnip).toBe(0);
    // 固定目标到攻击范围，验证冷却后的第二剑，而非依赖怪物移动时机。
    Object.assign(front, { x: 155, y: 320, mood: 'stunned', phase: 1000 });
    advance(w, 300); expect(front.mood).toBe('dying'); expect(p.catnip).toBe(1);
    advance(w, 1000); expect(p.catnip).toBe(1); expect(w.slimes.has(front.id)).toBe(false);
  });

  it('同一帧多人击杀只计一份奖励，同账号多标签及重连共享分数', () => {
    const w = arena(); w.join('b', 'account-a', '猫猫'); w.join('c', 'account-c', '同伴'); w.slimes.clear(); slime(w, 150, 320, 900, 1);
    w.players.get('a')!.buttons = INPUT.attack; w.players.get('c')!.buttons = INPUT.attack;
    advance(w, 100);
    expect(w.players.get('a')!.catnip).toBe(1); expect(w.players.get('b')!.catnip).toBe(1); expect(w.players.get('c')!.catnip).toBe(0);
    const snapshot = w.snapshot(); expect(snapshot.leaderboard).toHaveLength(2); expect(snapshot.leaderboard[0].connections).toBe(2);
    w.leave('a'); w.leave('b'); w.join('again', 'account-a', '猫猫'); expect(w.players.get('again')!.catnip).toBe(1);
  });

  it('背后的石头阻挡剑击，怪物接触触发受击和击退，无血量及扣分', () => {
    const w = arena(), p = w.players.get('a')!;
    Object.assign(p, { x: 180, y: 160, facing: 2, buttons: INPUT.attack });
    const behind = slime(w, 250, 160, 900); advance(w, 100); expect(behind.hp).toBe(2);
    w.slimes.clear(); Object.assign(p, { x: 100, y: 320, buttons: 0, attack: 0 }); slime(w, 115, 320);
    w.step(50); expect(p.hurt).toBe(850); expect(p.x).toBeLessThan(100); expect(p.catnip).toBe(0); expect('hp' in p).toBe(false);
    const x = p.x; w.step(50); expect(p.hurt).toBe(800); expect(p.x).toBe(x);
  });

  it('史莱姆追逐、预警扑击、绕石，在线时刷新且有上限，空场清理', () => {
    const w = arena(), p = w.players.get('a')!, m = slime(w, 300, 320);
    advance(w, 100); expect(m.mood).toBe('chase'); expect(m.x).toBeLessThan(300);
    Object.assign(m, { x: 170, y: 320 }); w.step(50); expect(m.mood).toBe('windup');
    advance(w, 550); expect(m.mood).toBe('lunge'); advance(w, 200); expect(p.hurt).toBeGreaterThan(0);
    Object.assign(p, { x: 180, y: 160 }); Object.assign(m, { x: 300, y: 160, mood: 'chase', phase: 0 });
    advance(w, 6000); expect(blocked(m.x, m.y)).toBe(false); expect(m.x).toBeLessThan(240);
    advance(w, 120000); expect(w.slimes.size).toBeLessThanOrEqual(MAX_SLIMES); expect(w.slimes.size).toBeGreaterThan(1);
    w.leave('a'); expect(w.slimes.size).toBe(0); advance(w, 2000); expect(w.slimes.size).toBe(0);
  });

  it('序号回绕、旧输入拒绝、断输入停步与停剑、最后离线时停止定时器', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const packets: unknown[] = [], disconnect = vi.fn();
    const peer: RealtimePeer = { id: 'a', identity: { userId: 'a', username: '猫猫', sessionVersion: 0 },
      send(packet) { packets.push(JSON.parse(String(packet))); return true; }, disconnect };
    const game = createWand2Game({ consume: async () => null, validate: async () => true }), session = game.connect(peer);
    const tick = (ms: number) => { for (let i = 0; i < ms; i += 50) { now += 50; vi.advanceTimersByTime(50); } };
    const player = () => parseSnapshot(packets.at(-1))!.players[0];
    session.receive({ binary: true, data: encodeInput(INPUT.right | INPUT.attack, 65535) }); tick(50); const right = player().x;
    session.receive({ binary: true, data: encodeInput(INPUT.left, 65534) }); tick(50); expect(player().x).toBeGreaterThan(right);
    session.receive({ binary: true, data: encodeInput(INPUT.left, 0) }); tick(50); expect(player().x).toBeLessThan(right + 3);
    tick(500); const stopped = player().x; tick(1000); expect(player().x).toBe(stopped); expect(player().attack).toBe(0);
    session.receive({ binary: true, data: encodeInput(INPUT.attack, 1) });
    session.receive({ binary: true, data: encodeInput(0, 2) }); tick(50); expect(player().attack).toBeGreaterThan(0);
    tick(600); expect(player().attack).toBe(0);
    session.receive({ binary: false, data: '{"catnip":999}' }); expect(disconnect).toHaveBeenCalledOnce();
    session.close(); expect(vi.getTimerCount()).toBe(0);
  });
});
