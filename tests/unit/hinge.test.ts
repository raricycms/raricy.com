import { describe, expect, it } from 'vitest';
import { attempt, initialState, isWon, possibleActions, replay, stateKey, type Action, type Level, type State } from '../../src/games/hinge/engine';
import { LEVELS, levelById, MAIN_LEVEL } from '../../src/games/hinge/levels';
import { freshProgress, readProgress } from '../../src/games/hinge/progress';
import { HINGE_SOLUTIONS } from '../helpers/hinge-solutions';

function solve(level: Level, allowed: (state: State, action: Action) => boolean = () => true): Action[] | null {
  const start = initialState(level);
  const queue = [{ state: start, path: [] as Action[] }];
  const seen = new Set([stateKey(level, start)]);
  const actions = possibleActions(level);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    if (isWon(level, node.state)) return node.path;
    for (const action of actions) {
      if (!allowed(node.state, action)) continue;
      const result = attempt(level, node.state, action);
      if (result.error) continue;
      const key = stateKey(level, result.state);
      if (seen.has(key)) continue;
      seen.add(key); queue.push({ state: result.state, path: [...node.path, action] });
    }
  }
  return null;
}

describe('合页：人物属于半间，纸片改变外部连接', () => {
  it('搬运人物保留房内身份；没有地板或门未对齐时不能走', () => {
    const level = levelById('02');
    const start = initialState(level);
    const boarded = attempt(level, start, { type: 'walk', direction: 1 }).state;
    expect(boarded.player).toEqual({ room: 'bridge', chamber: 0 });
    expect(attempt(level, boarded, { type: 'walk', direction: 1 }).error).toContain('没有地板');
    const carried = attempt(level, boarded, { type: 'slide', room: 'bridge', direction: 1 }).state;
    expect(carried.player).toEqual(boarded.player);
    expect(start.poses.bridge.x).toBe(1);
    expect(carried.poses.bridge.x).toBe(2);
    expect(isWon(level, attempt(level, carried, { type: 'walk', direction: 1 }).state)).toBe(true);
    const corner = levelById('03');
    const away = replay(corner, [{ type: 'rotate', room: 'corner', amount: 1 }, { type: 'rotate', room: 'corner', amount: 1 }])!;
    expect(attempt(corner, away, { type: 'walk', direction: 1 }).error).toContain('门没有对齐');
    const inCorner = attempt(corner, initialState(corner), { type: 'walk', direction: 1 }).state;
    const wrongTurn = attempt(corner, inCorner, { type: 'rotate', room: 'corner', amount: -1 }).state;
    expect(attempt(corner, wrongTurn, { type: 'walk', direction: 1 }).error).toContain('没有地板');
    const flipped = attempt(corner, wrongTurn, { type: 'rotate', room: 'corner', amount: -1 }).state;
    expect(attempt(corner, flipped, { type: 'walk', direction: 3 }).error).toBeDefined();
  });
  it('转半圈不会穿过隔墙；走到外面再转才会进入另一半间', () => {
    const level = levelById('04');
    let state = initialState(level);
    for (let i = 0; i < 4; i++) {
      state = attempt(level, state, { type: 'rotate', room: 'split', amount: 1 }).state;
      expect(state.player).toEqual(level.start);
      expect(isWon(level, state)).toBe(false);
    }
    expect(stateKey(level, state)).toBe(stateKey(level, initialState(level)));
    expect(replay(level, HINGE_SOLUTIONS['04'])?.player).toEqual(level.goal);
  });
  it('滑动、转轴、固定钉和槽位约束不能互相绕过', () => {
    const level = levelById('01'), state = initialState(level);
    for (const action of [
      { type: 'slide', room: 'start', direction: 1 },
      { type: 'rotate', room: 'bridge', amount: 1 },
      { type: 'slide', room: 'bridge', direction: 2 },
      { type: 'rotate', room: 'missing', amount: 1 },
    ] as Action[]) expect(attempt(level, state, action).state).toBe(state);
    const raised = attempt(level, state, { type: 'slide', room: 'bridge', direction: 0 }).state;
    expect(attempt(level, raised, { type: 'slide', room: 'bridge', direction: 1 }).error).toContain('占用');
    const main = initialState(MAIN_LEVEL);
    expect(attempt(MAIN_LEVEL, main, { type: 'slide', room: 'split', direction: 0 }).error).toContain('槽位');
    expect(attempt(MAIN_LEVEL, main, { type: 'slide', room: 'wait', direction: 0 }).error).toBeDefined();
  });
  it.each(LEVELS.map((level) => [level.id, level] as const))('%s：手写解法和独立搜索都可到达终点', (_id, level) => {
    expect(isWon(level, initialState(level))).toBe(false);
    const end = replay(level, HINGE_SOLUTIONS[level.id]);
    expect(end).not.toBeNull();
    expect(isWon(level, end!)).toBe(true);
    const path = solve(level);
    expect(path).not.toBeNull();
    expect(path!.length).toBeLessThanOrEqual(HINGE_SOLUTIONS[level.id].length);
  });
  it('桥不够长必须载人；隔墙必须在房外转动；终点必须空载运回', () => {
    expect(solve(levelById('02'), (s, a) => !(a.type === 'slide' && a.room === s.player.room))).toBeNull();
    expect(solve(levelById('04'), (s, a) => !(a.type === 'rotate' && a.room !== s.player.room))).toBeNull();
    expect(solve(levelById('05'), (s, a) => !(a.type === 'slide' && a.room !== s.player.room))).toBeNull();
    // 主谜题没有进度锁，但无法跳过载人、候室换位和空载搬运中的任一项。
    expect(solve(MAIN_LEVEL, (s, a) => !(a.type === 'slide' && a.room === s.player.room))).toBeNull();
    expect(solve(MAIN_LEVEL, (s, a) => !(a.type === 'slide' && a.room !== s.player.room))).toBeNull();
    expect(solve(MAIN_LEVEL, (_s, a) => a.type !== 'rotate')).toBeNull();
  });
});

describe('合页：存档只接纳合法的动作历史', () => {
  it('保留未完成的局面和自由选题，损坏的局面单独回退', () => {
    const progress = { ...freshProgress(), selected: 'main', runs: { main: HINGE_SOLUTIONS.main.slice(0, 4) }, completed: ['01'] };
    expect(readProgress(JSON.stringify(progress))).toEqual(progress);
    const restored = readProgress(JSON.stringify({ ...progress, runs: { ...progress.runs, '02': [{ type: 'walk', direction: 0 }] } }));
    expect(restored.runs.main).toEqual(progress.runs.main);
    expect(restored.runs['02']).toBeUndefined();
  });
  it('拒绝不完整 JSON、旧版、越界方向和虚构的房间', () => {
    for (const raw of ['{', 'null', '{"version":2}']) expect(readProgress(raw)).toEqual(freshProgress());
    const restored = readProgress(JSON.stringify({ version: 1, selected: 'missing', completed: ['01', '01', 'bogus'], runs: {
      '01': [{ type: 'walk', direction: 7 }], '02': [{ type: 'rotate', room: 'bogus', amount: 1 }],
      '03': [{ type: 'rotate', room: 'corner', amount: 4 }],
    } }));
    expect(restored).toEqual({ ...freshProgress(), completed: ['01'] });
  });
});
