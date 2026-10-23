import type { Action, Direction } from '../../src/games/hinge/engine';

const walk = (direction: Direction): Action => ({ type: 'walk', direction });
const slide = (room: string, direction: Direction): Action => ({ type: 'slide', room, direction });
const turn = (room: string, amount: 1 | -1 = 1): Action => ({ type: 'rotate', room, amount });

// 手写解法同时供逻辑回放与实际按钮测试使用；不打包到客户端。
export const HINGE_SOLUTIONS: Record<string, Action[]> = {
  '01': [slide('bridge', 0), walk(1), walk(1)],
  '02': [walk(1), slide('bridge', 1), walk(1)],
  '03': [turn('corner'), walk(1), walk(0)],
  '04': [walk(3), turn('split'), turn('split'), walk(1)],
  '05': [walk(1), slide('split', 0), slide('split', 1), slide('split', 1), slide('split', 2), turn('wait'), turn('wait'), walk(1)],
  main: [slide('split', 1), slide('split', 0), turn('wait', -1), walk(1), slide('split', 2), slide('split', 1), slide('split', 1), slide('split', 0), turn('wait'), turn('wait'), walk(1)],
};
