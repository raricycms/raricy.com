#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// scripts/twinshade-levels.ts — 关卡对账器（作者工具，不参与运行时）
//
// 一张关卡「能不能玩」有三件事要验，缺一条都会做出坏关卡：
//   1. **形状**：编译不抛（行宽、A/B、灯数、par 合法性）；
//   2. **可解且 par 诚实**：par 必须等于 solver 算出来的最优步数；
//   3. **石头是不是工具**：把所有石头换成地板再求一次最短解 ——
//      · 无石头更短  ⇒ 石头只是减速带（玩家绕开它就行，机制没被用上）
//      · 无石头同样长 ⇒ 石头纯属摆设
//      · 无石头无解 / 无石头更长 ⇒ 石头是解法的一部分（刹车、挡路、远程同纹）
//      玩家反馈过「把石头删掉解法完全一样」，所以这条现在是硬指标，落在表里第 11 列。
//
// 另外几列是难度读数（作者用来判断这关是不是「走两步就完事」）：
//   · 局面：可达状态数，太少说明空间太扁；
//   · 陷阱：可达状态里通不了关的比例，越高越需要提前想；
//   · 首步：能保持最优的第一步有几个方向，1 = 第一步就被逼死；
//   · 解：最优解条数，1~2 条说明解法是被逼出来的。
//
// 用法：
//   npx tsx scripts/twinshade-levels.ts                 对账全部关卡（有错时 exit 1）
//   npx tsx scripts/twinshade-levels.ts --path a3       打印最优走法
//   npx tsx scripts/twinshade-levels.ts --only a3       只检查一关
//   npx tsx scripts/twinshade-levels.ts --sim urdl a3   模拟一串方向并打印两身体终点
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeLevel } from '../src/games/twinshade/solver';
import { compileLevel, initialState, resolveMove, stateKey, isSolved } from '../src/games/twinshade/engine';
import { LEVELS } from '../src/games/twinshade/levels';
import { DIRS, type CompiledLevel, type Dir, type GameState } from '../src/games/twinshade/types';

const ARROW: Record<Dir, string> = { up: '↑', down: '↓', left: '←', right: '→' };

function fmtPath(path: readonly Dir[]): string {
  return path.map((dir) => ARROW[dir]).join(' ');
}

/** 把最优走法重放一遍，数出「推了几次石头 / 滑了几格」。 */
function replay(level: CompiledLevel, path: readonly Dir[]): { pushes: number; slides: number } {
  let state: GameState = initialState(level);
  let pushes = 0;
  let slides = 0;
  for (const dir of path) {
    const outcome = resolveMove(level, state, dir);
    if (!outcome.ok) break;
    pushes += outcome.events.pushes.length;
    slides += outcome.events.selves.a.slide + outcome.events.selves.b.slide;
    state = outcome.state;
  }
  return { pushes, slides };
}

/** 两盏灯里是否存在一对，其相对位置等于两侧出生点的相对位置。 */
function offsetCandidate(level: CompiledLevel): string | null {
  const w = level.width;
  const ax = level.start.a % w;
  const ay = Math.floor(level.start.a / w);
  const bx = level.start.b % w;
  const by = Math.floor(level.start.b / w);
  const goals = [...level.goals];
  for (let i = 0; i < goals.length; i++) {
    for (let j = i + 1; j < goals.length; j++) {
      const g1x = goals[i] % w;
      const g1y = Math.floor(goals[i] / w);
      const g2x = goals[j] % w;
      const g2y = Math.floor(goals[j] / w);
      if (g2x - g1x === bx - ax && g2y - g1y === by - ay) return `灯 (${g1x},${g1y}) 与 (${g2x},${g2y}) 的偏移与出生点一致`;
      if (g1x - g2x === bx - ax && g1y - g2y === by - ay) return `灯 (${g2x},${g2y}) 与 (${g1x},${g1y}) 的偏移与出生点一致`;
    }
  }
  return null;
}

