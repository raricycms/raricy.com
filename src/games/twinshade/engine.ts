// ─────────────────────────────────────────────────────────────────────────────
// engine.ts — 双影的规则内核：纯函数、零依赖、不碰 DOM
//
// 关卡与状态都是不可变数据：`resolveMove()` 读旧状态、算出**新**状态，从不原地改。
// 好处有三条，每条都在别处被消费：
//   1. 撤销 = 把上一份状态放进栈里（不需要「反向操作」，也就不可能反推错）；
//   2. solver（solver.ts）可以直接拿 BFS 在状态空间上跑，最优步数就是关卡星级的分母；
//   3. 单测可以对着「某个具体状态」断言，而不是先跑一串操作再猜自己在哪。
//
// ── 一步的判定顺序（这个顺序本身就是规则，改它 = 改游戏）──────────────────────
// ① 两侧各自的下一格：越界 / 墙 ⇒ 这一侧不成立。
// ② 下一格若有石头，把石头加入「要动的集合」；同纹组（数字花纹）整组一起加入。
//    整组传递：被推的石头撞到另一块石头，那块也被推（Sokoban 的连锁推）。
//    落点校验：越界 / 墙 / 落在一个不动的石头上 ⇒ 不成立；落在「这一轮也会动」的
//    石头上**允许** —— 整组像一列车同时移动，否则「两块并排的同纹石头」永远推不动。
// ③ 两个身体同时进入各自的下一格；它们不会互相挡路：两者的相对位置在一整局里
//    恒定（同方向同位移），唯一例外是冰面让一边滑得更远。
// ④ 冰面滑行：站在冰面上的身体沿同方向继续滑，直到撞墙 / 撞石头 / 撞另一个身体。
//    **石头自己不会滑** —— 于是冰面只制造「距离差」，而不制造「石头漂移」的连锁。
//    整段滑行只算一步。
// ⑤ 两个身体各自站在一盏灯上 ⇒ 通关。
//
// 失败时返回 `blocked`，指出**哪一侧**、被**什么**挡住。那不只是给玩家看的文案：
// 教学的第一个坎就是「为什么这一步没动」，引擎必须能说清原因。
// ─────────────────────────────────────────────────────────────────────────────

import {
  DIRS,
  DIR_DELTA,
  TERRAIN,
  type BlockReason,
  type BlockSpec,
  type CompiledLevel,
  type Dir,
  type GameState,
  type LevelDef,
  type MoveOutcome,
  type Terrain,
} from './types';

/** 供货给关卡文件的错误信息。写清楚是哪个 id，否则作者要在 30 张图里猜。 */
class LevelError extends Error {
  constructor(id: string, detail: string) {
    super(`关卡 ${id}：${detail}`);
    this.name = 'LevelError';
  }
}

/** 该格沿 dir 走一格；越界返回 null。 */
function stepCell(level: CompiledLevel, cell: number, dir: Dir): number | null {
  const { dx, dy } = DIR_DELTA[dir];
  const x = (cell % level.width) + dx;
  const y = Math.floor(cell / level.width) + dy;
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return null;
  return y * level.width + x;
}

/** 渲染层与调试器共用的「下标 → 坐标」。 */
export function cellXY(level: Pick<CompiledLevel, 'width'>, cell: number): { x: number; y: number } {
  return { x: cell % level.width, y: Math.floor(cell / level.width) };
}

