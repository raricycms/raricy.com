import { describe, expect, it } from 'vitest';
import { countMirrors, emptyBoard, reflect, solve, trace, type Direction, type Level, type Mirror } from '../../src/games/lumen2/engine';
import { CHAPTERS, LEVELS, makeLevel } from '../../src/games/lumen2/levels';
import { freshProgress, readProgress, STORAGE_KEY } from '../../src/games/lumen2/progress';

const solutions = new Map(LEVELS.map((l) => [l.id, solve(l)]));

describe('折光 2：只用可放置的普通反射镜', () => {
  it('两种朝向四向反射，且光路可逆', () => {
    expect([0, 1, 2, 3].map((d) => reflect(d as Direction, 1))).toEqual([1, 0, 3, 2]);
    expect([0, 1, 2, 3].map((d) => reflect(d as Direction, 2))).toEqual([3, 2, 1, 0]);
    for (const mirror of [1, 2] as const) for (const dir of [0, 1, 2, 3] as const) {
      expect(reflect(((reflect(dir, mirror) + 2) % 4) as Direction, mirror)).toBe((dir + 2) % 4);
    }
  });
  it('空位直行、镜片反射，数量是硬上限，不能以任意同色出口代替所有出口', () => {
    const l = makeLevel('test', '', 0, 1, ['.o.', '.o.', '...'], ['W2'], ['N2'], '', [], '');
    expect(trace(l, emptyBoard(l)).beams[0].outcome).toBe('escaped');
    expect(trace(l, [0, 1]).solved).toBe(true);
    expect(trace(l, [2, 1]).solved).toBe(false);
    const extraTarget = { ...l, targets: [...l.targets, { ...l.targets[0], x: 0 }] };
    expect(trace(extraTarget, [0, 1]).solved).toBe(false);
  });
  it('双色不能互换出口，空处相交互不干扰，共用镜片同时作用于两束光', () => {
    const l = LEVELS[3], board = solutions.get(l.id)![0];
    const result = trace(l, board);
    expect(result.shared).toHaveLength(1);
    expect(result.beams.every((b) => b.outcome === 'arrived')).toBe(true);
    const swapped: Level = { ...l, targets: l.targets.map((p) => ({ ...p, color: p.color === 'gold' ? 'blue' : 'gold' })) };
    expect(trace(swapped, board).beams.map((b) => b.outcome)).toEqual(['wrong', 'wrong']);
    const crossed = makeLevel('cross', '', 0, 0, ['...', '...', '...'], ['W2', 'S2'], ['E2', 'N2'], '', [], '');
    expect(trace(crossed, []).solved).toBe(true);
  });
  it('即使将光源放进封闭回路，追迹仍会有限结束', () => {
    const l = makeLevel('loop', '', 0, 4, ['o.o', '...', 'o.o'], ['W1'], ['N2'], '', [], '');
    l.sources = [{ x: 1, y: 0, direction: 1, color: 'gold' }];
    const result = trace(l, [1, 2, 2, 1]);
    expect(result.beams[0].outcome).toBe('loop');
    expect(result.beams[0].points.length).toBeLessThanOrEqual(l.size ** 2 * 4 + 2);
  });
  it('剪枝求解器与逐个摆放的独立穷举一致，包括不照光的多余镜片', () => {
    const l = makeLevel('tiny', '', 0, 2, ['oo.', '.oo', '...'], ['W2'], ['N2'], '', [], '');
    const brute: Mirror[][] = [];
    for (let mask = 0; mask < 3 ** l.sockets.length; mask++) {
      const board = l.sockets.map((_, i) => Math.floor(mask / 3 ** i) % 3) as Mirror[];
      if (trace(l, board).solved) brute.push(board);
    }
    const encode = (boards: Mirror[][]) => boards.map((b) => b.join('')).sort();
    expect(encode(solve(l))).toEqual(encode(brute));
    expect(brute.length).toBeGreaterThan(1);
  });
});

