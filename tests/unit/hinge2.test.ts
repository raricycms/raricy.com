import { describe, expect, it } from 'vitest';
import { attempt, graph, initialState, isWon, position, replay, route, type Action, type State } from '../../src/games/hinge2/engine';
import { LEVELS, levelById } from '../../src/games/hinge2/levels';
import { readProgress } from '../../src/games/hinge2/progress';
import { HINGE2_SOLUTIONS } from '../helpers/hinge2-solutions';

describe('合页 II：空间变换与道路', () => {
  for (const level of LEVELS) {
    it(`${level.title}能在拾齐印记后通关，每个落点确实相连`, () => {
      let state = initialState(level);
      expect(isWon(level, state)).toBe(false);
      for (const action of HINGE2_SOLUTIONS[level.id]) {
        if (action.type === 'walk') expect(route(level, state, action.to), action.to).not.toBeNull();
        const next = attempt(level, state, action);
        expect(next.error).toBeUndefined();
        state = next.state;
      }
      expect(isWon(level, state)).toBe(true);
    });
    it(`${level.title}中每一种机关都是通关必需的`, () => {
      // Exhaust the finite geometry and stamp states, forbidding one mechanism each time.
      for (const excluded of level.mechanics) {
        const queue: State[] = [initialState(level)];
        const seen = new Set<string>();
        let solvable = false;
        while (queue.length) {
          const state = queue.shift()!;
          const key = `${state.player}:${((state.turn % 4) + 4) % 4}:${state.mirror}:${state.folded}:${state.seals.slice().sort()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (isWon(level, state)) { solvable = true; break; }
          const actions: Action[] = [...(graph(level, state).get(state.player) ?? []).map((to): Action => ({ type: 'walk', to }))];
          if (level.mechanics.includes('turn') && excluded !== 'turn') actions.push({ type: 'turn', amount: 1 });
          if (level.mechanics.includes('mirror') && excluded !== 'mirror') actions.push({ type: 'mirror' });
          if (level.mechanics.includes('fold') && excluded !== 'fold') actions.push({ type: 'fold' });
          actions.forEach((action) => queue.push(attempt(level, state, action).state));
        }
        expect(solvable, `不使用 ${excluded} 不应通关`).toBe(false);
      }
    });
  }
  it('整页转动携带纸页上的人，外侧平台保持固定', () => {
    const level = LEVELS[0];
    const state = replay(level, HINGE2_SOLUTIONS.turn.slice(0, 2))!;
    const player = level.nodes.find((n) => n.id === state.player)!;
    const anchor = level.nodes.find((n) => n.id === 'goal')!;
    const next = attempt(level, state, { type: 'turn', amount: -1 }).state;
    expect(position(player, next)).not.toEqual(position(player, state));
    expect(position(anchor, next)).toEqual(position(anchor, state));
  });
  it('镜中人保留落点身份，随反射移到另一平台', () => {
    const level = levelById('mirror');
    const state = replay(level, HINGE2_SOLUTIONS.mirror.slice(0, 1))!;
    const next = attempt(level, state, { type: 'mirror' }).state;
    expect(next.player).toBe('b');
    expect(route(level, state, 'goal')).toBeNull();
    expect(route(level, next, 'goal')).not.toBeNull();
  });
  it('折起才能跨页，人在右页时展开会回到右侧', () => {
    const level = levelById('fold');
    expect(route(level, initialState(level), 'seal')).toBeNull();
    const folded = replay(level, HINGE2_SOLUTIONS.fold.slice(0, 2))!;
    const node = level.nodes.find((n) => n.id === folded.player)!;
    expect(position(node, folded).x).toBeLessThan(0);
    const unfolded = attempt(level, folded, { type: 'fold' }).state;
    expect(position(node, unfolded).x).toBeGreaterThan(0);
    expect(route(level, unfolded, 'goal')).not.toBeNull();
  });
  it('不允许隔空走路，抵达门而未拾取印记不能获胜', () => {
    const level = LEVELS[0], state = initialState(level);
    expect(attempt(level, state, { type: 'walk', to: 'goal' }).state).toBe(state);
    expect(isWon(level, { ...state, player: 'goal' })).toBe(false);
  });
  it('存档回放合法历史并丢弃伪造动作、损坏内容和不可达落点', () => {
    const saved = readProgress(JSON.stringify({ selected: 'mirror', runs: { mirror: HINGE2_SOLUTIONS.mirror, turn: [{ type: 'walk', to: 'goal' }], fold: [{ type: 'turn', amount: 10 }] } }));
    expect(saved.selected).toBe('mirror');
    expect(saved.runs.mirror).toEqual(HINGE2_SOLUTIONS.mirror);
    expect(saved.runs.turn).toBeUndefined();
    expect(saved.runs.fold).toBeUndefined();
    expect(readProgress('{broken').runs).toEqual({});
  });
});
