import { describe, expect, it } from 'vitest';
import { attempt, clippedHalf, flapMatrix, goalStatus, hasPaper, initialState, isWon, markKey, multiply, reflected, reflectionMatrix, replay, signedDistance, transfers, type Mark } from '../../src/games/hinge3/engine';
import { LEVELS, levelById } from '../../src/games/hinge3/levels';
import { readProgress } from '../../src/games/hinge3/progress';
import { HINGE3_SOLUTIONS } from '../helpers/hinge3-solutions';

describe('合页 III：接触、镜像与两张材质面', () => {
  for (const level of LEVELS) it(`${level.title}的目标能由实际折叠压印完成`, () => {
    const state = replay(level, HINGE3_SOLUTIONS[level.id]);
    expect(state).not.toBeNull();
    expect(isWon(level, state!)).toBe(true);
  });
  it('一压只转印一次，原稿变干，新印痕仍湿，方向是真实镜像', () => {
    const level = LEVELS[0];
    const folded = attempt(level, initialState(level), { type: 'fold', crease: 'A' }).state;
    const result = attempt(level, folded, { type: 'press' });
    expect(result.printed).toBe(1);
    expect(result.state.ink).toHaveLength(2);
    expect(result.state.ink.find((mark) => mark.x === 2)?.wet).toBe(false);
    expect(result.state.ink.find((mark) => mark.x === 6)).toMatchObject({ wet: true, matrix: [-1, 0, 0, 1] });
    expect(attempt(level, result.state, { type: 'press' }).state).toBe(result.state);
    expect(isWon(level, result.state)).toBe(false);
  });
  it('目标同时检查方向，不能只到达正确位置', () => {
    const level = levelById('twice'), state = initialState(level);
    const goal = level.goals[0];
    expect(goalStatus(goal, { ...state, ink: [{ ...goal, matrix: [-1, 0, 0, 1], wet: true }] })).toBe('wrong');
  });
  it('洞阻止接触，压空后源墨不会变干；换次序才可抵达目标', () => {
    const level = levelById('window');
    const folded = attempt(level, initialState(level), { type: 'fold', crease: 'A' }).state;
    expect(transfers(level, folded)).toEqual([]);
    const pressed = attempt(level, folded, { type: 'press' });
    expect(pressed.printed).toBe(0);
    expect(pressed.state.ink[0].wet).toBe(true);
    expect(isWon(level, replay(level, HINGE3_SOLUTIONS.window)!)).toBe(true);
  });
  it('折起露出的背面不参与正面的接触，颜色不会穿透纸张', () => {
    const level = levelById('reverse');
    const state = replay(level, HINGE3_SOLUTIONS.first)!;
    expect(state.ink.filter((mark) => mark.face === 'back')).toHaveLength(1);
    expect(isWon(level, state)).toBe(false);
    expect(isWon(level, replay(level, HINGE3_SOLUTIONS.reverse)!)).toBe(true);
  });
  it('纸折起时不能翻面或换折痕，展开后才可完成', () => {
    const level = LEVELS[0], state = replay(level, [{ type: 'fold', crease: 'A' }])!;
    expect(attempt(level, state, { type: 'flip' }).state).toBe(state);
    expect(attempt(level, state, { type: 'fold', crease: 'A' }).state).toBe(state);
  });
  it('动画终点与引擎的镜像坐标完全相同，斜折也遵守同一公式', () => {
    for (const level of LEVELS) for (const crease of level.creases) {
      const point = { x: 2, y: 6 }, expected = reflected(point, crease), [a, b, c, d, e, f] = flapMatrix(crease, 1);
      expect(a * point.x + c * point.y + e).toBeCloseTo(expected.x, 5);
      expect(b * point.x + d * point.y + f).toBeCloseTo(expected.y, 5);
      expect(clippedHalf(crease, crease.side).length).toBeGreaterThanOrEqual(3);
    }
  });
  it('压印读取快照，同时接触的两份墨不会在一压内反复复制', () => {
    const level = LEVELS[0], state = initialState(level);
    state.ink.push({ ...state.ink[0], x: 6 });
    const folded = attempt(level, state, { type: 'fold', crease: 'A' }).state;
    expect(attempt(level, folded, { type: 'press' }).printed).toBe(2);
  });
  it('按回放校验存档，伪造折痕和非法顺序不会被接纳', () => {
    const data = { selected: 'window', runs: { window: HINGE3_SOLUTIONS.window, first: [{ type: 'press' }], twice: [{ type: 'fold', crease: 'missing' }] } };
    const result = readProgress(JSON.stringify(data));
    expect(result.runs.window).toEqual(HINGE3_SOLUTIONS.window);
    expect(result.runs.first).toBeUndefined();
    expect(result.runs.twice).toBeUndefined();
    expect(readProgress('broken').runs).toEqual({});
  });
  it('穷举所有可能的印痕：窗口需要两条折痕，套印需要斜折', () => {
    // Search every possible impression of a wet mark, rather than removing steps
    // from the authored solution. Returning to an old location is included.
    for (const [id, excluded] of [['window', 'A'], ['window', 'B'], ['register', 'C']]) {
      const level = levelById(id);
      const queue: Mark[] = [...level.ink], reached = new Set<string>();
      while (queue.length) {
        const mark = queue.shift()!;
        if (reached.has(markKey(mark))) continue;
        reached.add(markKey(mark));
        for (const crease of level.creases.filter((c) => c.id !== excluded)) {
          if (Math.abs(signedDistance(mark, crease)) < .45) continue;
          const next = { ...mark, ...reflected(mark, crease), matrix: multiply(reflectionMatrix(crease), mark.matrix) };
          if (hasPaper(level, next)) queue.push(next);
        }
      }
      expect(level.goals.every((goal) => reached.has(markKey(goal))), `${id} without ${excluded}`).toBe(false);
    }
    expect(markKey(LEVELS[0].ink[0])).not.toBe(markKey(LEVELS[0].goals[0]));
  });
});