/** 「坐标 → 下标」。越界返回 -1（调用方自己决定是报错还是忽略）。 */
export function xyCell(level: Pick<CompiledLevel, 'width' | 'height'>, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return -1;
  return y * level.width + x;
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译：ASCII → CompiledLevel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把关卡 ASCII 编译成引擎用的形状。**所有形状错误都在这里抛**，而不是等到玩家
 * 走到那一步才发现：关卡文件是手写的，手写就会写错，而写错的代价应当是
 * `tests/unit/twinshade-levels.test.ts` 当场红，而不是线上某关点进去白屏。
 */
export function compileLevel(def: LevelDef): CompiledLevel {
  const rows = def.rows;
  if (rows.length === 0) throw new LevelError(def.id, 'rows 为空');
  const width = rows[0].length;
  if (width === 0) throw new LevelError(def.id, '第一行为空');
  const height = rows.length;
  for (let y = 0; y < height; y++) {
    if (rows[y].length !== width) {
      throw new LevelError(def.id, `第 ${y + 1} 行宽度是 ${rows[y].length}，应为 ${width}`);
    }
  }

  const terrain: Terrain[] = new Array(width * height).fill(TERRAIN.floor);
  const goals = new Set<number>();
  const blocks: BlockSpec[] = [];
  const groupMembers = new Map<number, number[]>();
  let startA = -1;
  let startB = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const cell = y * width + x;
      if (ch === '#') terrain[cell] = TERRAIN.wall;
      else if (ch === '.') terrain[cell] = TERRAIN.floor;
      else if (ch === '~') terrain[cell] = TERRAIN.ice;
      else if (ch === 'o') goals.add(cell);
      else if (ch === 'A') {
        if (startA >= 0) throw new LevelError(def.id, '出现了两个 A');
        startA = cell;
      } else if (ch === 'B') {
        if (startB >= 0) throw new LevelError(def.id, '出现了两个 B');
        startB = cell;
      } else if (ch >= '1' && ch <= '9') {
        const group = ch.charCodeAt(0) - 48;
        const id = blocks.length;
        blocks.push({ id, cell, group });
        const members = groupMembers.get(group) ?? [];
        members.push(id);
        groupMembers.set(group, members);
      } else if (ch >= 'a' && ch <= 'z') {
        blocks.push({ id: blocks.length, cell, group: null });
      } else {
        throw new LevelError(def.id, `坐标 (${x},${y}) 是不认识的字符 ${JSON.stringify(ch)}`);
      }
    }
  }

  if (startA < 0) throw new LevelError(def.id, '缺少本体出生点 A');
  if (startB < 0) throw new LevelError(def.id, '缺少影子出生点 B');
  if (goals.size < 2) throw new LevelError(def.id, `灯只有 ${goals.size} 盏，至少要两盏`);
  if (!Number.isInteger(def.par) || def.par < 1) throw new LevelError(def.id, 'par 必须是正整数');

  // 只有一块的「同纹组」在规则上与普通石头完全一样，但会让作者以为自己写了两块。
  // 这种情况几乎总是漏写，直接在编译期拒掉。
  const groups = new Map<number, number[]>();
  const groupIds: number[] = [];
  for (const [group, members] of groupMembers) {
    if (members.length < 2) throw new LevelError(def.id, `花纹 ${group} 只有一块石头（同纹至少要两块）`);
    groups.set(group, members);
    groupIds.push(group);
  }
  groupIds.sort((p, q) => p - q);

  return {
    id: def.id,
    act: def.act,
    name: def.name,
    width,
    height,
    terrain,
    goals,
    start: { a: startA, b: startB },
    blocks,
    groups,
    groupIds,
    def,
  };
}

/** 一局的初始状态。 */
export function initialState(level: CompiledLevel): GameState {
  return {
    a: level.start.a,
    b: level.start.b,
    blocks: level.blocks.map((block) => block.cell),
    moves: 0,
  };
}

