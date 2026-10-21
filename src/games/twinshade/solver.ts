// ─────────────────────────────────────────────────────────────────────────────
// solver.ts — 在状态空间上做 BFS：算最优步数（= 三星线）、给下一步提示、给关卡做体检
//
// 这个文件存在的理由不是「加个 AI」，而是三件很具体的事：
//   1. **par 不是拍的**。关卡的 par 若是作者估的，三星线就可能永远拿不到（估高了）
//      或者形同虚设（估低了）。这里算出来的就是真正的最短步数。
//   2. **提示能保证不卡死**。「提示」按钮不是给作者写的一句话，而是从**当前局面**
//      重新 BFS 出来的下一步 —— 哪怕玩家已经走歪了，提示依然指向通关的最短路。
//   3. **关卡体检**。写错一张关卡（少一盏灯、石头堵死、根本无解）在人工试玩里
//      很容易漏，在这里是一条断言。
//
// 因为规则完全确定、状态空间有限，BFS 出来的就是**最优解**（不是启发式）。
// 代价是内存：所以有节点上限，超了返回 truncated，调用方自己决定怎么说。
// ─────────────────────────────────────────────────────────────────────────────

import { ENGINE_DIRS, initialState, isSolved, resolveMove, stateKey } from './engine';
import type { CompiledLevel, Dir, GameState } from './types';

export interface SolveResult {
  /** 能不能通。 */
  readonly solved: boolean;
  /** 最优走法（从传入的局面起算）；无解时为 null。 */
  readonly moves: readonly Dir[] | null;
  /** 最优步数；无解时为 null。 */
  readonly optimal: number | null;
  /** 搜过的局面数（关卡体检时用来看难度）。 */
  readonly visited: number;
  /** 是否撞上了节点上限（此时 solved:false 不代表无解）。 */
  readonly truncated: boolean;
}

export interface SolveOptions {
  /** 最多展开多少局面。默认 20 万 —— 30 张手写小图远够，撞上说明关卡设计出了问题。 */
  readonly maxNodes?: number;
  /** 最多走多少步（防止 BFS 在「能无限绕圈」的图里被拖住）。 */
  readonly maxMoves?: number;
}

const DEFAULT_MAX_NODES = 200_000;
const DEFAULT_MAX_MOVES = 90;

/** 从给定局面求最短路。 */
export function solve(level: CompiledLevel, start: GameState = initialState(level), options: SolveOptions = {}): SolveResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxMoves = options.maxMoves ?? DEFAULT_MAX_MOVES;

  const startKey = stateKey(level, start);
  if (isSolved(level, start)) return { solved: true, moves: [], optimal: 0, visited: 0, truncated: false };

  interface Node {
    readonly state: GameState;
    readonly key: string;
  }

  const queue: Node[] = [{ state: start, key: startKey }];
  /** 键 → 从哪个键、走了哪个方向过来。起点为 null。 */
  const parent = new Map<string, { prev: string; dir: Dir } | null>([[startKey, null]]);
  let head = 0;
  let visited = 0;

  const rebuild = (key: string): Dir[] => {
    const path: Dir[] = [];
    let cursor = key;
    for (;;) {
      const edge = parent.get(cursor);
      if (!edge) break;
      path.push(edge.dir);
      cursor = edge.prev;
    }
    return path.reverse();
  };

  while (head < queue.length) {
    const node = queue[head++];
    visited++;
    if (visited > maxNodes) {
      return { solved: false, moves: null, optimal: null, visited, truncated: true };
    }

    for (const dir of ENGINE_DIRS) {
      const outcome = resolveMove(level, node.state, dir);
      if (!outcome.ok) continue;
      const key = stateKey(level, outcome.state);
      if (parent.has(key)) continue;
      parent.set(key, { prev: node.key, dir });
      if (outcome.solved) {
        const path = rebuild(key);
        return { solved: true, moves: path, optimal: path.length, visited, truncated: false };
      }
      if (outcome.state.moves >= maxMoves) continue;
      queue.push({ state: outcome.state, key });
    }
  }

  return { solved: false, moves: null, optimal: null, visited, truncated: false };
}

/**
 * 从当前局面出发的「下一步该往哪走」。没有解（或撞上限）时返回 null ——
 * 调用方宁可说「这一步没算出来」，也别给一个错的方向。
 */
export function nextBestMove(level: CompiledLevel, state: GameState, options: SolveOptions = {}): Dir | null {
  const result = solve(level, state, options);
  return result.moves && result.moves.length > 0 ? result.moves[0] : null;
}

/** 关卡体检用：从初始局面能不能通、最优几步。 */
export function analyzeLevel(level: CompiledLevel, options: SolveOptions = {}): SolveResult {
  return solve(level, initialState(level), options);
}
