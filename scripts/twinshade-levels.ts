#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// scripts/twinshade-levels.ts — 关卡对账器（作者工具，不参与运行时）
//
// 做三件事：
//   1. 编译每一关（形状错误在这里当场抛，带关卡 id）；
//   2. 用 solver 从初始局面 BFS 求最优步数，跟文件里写的 par 对账；
//   3. 无解时给出**最可能的原因**——九成是「两盏灯的相对位置和出生点不一致」，
//      因为不用冰面时两个身体永远保持相对位置（见 levels.ts 文件头）。
//
// 用法：
//   npx tsx scripts/twinshade-levels.ts              对账全部关卡（有错时 exit 1）
//   npx tsx scripts/twinshade-levels.ts --path a3    打印某一关的最优走法
//   npx tsx scripts/twinshade-levels.ts --only a3    只检查某一关
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeLevel } from '../src/games/twinshade/solver';
import { compileLevel, initialState, resolveMove } from '../src/games/twinshade/engine';
import { LEVELS } from '../src/games/twinshade/levels';
import type { CompiledLevel, Dir, GameState } from '../src/games/twinshade/types';

const ARROW: Record<Dir, string> = { up: '↑', down: '↓', left: '←', right: '→' };

function fmtPath(path: readonly Dir[]): string {
  return path.map((dir) => ARROW[dir]).join(' ');
}

/**
 * 把最优走法重放一遍，数出「推了几次石头 / 滑了几格」。
 * 这是给作者看的第二个数字：**一格都不推的关卡，说明关卡里的石头是摆设**
 * —— 要么设计意图没落实（石头本来该堵路），要么这一关其实可以删掉石头更干净。
 */
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
      if (g2x - g1x === bx - ax && g2y - g1y === by - ay) {
        return `灯 (${g1x},${g1y}) 与 (${g2x},${g2y}) 的偏移与出生点一致`;
      }
      if (g1x - g2x === bx - ax && g1y - g2y === by - ay) {
        return `灯 (${g2x},${g2y}) 与 (${g1x},${g1y}) 的偏移与出生点一致`;
      }
    }
  }
  return null;
}

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
 * 在这一关上走一遍，打印每一格最终位置。
 * 这是设计冰面关卡的**唯一**顺手的办法：滑行让「走几步之后两个身体在哪」很难
 * 心算，而灯必须摆在那一对位置上 —— 先模拟、再把灯填到打印出来的坐标上。
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

let failures = 0;
const rows: string[] = [];
rows.push(['id', '关名', '尺寸', '石', 'par', '最优', '推', '滑', '局面数', '结论'].join('\t'));

for (const def of LEVELS) {
  if (onlyId && def.id !== onlyId) continue;
  let level: CompiledLevel;
  try {
    level = compileLevel(def);
  } catch (error) {
    failures++;
    rows.push([def.id, def.name, '-', '-', String(def.par), '-', '-', '-', '-', `编译失败：${(error as Error).message}`].join('\t'));
    continue;
  }

  const result = analyzeLevel(level);
  const blocks = level.blocks.length;
  const size = `${level.width}×${level.height}`;
  const usage = result.moves ? replay(level, result.moves) : { pushes: 0, slides: 0 };
  let verdict: string;
  if (result.truncated) verdict = '搜索撞上限（关卡可能太大）';
  else if (!result.solved) {
    verdict = '无解';
    const hint = offsetCandidate(level);
    if (hint) verdict += `（几何上可行：${hint}，需要检查路线是否被堵死）`;
    else verdict += '（两盏灯的相对位置与出生点不一致，不用冰面时这关无解）';
  } else if (result.optimal !== def.par) verdict = `par 不符：最优是 ${result.optimal}`;
  else verdict = '✓';

  if (verdict !== '✓') failures++;
  rows.push([
    def.id,
    def.name,
    size,
    String(blocks),
    String(def.par),
    String(result.optimal ?? '-'),
    String(usage.pushes),
    String(usage.slides),
    String(result.visited),
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
