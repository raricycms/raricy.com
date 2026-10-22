import { describe, expect, it } from 'vitest';
import { initialRotations, isRotatable, makeLevel, minimumMoves, nextHint, reflect, solutions, starsFor, trace } from '../../src/games/lumen/engine';
import { LEVELS, CHAPTERS } from '../../src/games/lumen/levels';
import { freshProgress, readProgress } from '../../src/games/lumen/progress';

const board = (rows: string[]) => makeLevel('test', 'test', 0, '', '', 1, rows);

describe('光学规则', () => {
  it('两种镜片朝向都正确反射四个方向', () => {
    expect([0, 1, 2, 3].map((d) => reflect(d as 0 | 1 | 2 | 3, 0))).toEqual([1, 0, 3, 2]);
    expect([0, 1, 2, 3].map((d) => reflect(d as 0 | 1 | 2 | 3, 1))).toEqual([3, 2, 1, 0]);
  });
  it('分光同时保留直行与反射，墙和接收器都会吸收光', () => {
    const l = board(['..o..', '.....', 'e.p.o', '.....', '.....']);
    expect(trace(l, initialRotations(l))).toMatchObject({ solved: true, lit: 2 });
    const blocked = board(['.....', '.....', 'e#o..', '.....', '.....']);
    expect(trace(blocked, initialRotations(blocked)).lit).toBe(0);
    const absorbed = board(['.....', '.....', 'eOo..', '.....', '.....']);
    expect(trace(absorbed, initialRotations(absorbed)).lit).toBe(0);
  });
  it('双环必须两色齐全；给单色环多送一种光也不成功', () => {
    const l = board(['.....', '.m@M.', '.....', 'em.MW', '.....']);
    expect(trace(l, initialRotations(l)).solved).toBe(true);
    const single = board(['.....', '.moM.', '.....', 'em.MW', '.....']);
    expect(trace(single, initialRotations(single))).toMatchObject({ solved: false, lit: 0 });
    const missing = board(['.....', '.m@..', '.....', 'em...', '.....']);
    expect(trace(missing, initialRotations(missing)).solved).toBe(false);
  });
  it('穿门保留颜色和方向，不绘制跨空间的假光线', () => {
    const l = board(['.....', 'E1...', '.....', '.1..O', '.....']);
    const result = trace(l, initialRotations(l));
    expect(result.solved).toBe(true);
    expect(result.segments.every((s) => s.color === 2 && s.y1 === s.y2)).toBe(true);
  });
  it('包含分光与传送门的回路始终有界', () => {
    const loop = board(['.......', '.p...M.', '.......', 'eP...p.', '.......', '.M...m.', '.......']);
    const result = trace(loop, initialRotations(loop));
    expect(result.segments.length).toBeLessThanOrEqual(loop.size ** 2 * 8);
    expect(result.solved).toBe(false);
    const portalLoop = board(['..1..', '.....', 'e.p..', '.....', '..1..']);
    const loopResult = trace(portalLoop, initialRotations(portalLoop));
    expect(loopResult.segments.length).toBeGreaterThan(8);
    expect(loopResult.segments.length).toBeLessThan(30);
  });
  it('评分只依照步数，边界一致', () => {
    expect([4, 5, 7, 8].map((moves) => starsFor(moves, 4))).toEqual([3, 2, 2, 1]);
  });
});

describe('全部关卡的可解性与教学约束', () => {
  it('关卡标识唯一，章节齐全', () => {
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    expect(new Set(LEVELS.map((l) => l.chapter)).size).toBe(CHAPTERS.length);
  });
  for (const l of LEVELS) it(`${l.id} ${l.title}：有解、最优步数准确、从错误局面也能逐步提示通关`, () => {
    expect(trace(l, initialRotations(l)).solved).toBe(false);
    expect(minimumMoves(l)).toBe(l.par);
    expect(l.size).toBeLessThanOrEqual(7);
    expect(solutions(l).length).toBeGreaterThan(0);
    const portals = l.pieces.filter((p) => p.kind === 'portal');
    for (const portal of portals) expect(portals.filter((p) => p.pair === portal.pair)).toHaveLength(2);
    // Start from the complement of the author's layout, rather than a stored solution.
    const rotations = l.pieces.map((p) => isRotatable(p) ? 1 - (p.rotation ?? 0) : p.rotation ?? 0);
    let steps = 0;
    while (!trace(l, rotations).solved && steps < 13) {
      const hint = nextHint(l, rotations);
      expect(hint).not.toBeNull();
      expect(isRotatable(l.pieces[hint!])).toBe(true);
      rotations[hint!] = 1 - rotations[hint!];
      steps++;
    }
    expect(trace(l, rotations).solved).toBe(true);
    expect(nextHint(l, rotations)).toBeNull();
  });
});

describe('存档恢复', () => {
  it('坏 JSON、未知版本与未知关卡都可回退', () => {
    for (const raw of ['broken', 'null', '{"version":99}', '{"version":1,"current":{"id":"old"}}']) {
      expect(readProgress(raw, LEVELS)).toEqual(freshProgress(LEVELS));
    }
  });
  it('续上未完成的局面，只保留合法成绩，不信任固定镜片朝向', () => {
    const l = LEVELS[3];
    const saved = freshProgress(LEVELS);
    saved.current = { id: l.id, rotations: initialRotations(l), moves: 2 };
    saved.best = { '01': 1, '02': -1, '03': 0, unknown: 3 };
    expect(readProgress(JSON.stringify(saved), LEVELS)).toMatchObject({ current: saved.current, best: { '01': 1 } });
    saved.current.rotations[l.pieces.findIndex((p) => p.fixed)] ^= 1;
    expect(readProgress(JSON.stringify(saved), LEVELS).current.id).toBe('01');
  });
  it('拒绝数组长度不符、非二进制朝向与不可能的步数', () => {
    const saved = freshProgress(LEVELS);
    saved.current.rotations = [NaN];
    expect(readProgress(JSON.stringify(saved), LEVELS).current).toEqual(freshProgress(LEVELS).current);
    saved.current.rotations = solutions(LEVELS[0])[0];
    expect(readProgress(JSON.stringify(saved), LEVELS).current).toEqual(freshProgress(LEVELS).current);
  });
});