/** 两个身体是否各自站在一盏灯上。 */
export function isSolved(level: CompiledLevel, state: GameState): boolean {
  return level.goals.has(state.a) && level.goals.has(state.b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 走一步
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 尝试朝 dir 走一步。**不修改传入的状态**（哪怕返回 ok）。
 *
 * 失败时把两侧的 `BlockReason` 一起带回来：一侧为 null 表示「那一侧本来走得动」，
 * 于是 HUD 能说「影子被石头挡住了」而不是含糊的「走不动」。
 */
export function resolveMove(level: CompiledLevel, state: GameState, dir: Dir): MoveOutcome {
  const reason: [BlockReason | null, BlockReason | null] = [null, null];
  const selfPos = [state.a, state.b] as const;
  const next: [number | null, number | null] = [null, null];

  // ① 各自的下一格：越界 / 墙。
  for (let side = 0; side < 2; side++) {
    const target = stepCell(level, selfPos[side], dir);
    next[side] = target;
    if (target === null || level.terrain[target] === TERRAIN.wall) reason[side] = 'wall';
  }
  // 防御：两个身体被推到同一格（理论上不可能 —— 它们的相对位置恒定，
  // 只有冰面能改变它，而冰面滑行是同方向、不会对撞）。留着这行是为了
  // 哪天规则被改坏时能立刻炸在断言上，而不是产出一个两 token 重叠的怪状态。
  if (!reason[0] && !reason[1] && next[0] === next[1]) reason[0] = 'self';

  // ② 推箱集合
  const blockAt = new Map<number, number>();
  state.blocks.forEach((cell, index) => blockAt.set(cell, index));
  const moving = new Set<number>();
  /** 这块石头是被哪一侧「发起」推动的 —— 失败归因用，只影响文案。 */
  const origin = new Map<number, 0 | 1>();
  const queue: number[] = [];

  const addBlock = (index: number, by: 0 | 1) => {
    if (moving.has(index)) return;
    moving.add(index);
    origin.set(index, by);
    queue.push(index);
    const group = level.blocks[index].group;
    if (group === null) return;
    for (const member of level.groups.get(group) ?? []) {
      if (moving.has(member)) continue;
      moving.add(member);
      origin.set(member, by);
      queue.push(member);
    }
  };

  for (let side = 0; side < 2; side++) {
    if (reason[side]) continue;
    const occupant = blockAt.get(next[side] as number);
    if (occupant !== undefined) addBlock(occupant, side as 0 | 1);
  }

  const selfDest = new Set<number>();
  if (!reason[0]) selfDest.add(next[0] as number);
  if (!reason[1]) selfDest.add(next[1] as number);

  while (queue.length > 0) {
    const index = queue.pop() as number;
    const by = origin.get(index) ?? 0;
    const dest = stepCell(level, state.blocks[index], dir);
    if (dest === null || level.terrain[dest] === TERRAIN.wall) {
      if (reason[by] === null) reason[by] = 'wall';
      continue;
    }
    // 石头不能推进某个身体**这一轮要去的格子**（推进它当前站的格子是合法的：
    // 那个身体同时也要往前一步）。
    if (selfDest.has(dest)) {
      if (reason[by] === null) reason[by] = 'self';
      continue;
    }
    const occupant = blockAt.get(dest);
    if (occupant !== undefined && !moving.has(occupant)) addBlock(occupant, by);
  }

  if (reason[0] || reason[1]) {
    return { ok: false, blocked: { a: reason[0], b: reason[1] } };
  }

  // ③ 提交：先石头、后身体（石头不依赖身体的新位置，先算完更省事）。
  const blocks = state.blocks.slice();
  const pushes: { block: number; from: number; to: number }[] = [];
  for (const index of moving) {
    const from = state.blocks[index];
    const to = stepCell(level, from, dir) as number;
    blocks[index] = to;
    pushes.push({ block: index, from, to });
  }
  // 推箱顺序不影响结果，但事件顺序会影响渲染（同纹组多条拖尾），这里按石块 id 排好。
  pushes.sort((p, q) => p.block - q.block);

  let posA = next[0] as number;
  let posB = next[1] as number;
  const trailA: number[] = [state.a, posA];
  const trailB: number[] = [state.b, posB];

  // ④ 冰面滑行
  const occupied = new Set(blocks);
  let slideA = 0;
  let slideB = 0;
  const sliding: [boolean, boolean] = [
    level.terrain[posA] === TERRAIN.ice,
    level.terrain[posB] === TERRAIN.ice,
  ];
  while (sliding[0] || sliding[1]) {
    let movedAny = false;
    for (let side = 0; side < 2; side++) {
      if (!sliding[side]) continue;
      const from = side === 0 ? posA : posB;
      const target = stepCell(level, from, dir);
      const blockedByWall = target === null || level.terrain[target] === TERRAIN.wall;
      const blockedByBlock = target !== null && occupied.has(target);
      if (blockedByWall || blockedByBlock || target === (side === 0 ? posB : posA)) {
        sliding[side] = false;
        continue;
      }
      if (side === 0) {
        posA = target as number;
        slideA++;
        trailA.push(posA);
      } else {
        posB = target as number;
        slideB++;
        trailB.push(posB);
      }
      movedAny = true;
      if (level.terrain[target as number] !== TERRAIN.ice) sliding[side] = false;
    }
    if (!movedAny) break;
  }

  const nextState: GameState = { a: posA, b: posB, blocks, moves: state.moves + 1 };
  return {
    ok: true,
    state: nextState,
    events: {
      selves: {
        a: { from: state.a, to: posA, slide: slideA },
        b: { from: state.b, to: posB, slide: slideB },
      },
      trail: { a: trailA, b: trailB },
      pushes,
    },
    solved: isSolved(level, nextState),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态去重键（solver 用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把状态压成字符串键。**两种等价性必须在这里吃掉**，否则 solver 会被
 * 「同一局面用不同顺序走到」重复轰炸，BFS 内存直接翻几倍：
 *   · 两个身体可以互换 —— 规则对两侧完全对称（谁都没绑自己的灯），
 *     所以 `(a,b)` 与 `(b,a)` 是同一个局面；
 *   · 石头只按「同纹组」区分身份 —— 同组石头互换、普通石头互换都不改变后续走法。
 * 因此键里同组 / 无组的格子都要排序后再拼。
 */
export function stateKey(level: CompiledLevel, state: GameState): string {
  const lo = Math.min(state.a, state.b);
  const hi = Math.max(state.a, state.b);
  const parts: string[] = [`${lo},${hi}`];
  for (const group of level.groupIds) {
    const cells: number[] = [];
    for (const id of level.groups.get(group) ?? []) cells.push(state.blocks[id]);
    cells.sort((p, q) => p - q);
    parts.push(cells.join('.'));
  }
  const singles: number[] = [];
  for (let index = 0; index < level.blocks.length; index++) {
    if (level.blocks[index].group === null) singles.push(state.blocks[index]);
  }
  singles.sort((p, q) => p - q);
  parts.push(singles.join('.'));
  return parts.join('|');
}

/** 引擎可枚举的方向（顺序固定，solver 结果与提示因此可复现）。 */
export const ENGINE_DIRS = DIRS;
