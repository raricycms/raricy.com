// 双影规则内核（src/games/twinshade/engine.ts）的单测。
//
// 这份用例的重点不是「覆盖行数」，而是**钉住那些写错了也不报错、只是玩法悄悄变了**的
// 判定：一侧被挡却整步放行、同纹组只动一块、滑行按格计步、最后一列车被误判成推不动、
// stateKey 把等价局面当两个……这些错误全都不会抛异常，只会让某一关变得「感觉不对」，
// 或者让 solver 算出的 par 变成假的。所以每个用例的注释都写清「这条在防哪种静默错误」。
//
// 关卡一律用 ASCII 在手边现拼（不走 levels.ts）：规则用例需要的是最小局面，
// 不是真关卡；这样某一关被改坏时，规则用例仍然在测规则本身。

import { describe, expect, it } from 'vitest';
import {
  cellXY,
  compileLevel,
  initialState,
  isSolved,
  resolveMove,
  stateKey,
  xyCell,
} from '../../src/games/twinshade/engine';
import type {
  BlockReason,
  CompiledLevel,
  Dir,
  GameState,
  LevelDef,
  MoveAccepted,
  MoveOutcome,
} from '../../src/games/twinshade/types';
import { blockedText } from '../../src/games/twinshade/types';

/** 用手写 ASCII 编一张测试关卡。par / act / hint 只为过 compileLevel 的形状校验，不参与规则。 */
function makeLevel(rows: readonly string[], patch: Partial<LevelDef> = {}): CompiledLevel {
  return compileLevel({ id: 'unit', act: 1, name: '单测', rows, par: 1, hint: '单测用提示', ...patch });
}

/** 取「这一步为什么没成立」；成立了就返回 null —— 顺带断言了 ok === false。 */
function blockedOf(outcome: MoveOutcome): { a: BlockReason | null; b: BlockReason | null } | null {
  return outcome.ok ? null : outcome.blocked;
}