describe('十二关的设计质量', () => {
  it('关卡、坐标、边缘端口和章节完整，初代机制没有混入', () => {
    expect(LEVELS).toHaveLength(12);
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(12);
    expect(new Set(LEVELS.map((l) => l.chapter)).size).toBe(CHAPTERS.length);
    for (const l of LEVELS) {
      expect(new Set(l.sockets.map((p) => `${p.x},${p.y}`)).size).toBe(l.sockets.length);
      expect(l.sockets.length).toBeLessThanOrEqual(16);
      expect(l.hints).toHaveLength(3);
      expect(new Set([...l.sources, ...l.targets].map((p) => `${p.x},${p.y}`)).size).toBe(l.sources.length + l.targets.length);
      for (const p of [...l.sources, ...l.targets]) {
        expect((p.x === -1 || p.x === l.size) !== (p.y === -1 || p.y === l.size)).toBe(true);
      }
    }
  });
  for (const l of LEVELS) it(`${l.id} ${l.title}：库存内唯一解、无少镜捷径、每面镜片都必需`, () => {
    const answers = solutions.get(l.id)!;
    expect(answers).toHaveLength(1);
    const board = answers[0], result = trace(l, board);
    expect(result.solved).toBe(true);
    expect(countMirrors(board)).toBe(l.stock);
    expect(solve({ ...l, stock: l.stock - 1 })).toHaveLength(0);
    expect(new Set(result.beams.flatMap((b) => b.mirrors)).size).toBe(l.stock);
    expect(trace(l, emptyBoard(l)).solved).toBe(false);
    if (l.sources.length > 1) expect(result.shared.length).toBeGreaterThan(0);
    for (let i = 0; i < board.length; i++) if (board[i]) {
      const removed = [...board]; removed[i] = 0;
      expect(trace(l, removed).solved).toBe(false);
    }
  });
  it('从 06 起，两束光各自都有多条实际路线，合在一起才排成唯一解', () => {
    for (const l of LEVELS.slice(5)) for (const source of l.sources) {
      const single = { ...l, sources: [source], targets: l.targets.filter((t) => t.color === source.color) };
      // Count paths, not layouts with unused decorative mirrors.
      const paths = new Set(solve(single).map((b) => trace(single, b).beams[0].mirrors.join(',')));
      expect(paths.size, `${l.id} ${source.color}`).toBeGreaterThan(1);
    }
  });
  it('第 10 关必须先打断已经接通的金光，再绕回来；不能保持直路通关', () => {
    const l = LEVELS[9];
    expect(trace(l, emptyBoard(l)).lit).toEqual([0]);
    const shared = l.sockets.findIndex((p) => p.x === 1 && p.y === 4);
    const intermediate = emptyBoard(l); intermediate[shared] = solutions.get(l.id)![0][shared];
    expect(trace(l, intermediate).lit).not.toContain(0);
    expect(trace(l, solutions.get(l.id)![0]).beams[0].mirrors.length).toBe(4);
  });
});

describe('折光 2 独立存档', () => {
  it('版本独立，损坏存档可回退，非法摆放不阻止保留已解记录', () => {
    expect(STORAGE_KEY).toBe('raricy_lumen_v2');
    for (const raw of ['broken', 'null', '{"version":2}']) expect(readProgress(raw, LEVELS)).toEqual(freshProgress(LEVELS));
    for (const board of [[0], [true, 0, 0], [3, 0, 0], [1, 1, 1]]) {
      const raw = JSON.stringify({ version: 1, current: { id: '01', board }, completed: ['01', '01', 'missing'] });
      expect(readProgress(raw, LEVELS)).toEqual({ ...freshProgress(LEVELS), completed: ['01'] });
    }
  });
  it('续上摆放与已解记录；恢复一个已解棋盘时同步完成记录', () => {
    const saved = freshProgress(LEVELS);
    saved.current = { id: '12', board: solutions.get('12')![0] };
    saved.completed = ['01'];
    expect(readProgress(JSON.stringify(saved), LEVELS)).toEqual({ ...saved, completed: ['01', '12'] });
  });
});