// ── 石头必要性：删掉所有石头再求最短解 ──────────────────────────────────────
// 注意字符集：`o`（灯）不能被当成石头删掉，所以用 [a-np-z1-9]（跳过 o）。
function parWithoutStones(rows: readonly string[]): number | null {
  const stripped = rows.map((row) => row.replace(/[a-np-z1-9]/g, '.'));
  let level: CompiledLevel;
  try {
    level = compileLevel({ id: 'x', act: 1, name: 'x', rows: stripped, par: 1, hint: '' });
  } catch {
    return null;
  }
  const start = initialState(level);
  if (isSolved(level, start)) return 0;
  const seen = new Set<string>([stateKey(level, start)]);
  let frontier: GameState[] = [start];
  for (let step = 1; step <= 120; step++) {
    const next: GameState[] = [];
    for (const state of frontier) {
      for (const dir of DIRS) {
        const outcome = resolveMove(level, state, dir);
        if (!outcome.ok) continue;
        if (outcome.solved) return step;
        const key = stateKey(level, outcome.state);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(outcome.state);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
    if (seen.size > 120_000) return null;
  }
  return null;
}

/** 全量状态图读数：可达数 / 陷阱比例 / 首步逼仄度 / 最优解条数。 */
interface Difficulty {
  reachable: number;
  trapRatio: number;
  forced: number;
  solutions: number;
}

function difficulty(level: CompiledLevel, cap = 60_000): Difficulty | null {
  const start = initialState(level);
  const startKey = stateKey(level, start);
  const states = new Map<string, GameState>([[startKey, start]]);
  const adj = new Map<string, string[]>([[startKey, []]]);
  const queue: GameState[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    const key = stateKey(level, state);
    const edges = adj.get(key) as string[];
    for (const dir of DIRS) {
      const outcome = resolveMove(level, state, dir);
      if (!outcome.ok) continue;
      const nextKey = stateKey(level, outcome.state);
      edges.push(nextKey);
      if (!states.has(nextKey)) {
        states.set(nextKey, outcome.state);
        adj.set(nextKey, []);
        queue.push(outcome.state);
      }
    }
    if (states.size > cap) return null;
  }
  const reverse = new Map<string, string[]>();
  for (const [from, edges] of adj) {
    for (const to of edges) {
      const list = reverse.get(to);
      if (list) list.push(from);
      else reverse.set(to, [from]);
    }
  }
  const dist = new Map<string, number>();
  const frontier: string[] = [];
  for (const [key, state] of states) {
    if (isSolved(level, state)) {
      dist.set(key, 0);
      frontier.push(key);
    }
  }
  for (let head = 0; head < frontier.length; head++) {
    const key = frontier[head];
    const d = dist.get(key) as number;
    for (const prev of reverse.get(key) ?? []) {
      if (dist.has(prev)) continue;
      dist.set(prev, d + 1);
      frontier.push(prev);
    }
  }
  const par = dist.get(startKey);
  if (par === undefined) return null;
  let forced = 0;
  for (const dir of DIRS) {
    const outcome = resolveMove(level, start, dir);
    if (!outcome.ok) continue;
    if (dist.get(stateKey(level, outcome.state)) === par - 1) forced++;
  }
  let solutions = 0;
  const walk = (key: string, left: number) => {
    if (solutions >= 40) return;
    if (left === 0) {
      solutions++;
      return;
    }
    for (const next of adj.get(key) ?? []) if (dist.get(next) === left - 1) walk(next, left - 1);
  };
  walk(startKey, par);
  return {
    reachable: states.size,
    trapRatio: states.size ? 1 - frontier.length / states.size : 0,
    forced,
    solutions,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const pathIndex = args.indexOf('--path');
const onlyIndex = args.indexOf('--only');
const simIndex = args.indexOf('--sim');
const pathId = pathIndex >= 0 ? args[pathIndex + 1] : null;
const onlyId = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const simSpec = simIndex >= 0 ? args[simIndex + 1] : null;
const simId = simIndex >= 0 ? args[simIndex + 2] : null;

/**
 * `--sim <方向串> <关卡 id>`：把手写的一串方向（u/d/l/r 或 ↑↓←→，可带逗号空格）
 * 在这一关上走一遍，打印每一格最终位置。设计冰面关卡的**唯一**顺手办法：
 * 滑行让「走几步之后两个身体在哪」很难心算，而灯必须摆在那一对位置上。
 */
const SIM_KEYS: Record<string, Dir> = {
  u: 'up', d: 'down', l: 'left', r: 'right',
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right',
};

if (simSpec && simId) {
  const def = LEVELS.find((entry) => entry.id === simId);
  if (!def) {
    console.error(`没有关卡 ${simId}`);
    process.exit(1);
  }
  const level = compileLevel(def);
  let state = initialState(level);
  const steps = simSpec.replace(/[\s,]/g, '');
  const trace: string[] = [];
  for (const raw of steps) {
    const dir = SIM_KEYS[raw];
    if (!dir) {
      console.error(`不认识的方向：${raw}`);
      process.exit(1);
    }
    const outcome = resolveMove(level, state, dir);
    if (!outcome.ok) {
      console.error(`第 ${trace.length + 1} 步（${ARROW[dir]}）走不通：${JSON.stringify(outcome.blocked)}`);
      console.log(trace.join(' '));
      process.exit(1);
    }
    state = outcome.state;
    const pos = (cell: number) => `(${cell % level.width},${Math.floor(cell / level.width)})`;
    trace.push(`${ARROW[dir]}→ A${pos(state.a)} B${pos(state.b)}`);
  }
  const pos = (cell: number) => `${cell % level.width},${Math.floor(cell / level.width)}`;
  console.log(trace.join('\n'));
  console.log(`\n最终：A=(${pos(state.a)}) B=(${pos(state.b)})，共 ${state.moves} 步`);
  console.log('把这两格填成 o 即可（顺序无关）。');
  process.exit(0);
}

const rows: string[] = [];
rows.push(['id', '关名', '尺寸', '石', 'par', '推', '滑', '局面', '陷阱', '首步', '解', '无石par', '结论'].join('\t'));
let failures = 0;

for (const def of LEVELS) {
  if (onlyId && def.id !== onlyId) continue;
  let level: CompiledLevel;
  try {
    level = compileLevel(def);
  } catch (error) {
    failures++;
    rows.push([def.id, def.name, '-', '-', String(def.par), '-', '-', '-', '-', '-', '-', '-', `编译失败：${(error as Error).message}`].join('\t'));
    continue;
  }

  const result = analyzeLevel(level);
  const usage = result.moves ? replay(level, result.moves) : { pushes: 0, slides: 0 };
  const diff = difficulty(level);
  const without = parWithoutStones(def.rows);
  const size = `${level.width}×${level.height}`;

  let verdict = '✓';
  if (result.truncated) verdict = '搜索撞上限';
  else if (!result.solved) {
    verdict = '无解';
    const hint = offsetCandidate(level);
    verdict += hint ? `（几何上可行：${hint}，检查路线是否被堵死）` : '（两盏灯的相对位置与出生点不一致）';
  } else if (result.optimal !== def.par) verdict = `par 不符：最优是 ${result.optimal}`;
  if (verdict !== '✓') failures++;

  rows.push([
    def.id,
    def.name,
    size,
    String(level.blocks.length),
    String(def.par),
    String(usage.pushes),
    String(usage.slides),
    diff ? String(diff.reachable) : '-',
    diff ? `${(diff.trapRatio * 100).toFixed(0)}%` : '-',
    diff ? String(diff.forced) : '-',
    diff ? String(diff.solutions) : '-',
    without === null ? '无解' : String(without),
    verdict,
  ].join('\t'));

  if (pathId === def.id && result.moves) {
    rows.push('', `走法（${result.moves.length} 步）：${fmtPath(result.moves)}`, '');
  }
}

console.log(rows.join('\n'));
if (failures > 0) {
  console.error(`\n${failures} 关没通过。par 必须等于 solver 的最优步数。`);
  process.exit(1);
}
console.log(`\n全部 ${LEVELS.length} 关通过（par = 最优步数）。`);
