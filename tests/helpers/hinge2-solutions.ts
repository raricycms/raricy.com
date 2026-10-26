import type { Action } from '../../src/games/hinge2/engine';

export const HINGE2_SOLUTIONS: Record<string, Action[]> = {
  turn: [{ type: 'turn', amount: 1 }, { type: 'walk', to: 'd' }, { type: 'turn', amount: -1 }, { type: 'walk', to: 'goal' }],
  mirror: [{ type: 'walk', to: 'b' }, { type: 'mirror' }, { type: 'walk', to: 'goal' }],
  fold: [{ type: 'fold' }, { type: 'walk', to: 'f' }, { type: 'fold' }, { type: 'walk', to: 'goal' }],
  hinge: [{ type: 'turn', amount: 1 }, { type: 'walk', to: 'r2' }, { type: 'mirror' }, { type: 'walk', to: 'e' }, { type: 'fold' }, { type: 'walk', to: 'h' }, { type: 'fold' }, { type: 'turn', amount: -1 }, { type: 'walk', to: 'goal' }],
};
