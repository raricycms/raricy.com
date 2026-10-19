import { describe, expect, it } from 'vitest';
import { EXTRAPOLATE_MS, INTERP_DELAY_MS, MAX_SAMPLES, Motion } from '../../src/games/wand2/motion';
import { INPUT, SPEED, type Player, type Slime, type Snapshot } from '../../shared/wand2/protocol';

const player = (over: Partial<Player> = {}): Player => ({
  id: 'a', name: '猫猫', x: 100, y: 320, facing: 2, moving: true, attack: 0, hurt: 0, catnip: 0, ...over,
});
const snapshot = (tick: number, players: Player[], slimes: Slime[] = []): Snapshot =>
  ({ type: 'wand2.snapshot', tick, players, slimes, leaderboard: [] });
const at = (motion: Motion, now: number, ownId = '', buttons = 0) => motion.sample(now, ownId, buttons)!;

describe('Wand demo 2 客户端运动平滑', () => {
  it('没有快照时没有画面，收到一帧就先画那一帧', () => {
    const motion = new Motion();
    expect(motion.sample(100, '', 0)).toBeNull();
    motion.push(snapshot(1, [player()]), 1000);
    const scene = at(motion, 1000 + INTERP_DELAY_MS);
    expect(scene.players[0]).toMatchObject({ x: 100, y: 320 });
    expect(motion.size).toBe(1);
  });

  it('按到达时刻插值：渲染时刻落在两帧之间时取中间位置', () => {
    const motion = new Motion();
    motion.push(snapshot(1, [player({ x: 100 })]), 0);
    motion.push(snapshot(2, [player({ x: 150 })]), 50);
    // 渲染时刻（now - 缓冲）= 25 → 正好两帧中间
    expect(at(motion, 25 + INTERP_DELAY_MS).players[0].x).toBeCloseTo(125, 5);
    // 缓冲消费到区间起点
    expect(at(motion, 0 + INTERP_DELAY_MS).players[0].x).toBeCloseTo(100, 5);
    // 还没到区间终点
    expect(at(motion, 40 + INTERP_DELAY_MS).players[0].x).toBeCloseTo(140, 5);
  });

  it('包迟到时用最后速度外推，而不是定住等人', () => {
    const motion = new Motion();
    // 150px/s → 50ms 走 7.5px
    motion.push(snapshot(1, [player({ x: 100 })]), 0);
    motion.push(snapshot(2, [player({ x: 107.5 })]), 50);
    // 渲染时刻 75：最新包在 50 到达，晚了 25ms
    expect(at(motion, 75 + INTERP_DELAY_MS).players[0].x).toBeCloseTo(107.5 + 0.15 * 25, 5);
  });

  it('外推有上限：长卡顿后停在最后位置而不是越飘越远', () => {
    const motion = new Motion();
    motion.push(snapshot(1, [player({ x: 100 })]), 0);
    motion.push(snapshot(2, [player({ x: 107.5 })]), 50);
    const scene = at(motion, 50 + EXTRAPOLATE_MS * 10 + INTERP_DELAY_MS);
    expect(scene.players[0].x).toBeCloseTo(107.5 + 0.15 * EXTRAPOLATE_MS, 5);
  });

  it('包早到不会让画面先跳一下：插值仍然按到达时刻推进', () => {
    const motion = new Motion();
    motion.push(snapshot(1, [player({ x: 100 })]), 0);
    motion.push(snapshot(2, [player({ x: 107.5 })]), 30); // 只隔了 30ms 就到了
    // 渲染时刻 15 → 两帧中间
    expect(at(motion, 15 + INTERP_DELAY_MS).players[0].x).toBeCloseTo(103.75, 5);
  });

  it('自己那格用当前按键向前推，别人不动', () => {
    const motion = new Motion();
    motion.push(snapshot(1, [player({ id: 'a', x: 100 }), player({ id: 'b', x: 300, name: '路人' })]), 0);
    const scene = at(motion, 2 * INTERP_DELAY_MS, 'a', INPUT.right);
    // 权威位置在 time 那一刻，之后一个缓冲的位移由本地按键补上
    expect(scene.players.find(p => p.id === 'a')!.x).toBeCloseTo(100 + SPEED * (INTERP_DELAY_MS / 1000), 5);
    expect(scene.players.find(p => p.id === 'b')!.x).toBeCloseTo(300, 5);
    // 没按键就不推
    expect(at(motion, 2 * INTERP_DELAY_MS, 'a', 0).players.find(p => p.id === 'a')!.x).toBeCloseTo(100, 5);
  });

  it('自己前推遵守与服务端同一套状态规则：受击不动、挥剑减速、斜向不加速', () => {
    const motion = new Motion();
    const at2 = (motionAgain: Motion, now: number, buttons: number) => motionAgain.sample(now, 'a', buttons)!.players[0].x;
    const hurt = new Motion();
    hurt.push(snapshot(1, [player({ hurt: 850 })]), 0);
    expect(at2(hurt, 2 * INTERP_DELAY_MS, INPUT.right)).toBeCloseTo(100, 5);
    const attack = new Motion();
    attack.push(snapshot(1, [player({ attack: 300 })]), 0);
    expect(at2(attack, 2 * INTERP_DELAY_MS, INPUT.right)).toBeCloseTo(100 + SPEED * (INTERP_DELAY_MS / 1000) * 0.4, 5);
    const diagonal = new Motion();
    diagonal.push(snapshot(1, [player()]), 0);
    const start = diagonal.sample(2 * INTERP_DELAY_MS, 'a', 0)!.players[0];
    const moved = diagonal.sample(2 * INTERP_DELAY_MS, 'a', INPUT.right | INPUT.down)!.players[0];
    expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeCloseTo(SPEED * (INTERP_DELAY_MS / 1000), 5);
  });

  it('自己前推用同一份碰撞：朝着碎石推不会推进石头里', () => {
    const motion = new Motion();
    // (180,160) 右侧是 TILES 的碎石列（x=5，像素 200~240）
    motion.push(snapshot(1, [player({ x: 180, y: 160 })]), 0);
    const x = motion.sample(2 * INTERP_DELAY_MS, 'a', INPUT.right)!.players[0].x;
    expect(x).toBeLessThanOrEqual(188);
  });

  it('实体集合取较新的一帧：中途离开的立刻消失，中途加入的直接出现', () => {
    const motion = new Motion();
    motion.push(snapshot(1, [player({ id: 'a' }), player({ id: 'b', name: '走了' })]), 0);
    motion.push(snapshot(2, [player({ id: 'a' }), player({ id: 'c', name: '来了' })]), 50);
    const ids = at(motion, 25 + INTERP_DELAY_MS).players.map(p => p.id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('史莱姆同样插值，缓冲只保留最近几帧，清空后没有画面', () => {
    const motion = new Motion();
    const slime = (x: number): Slime => ({ id: 7, x, y: 200, kind: 0, hp: 2, mood: 'wander', phase: 0 });
    motion.push(snapshot(1, [player()], [slime(200)]), 0);
    motion.push(snapshot(2, [player()], [slime(210)]), 50);
    expect(at(motion, 25 + INTERP_DELAY_MS).slimes[0].x).toBeCloseTo(205, 5);
    for (let i = 0; i < 20; i++) motion.push(snapshot(i, [player()], [slime(200 + i)]), i * 50);
    expect(motion.size).toBe(MAX_SAMPLES);
    motion.clear();
    expect(motion.sample(9999, '', 0)).toBeNull();
  });
});