/** 断言这一步成立（否则直接抛，报错里带 blocked，免得只看到 `expected false to be true`）。 */
function accepted(outcome: MoveOutcome): MoveAccepted {
  if (!outcome.ok) throw new Error(`期望这一步成立，实际被挡住：${JSON.stringify(outcome.blocked)}`);
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 同时移动：两侧都成立才动
// ─────────────────────────────────────────────────────────────────────────────

describe('M1 同时移动：任意一侧走不动，整步就不成立', () => {
  // 两盏灯在下一行，两侧出生点在同一行；往左 / 往右时恰好只有一侧贴着墙。
  const level = makeLevel([
    '#######',
    '#A...B#',
    '#o...o#',
    '#######',
  ]);

  it('一侧撞墙 → 整步作废，且 blocked 只标被挡的那一侧（归因正确）', () => {
    const start = initialState(level);

    // 往左：A 左边是墙（x=0），B 左边是空地。若引擎把整步放行，A 会穿墙或原地不动而
    // B 独自前进 —— 两个身体的相对位置从此错开，后面所有关的几何都跟着变。
    expect(blockedOf(resolveMove(level, start, 'left'))).toEqual({ a: 'wall', b: null });
    // 往右：镜像。这条在防「只检查第一侧」或「两侧原因写反」那种静默错。
    expect(blockedOf(resolveMove(level, start, 'right'))).toEqual({ a: null, b: 'wall' });
    // 往上：两侧都撞墙。归因表要两边都有值。
    expect(blockedOf(resolveMove(level, start, 'up'))).toEqual({ a: 'wall', b: 'wall' });

    // 文案的唯一来源也一并钉住：哪一侧被挡，玩家听到 / 看到的就是哪一侧。
    expect(blockedText({ a: 'wall', b: null })).toBe('本体被墙挡住了');
    expect(blockedText({ a: null, b: 'wall' })).toBe('影子被墙挡住了');
  });

  it('成立时两侧同向各走一格，moves +1，且方向增量与坐标一致', () => {
    const start = initialState(level);
    const outcome = accepted(resolveMove(level, start, 'down'));
    expect(outcome.state.a).toBe(xyCell(level, 1, 2));
    expect(outcome.state.b).toBe(xyCell(level, 5, 2));
    expect(outcome.state.moves).toBe(1);
    expect(cellXY(level, outcome.state.a)).toEqual({ x: 1, y: 2 });
    // 两盏灯都在下一行 ⇒ 这一步已经通关。
    expect(outcome.solved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 推箱
// ─────────────────────────────────────────────────────────────────────────────

describe('M2 石块：推一格 / 连锁 / 推到墙边不成立', () => {
  const one = makeLevel([
    '##########',
    '#Ab....B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('走进石头就把它推一格（身体进入石头原来的格子）', () => {
    const start = initialState(one);
    const outcome = accepted(resolveMove(one, start, 'right'));
    // A 的下一格就是石头的格子：石头去 13，A 占据 12。若引擎「先校验落点再推」写反，
    // 会得到「石头不动、A 也不动」或者「A 与石头叠在同一格」。
    expect(outcome.state.a).toBe(12);
    expect(outcome.state.blocks).toEqual([13]);
    expect(outcome.events.pushes).toEqual([{ block: 0, from: 12, to: 13 }]);
    expect(outcome.state.moves).toBe(1);
  });

  const chain = makeLevel([
    '##########',
    '#Abb...B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('连锁两格：被推的石头撞到另一块，把那块也推走', () => {
    const start = initialState(chain);
    const outcome = accepted(resolveMove(chain, start, 'right'));
    expect(outcome.state.blocks).toEqual([13, 14]);
    expect(outcome.events.pushes).toEqual([
      { block: 0, from: 12, to: 13 },
      { block: 1, from: 13, to: 14 },
    ]);
    // 事件按石块 id 排序 —— 渲染层靠这个顺序逐块播动画，顺序颠了会看起来像两块石头对撞。
    expect(outcome.events.pushes.map((push) => push.block)).toEqual([0, 1]);
  });

  const wall = makeLevel([
    '##########',
    '#.Ab#..B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('石头背后是墙 → 整步不成立，且原因归给「发起推动」的那一侧，不是被推的石头', () => {
    const start = initialState(wall);
    // A 推，石头撞墙：blocked.a = wall、blocked.b = null（B 那一侧本来是通的）。
    // 防的是「把推箱失败记成 self/另一侧」——那样 HUD 会指着影子说「你被挡住了」，
    // 而玩家明明是按本体那边走不动。
    expect(blockedOf(resolveMove(wall, start, 'right'))).toEqual({ a: 'wall', b: null });
    expect(blockedText({ a: 'wall', b: null })).toBe('本体被墙挡住了');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 同纹石块
// ─────────────────────────────────────────────────────────────────────────────

describe('M3 同纹石块：整组同向移动，组里任何一块推不动就整步作废', () => {
  const group = makeLevel([
    '#########',
    '#A.....B#',
    '#1...1..#',
    '#.......#',
    '#o.....o#',
    '#########',
  ]);

  it('推一块 → 整组同向移动（另一块没被碰也要走）', () => {
    const start = initialState(group);
    expect(levelGroupIds(group)).toEqual([1]);
    const outcome = accepted(resolveMove(group, start, 'down'));
    // 两块同纹石头一起下移一格。防的是「只推被碰的那一块」——那样同纹就退化成普通石头，
    // 关卡里所有「两块一起挡路」的设计全部失效，而画面上又完全看不出错误。
    expect(outcome.state.blocks).toEqual([28, 32]);
    expect(outcome.events.pushes).toEqual([
      { block: 0, from: 19, to: 28 },
      { block: 1, from: 23, to: 32 },
    ]);
  });

  const pinned = makeLevel([
    '#########',
    '#A.....B#',
    '#1...1..#',
    '#....#..#',
    '#o.....o#',
    '#########',
  ]);

  it('组里有一块推不动 → 整步不成立（哪怕另一块的落点空着）', () => {
    const start = initialState(pinned);
    // 第二块下方是墙。若引擎逐块判定，第一块会先动、第二块卡住 —— 同纹组的相对形状
    // 就被永久破坏（而玩家只看到「一步走了半截」）。
    expect(blockedOf(resolveMove(pinned, start, 'down'))).toEqual({ a: 'wall', b: null });
  });

  const trainH = makeLevel([
    '##########',
    '#A11...B.#',
    '#o.....o.#',
    '##########',
  ]);

  const trainV = makeLevel([
    '#########',
    '#A.....B#',
    '#1......#',
    '#1......#',
    '#.......#',
    '#o.....o#',
    '#########',
  ]);

  it('两块并排同向 → 允许被推成「一列车」（落点是组员刚腾出的格子）', () => {
    // 水平：两块同纹石头紧挨着，一起往右。前一块的落点是后一块的旧格子。
    const h = accepted(resolveMove(trainH, initialState(trainH), 'right'));
    expect(h.state.blocks).toEqual([13, 14]);

    // 垂直：同上，方向换成往下，防的是「只在某个方向上恰好成立」的坐标写死。
    const v = accepted(resolveMove(trainV, initialState(trainV), 'down'));
    expect(v.state.blocks).toEqual([28, 37]);
  });
});

/** 关卡里所有同纹组号（升序）——供上面的用例断言「这关确实有同纹组」。 */
function levelGroupIds(level: CompiledLevel): number[] {
  return [...level.groupIds];
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 冰面滑行
// ─────────────────────────────────────────────────────────────────────────────

describe('M4 冰面：滑到墙 / 石头 / 非冰面才停，整段只算 1 步', () => {
  const toFloor = makeLevel([
    '##########',
    '#A~~...B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('滑到非冰面停下，整段滑行只算 1 步（moves +1，不是按格计步）', () => {
    const start = initialState(toFloor);
    const outcome = accepted(resolveMove(toFloor, start, 'right'));
    // A 从 11 走到 14（先迈进冰面 12，再滑 2 格），步数仍然只有 1。
    // 防的是「按滑行格数累加 moves」：那样第一关的 par 会变成 4，三星永远拿不到。
    expect(outcome.state.a).toBe(14);
    expect(outcome.state.moves).toBe(1);
    expect(outcome.events.selves.a.slide).toBe(2);
    // 拖尾按顺序包含起点与每一格，渲染层靠它画余像。
    expect(outcome.events.trail.a).toEqual([11, 12, 13, 14]);
    // 影子那一侧没踩到冰，只走一格。
    expect(outcome.events.selves.b.slide).toBe(0);
    expect(outcome.state.b).toBe(18);
  });

  const toWall = makeLevel([
    '##########',
    '#A~~~#B..#',
    '#o.....o.#',
    '##########',
  ]);

  it('滑到墙前停（停在最后一格冰上，不越界、不穿墙）', () => {
    const outcome = accepted(resolveMove(toWall, initialState(toWall), 'right'));
    expect(outcome.state.a).toBe(14);
    expect(outcome.events.selves.a.slide).toBe(2);
  });

  const toBlock = makeLevel([
    '##########',
    '#A~~b..B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('滑到石头前停：石头不会被推、也不会跟着滑', () => {
    const outcome = accepted(resolveMove(toBlock, initialState(toBlock), 'right'));
    // A 停在 13（石头 14 的前一格），石头原地不动。
    // 防的是「滑行时把石头当可推对象」：那会让冰面变成「一路推土机」，
    // 而规则里冰面只制造身体之间的距离差。
    expect(outcome.state.a).toBe(13);
    expect(outcome.state.blocks).toEqual([14]);
    expect(outcome.events.pushes).toEqual([]);
  });

  const pushOntoIce = makeLevel([
    '##########',
    '#Ab~~..B.#',
    '#o.....o.#',
    '##########',
  ]);

  it('石头自己不会滑：被推上冰面后也只挪一格', () => {
    const outcome = accepted(resolveMove(pushOntoIce, initialState(pushOntoIce), 'right'));
    // 石头从 12 被推到 13（冰面），若它像身体那样继续滑会一路到 14、15。
    expect(outcome.state.blocks).toEqual([13]);
    expect(outcome.events.pushes).toEqual([{ block: 0, from: 12, to: 13 }]);
  });

  // 两侧都踩到冰、但冰道长度不同：一次操作可以滑出两个不同距离。
  // a4「先滑一段」的教学点正是这个 —— 写成「两边滑同样的格数」会让那一关无解，
  // 而且因为不报错，只会表现成「怎么走都差一格」。
  const uneven = makeLevel([
    '##########',
    '#A~~~#B~.#',
    '#o.....o.#',
    '##########',
  ]);

  it('两侧同时滑行时各滑各的：滑行距离不必相同', () => {
    const outcome = accepted(resolveMove(uneven, initialState(uneven), 'right'));
    // 本体：x1 → x2（冰）→ 滑到 x4 停（x5 是墙），滑 2 格。
    expect(outcome.state.a).toBe(14);
    expect(outcome.events.selves.a.slide).toBe(2);
    // 影子：x6 原地（地面）→ x7（冰）→ 滑到 x8（非冰面）停，滑 1 格。
    expect(outcome.state.b).toBe(18);
    expect(outcome.events.selves.b.slide).toBe(1);
    // 整步仍然只算 1 步。
    expect(outcome.state.moves).toBe(1);
    expect(outcome.state.a).not.toBe(outcome.state.b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 纯函数
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveMove 是纯函数：不修改传入的 state', () => {
  const level = makeLevel([
    '#########',
    '#A.....B#',
    '#1...1..#',
    '#.......#',
    '#o.....o#',
    '#########',
  ]);

  it('走成一步后，传入的 state 与调用前深比较相等', () => {
    const state = initialState(level);
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
    accepted(resolveMove(level, state, 'down'));
    // 撤销栈与 BFS 都依赖「引擎只产出新状态」。原地改会让撤销跳步、solver 的 parent
    // 链全部指向同一个被反复改写的对象 —— 症状是提示给错方向，且不抛任何异常。
    expect(state).toEqual(snapshot);
  });

  it('被挡住时同样不改动 state（连 moves 都不动）', () => {
    const levelBlocked = makeLevel([
      '#########',
      '#A.....B#',
      '#1...1..#',
      '#....#..#',
      '#o.....o#',
      '#########',
    ]);
    const state = initialState(levelBlocked);
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
    expect(blockedOf(resolveMove(levelBlocked, state, 'down'))).not.toBeNull();
    expect(state).toEqual(snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 通关判定
// ─────────────────────────────────────────────────────────────────────────────

describe('通关：两侧各站一盏灯才算', () => {
  const both = makeLevel([
    '#########',
    '#o.....o#',
    '#A.....B#',
    '#########',
  ]);

  it('两侧同时踩上灯 → solved', () => {
    const outcome = accepted(resolveMove(both, initialState(both), 'up'));
    expect(outcome.solved).toBe(true);
    expect(isSolved(both, outcome.state)).toBe(true);
  });

  const oneSide = makeLevel([
    '#########',
    '#o....o.#',
    '#A...B..#',
    '#########',
  ]);

  it('只有一侧站上灯 → 不算通关（另一个身体必须也在灯上）', () => {
    // 往上：本体落在灯上，影子落在普通地板。防的是 `goals.has(a) || goals.has(b)`
    // 那种把「踩到一盏就算」写成的静默放行 —— 整个游戏的难度会当场消失。
    const outcome = accepted(resolveMove(oneSide, initialState(oneSide), 'up'));
    expect(oneSide.goals.has(outcome.state.a)).toBe(true);
    expect(oneSide.goals.has(outcome.state.b)).toBe(false);
    expect(outcome.solved).toBe(false);
    expect(isSolved(oneSide, outcome.state)).toBe(false);
  });

  it('isSolved 直接按两盏灯判，且不依赖 moves', () => {
    const [goalA, goalB] = [...both.goals];
    const start = initialState(both);
    expect(isSolved(both, { ...start, a: goalA, b: goalB, moves: 0 })).toBe(true);
    expect(isSolved(both, { ...start, a: goalA, b: goalB, moves: 77 })).toBe(true);
    // 一侧在灯上、另一侧不在 → 不算。
    expect(isSolved(both, { ...start, a: goalA, b: start.b })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ stateKey（solver 的状态去重）
// ─────────────────────────────────────────────────────────────────────────────

describe('stateKey：等价局面必须得到同一个键', () => {
  // 一个同纹组（2 块）+ 两块普通石头。
  const level = makeLevel([
    '#########',
    '#A1.b1cB#',
    '#o.....o#',
    '#########',
  ]);

  const base: GameState = { a: 10, b: 16, blocks: [11, 13, 14, 15], moves: 0 };

  it('两个身体互换是同一个局面（规则对两侧完全对称）', () => {
    // 防的是键里写成 `${a},${b}` 而不排序：BFS 会把每个局面再展开一遍，
    // 内存翻倍、visited 虚高，最坏情况直接撞上 maxNodes 变成「无解」。
    expect(stateKey(level, { ...base, a: base.b, b: base.a })).toBe(stateKey(level, base));
  });

  it('同纹组内互换、普通石块之间互换都是同一个局面', () => {
    // blocks 下标与 level.blocks 对齐：0 / 2 是同一组（『1』），1 / 3 是普通石头（b / c）。
    const swapped: GameState = {
      ...base,
      blocks: [14, 15, 11, 13],
    };
    expect(stateKey(level, swapped)).toBe(stateKey(level, base));
  });

  it('不同局面得到不同的键（防止「恒定键」让 BFS 一开始就以为走过了）', () => {
    const key = stateKey(level, base);
    expect(stateKey(level, { ...base, a: base.a + 1 })).not.toBe(key);
    expect(stateKey(level, { ...base, blocks: [11, 13, 14, 16] })).not.toBe(key);
    // 同组那一块真挪了格子也不行 —— 那是一个不同的局面。
    expect(stateKey(level, { ...base, blocks: [12, 13, 14, 15] })).not.toBe(key);
  });

  it('moves 不进键：同一棋面不论走了几步都是同一局面（solver 按位置去重）', () => {
    expect(stateKey(level, { ...base, moves: 42 })).toBe(stateKey(level, base));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ compileLevel 拒错
//
// 关卡是手写的，而手写错误里最坏的一类不是「抛异常」，是**形状合法但玩法变了**：
// 少一盏灯会让 a||b 那种写法静默通关、单块同纹组会让作者以为写了两块、
// par 写错会让三星永远拿不到。所以每一条都必须在编译期炸掉。
// ─────────────────────────────────────────────────────────────────────────────

describe('compileLevel：形状错误当场炸，并带上关卡 id', () => {
  it('行宽不一致', () => {
    expect(() => makeLevel(['####', '#A.B#', '#o.o#', '####'])).toThrow(/第 2 行宽度是 5，应为 4/);
  });

  it('缺本体出生点 A', () => {
    expect(() => makeLevel(['#####', '#..B#', '#o.o#', '#####'])).toThrow(/缺少本体出生点 A/);
  });

  it('缺影子出生点 B', () => {
    expect(() => makeLevel(['#####', '#A..#', '#o.o#', '#####'])).toThrow(/缺少影子出生点 B/);
  });

  it('灯少于两盏', () => {
    expect(() => makeLevel(['#####', '#A.B#', '#o..#', '#####'])).toThrow(/灯只有 1 盏，至少要两盏/);
  });

  it('par 不是正整数', () => {
    for (const par of [0, -3, 1.5, Number.NaN]) {
      expect(() => makeLevel(['#####', '#A.B#', '#o.o#', '#####'], { par })).toThrow(/par 必须是正整数/);
    }
  });

  it('只有一块的同纹组（几乎总是漏写第二块）', () => {
    expect(() => makeLevel(['#####', '#A1B#', '#o.o#', '#####'])).toThrow(/花纹 1 只有一块石头/);
  });

  it('不认识的字符', () => {
    // 报错里要带坐标：作者在 30 张图里靠 (2,1) 才找得到那个字符。
    expect(() => makeLevel(['#####', '#A?B#', '#o.o#', '#####'])).toThrow(/坐标 \(2,1\) 是不认识的字符/);
  });

  it('rows 为空', () => {
    expect(() => makeLevel([])).toThrow(/rows 为空/);
  });

  it('正常关卡能编译，两盏灯 / 出生点 / 同纹组都进了编译结果', () => {
    const compiled = makeLevel([
      '#########',
      '#o.....o#',
      '#A1.b1.B#',
      '#########',
    ]);
    expect(compiled.width).toBe(9);
    expect(compiled.height).toBe(4);
    expect(compiled.goals.size).toBe(2);
    expect(compiled.start).toEqual({ a: xyCell(compiled, 1, 2), b: xyCell(compiled, 7, 2) });
    expect(compiled.groupIds).toEqual([1]);
    // 两块「1」在扫描顺序里是第 0、2 块（中间夹着一块普通石头 b）。
    expect(compiled.groups.get(1)).toEqual([0, 2]);
    expect(compiled.blocks.map((block) => block.group)).toEqual([1, null, 1]);
  });
});

// 让 tsc 知道 Dir 在这里用过（关卡路径类型与 resolveMove 参数同源，防止有人把方向词表改散）。
const DIRECTIONS: readonly Dir[] = ['up', 'down', 'left', 'right'];
describe('方向词表', () => {
  it('四个方向都能被引擎接受（没有第五个、也没有拼错的）', () => {
    const level = makeLevel([
      '#######',
      '#A...B#',
      '#o...o#',
      '#######',
    ]);
    const start = initialState(level);
    for (const dir of DIRECTIONS) {
      // 只要求「返回一个结果而不是抛异常」；成不成立由上面各条用例负责。
      expect(() => resolveMove(level, start, dir)).not.toThrow();
    }
  });
});
