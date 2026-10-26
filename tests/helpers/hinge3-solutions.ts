import type { Action } from '../../src/games/hinge3/engine';
const print = (crease: string): Action[] => [{ type: 'fold', crease }, { type: 'press' }, { type: 'unfold' }];
export const HINGE3_SOLUTIONS: Record<string, Action[]> = {
  first: print('A'), twice: [...print('A'), ...print('B')], window: [...print('B'), ...print('A')],
  reverse: [{ type: 'flip' }, ...print('A')],
  register: [...print('B'), ...print('A'), { type: 'flip' }, ...print('C'), ...print('B'), ...print('A')],
};
