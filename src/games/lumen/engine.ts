/** Pure, bounded optics simulation. Every (cell, direction, color) is visited at
 * most once, so split beams and portal loops cannot keep the browser busy. */
export type Direction = 0 | 1 | 2 | 3; // north, east, south, west
export type Light = 1 | 2 | 3; // gold, blue, both
export type Optic = 'mirror' | 'splitter';
export interface Piece {
  x: number;
  y: number;
  kind: Optic | 'source' | 'receiver' | 'wall' | 'portal';
  rotation?: number;
  fixed?: boolean;
  color?: Light;
  direction?: Direction;
  pair?: string;
}
export interface Level {
  id: string;
  title: string;
  chapter: number;
  briefing: string;
  hint: string;
  size: number;
  pieces: Piece[];
  par: number;
}
export interface Segment { x1: number; y1: number; x2: number; y2: number; color: Light }
export interface Trace { segments: Segment[]; received: Record<number, number>; lit: number; total: number; solved: boolean }
const DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
export const isRotatable = (p: Piece) => (p.kind === 'mirror' || p.kind === 'splitter') && !p.fixed;
export const initialRotations = (level: Level) => level.pieces.map((p) => p.rotation ?? 0);
export const reflect = (direction: Direction, rotation: number): Direction =>
  (rotation % 2 === 0 ? [1, 0, 3, 2] : [3, 2, 1, 0])[direction] as Direction;

export function trace(level: Level, rotations: readonly number[]): Trace {
  const cells = new Map(level.pieces.map((p, i) => [`${p.x},${p.y}`, i]));
  const queue: { x: number; y: number; dir: Direction; color: Light }[] = [];
  level.pieces.forEach((p) => {
    if (p.kind === 'source') queue.push({ x: p.x, y: p.y, dir: p.direction!, color: p.color! });
  });
  const visited = new Set<string>();
  const segments: Segment[] = [];
  const received: Record<number, number> = {};
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const ray = queue[cursor];
    const key = `${ray.x},${ray.y},${ray.dir},${ray.color}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const [dx, dy] = DELTA[ray.dir];
    const x = ray.x + dx, y = ray.y + dy;
    if (x < 0 || y < 0 || x >= level.size || y >= level.size) {
      segments.push({ x1: ray.x, y1: ray.y, x2: ray.x + dx * .5, y2: ray.y + dy * .5, color: ray.color });
      continue;
    }
    segments.push({ x1: ray.x, y1: ray.y, x2: x, y2: y, color: ray.color });
    const index = cells.get(`${x},${y}`);
    const p = index === undefined ? undefined : level.pieces[index];
    if (!p) { queue.push({ ...ray, x, y }); continue; }
    if (p.kind === 'wall' || p.kind === 'source') continue;
    if (p.kind === 'receiver') {
      received[index!] = (received[index!] ?? 0) | ray.color;
      continue; // receivers absorb light, including a wrong color
    }
    if (p.kind === 'portal') {
      const exit = level.pieces.find((other) => other !== p && other.kind === 'portal' && other.pair === p.pair);
      if (exit) queue.push({ ...ray, x: exit.x, y: exit.y });
      continue;
    }
    const dir = reflect(ray.dir, rotations[index!] ?? p.rotation ?? 0);
    queue.push({ x, y, dir, color: ray.color });
    if (p.kind === 'splitter') queue.push({ ...ray, x, y });
  }
  const targets = level.pieces.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'receiver');
  const lit = targets.filter(({ p, i }) => received[i] === p.color).length;
  return { segments, received, lit, total: targets.length, solved: targets.length > 0 && lit === targets.length };
}

const solutionCache = new WeakMap<Level, number[][]>();
/** Exhaustive over <= 12 binary optics. Hints minimize changes from the CURRENT
 * board, rather than replaying a walkthrough that might no longer fit. */
export function solutions(level: Level): number[][] {
  const cached = solutionCache.get(level);
  if (cached) return cached;
  const indices = level.pieces.flatMap((p, i) => isRotatable(p) ? [i] : []);
  if (indices.length > 12) throw new Error('Lumen levels support at most 12 rotatable optics');
  const result: number[][] = [];
  for (let mask = 0; mask < 2 ** indices.length; mask++) {
    const rotations = initialRotations(level);
    indices.forEach((index, bit) => { rotations[index] = (mask >> bit) & 1; });
    if (trace(level, rotations).solved) result.push(rotations);
  }
  solutionCache.set(level, result);
  return result;
}
export function nextHint(level: Level, rotations: readonly number[]): number | null {
  let closest: number[] | undefined;
  let distance = Infinity;
  for (const candidate of solutions(level)) {
    const changed = candidate.flatMap((r, i) => isRotatable(level.pieces[i]) && r !== rotations[i] ? [i] : []);
    if (changed.length < distance) { closest = changed; distance = changed.length; }
  }
  return closest?.[0] ?? null;
}
export function minimumMoves(level: Level): number {
  const start = initialRotations(level);
  return Math.min(...solutions(level).map((s) => s.reduce((n, r, i) => n + Number(r !== start[i]), 0)));
}
export const starsFor = (moves: number, par: number) => moves <= par ? 3 : moves <= par + 3 ? 2 : 1;

/** Level notation: m/M = / or \\ mirror, p/P = splitter, f/F = fixed mirror,
 * nesw/NESW = gold/blue emitter, o/O/@ = gold/blue/both receiver, 1/2 = portals. */
export function makeLevel(id: string, title: string, chapter: number, briefing: string, hint: string, par: number, rows: string[]): Level {
  const pieces: Piece[] = [];
  if (rows.some((r) => r.length !== rows.length)) throw new Error(`${id}: board must be square`);
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    const base = { x, y };
    if (char === '.') return;
    if ('mMpPfF'.includes(char)) pieces.push({ ...base, kind: 'pP'.includes(char) ? 'splitter' : 'mirror', rotation: Number(char === char.toUpperCase()), fixed: 'fF'.includes(char) });
    else if ('neswNESW'.includes(char)) pieces.push({ ...base, kind: 'source', color: char === char.toLowerCase() ? 1 : 2, direction: 'nesw'.indexOf(char.toLowerCase()) as Direction });
    else if ('oO@'.includes(char)) pieces.push({ ...base, kind: 'receiver', color: char === 'o' ? 1 : char === 'O' ? 2 : 3 });
    else if (char === '#') pieces.push({ ...base, kind: 'wall' });
    else if ('12'.includes(char)) pieces.push({ ...base, kind: 'portal', pair: char });
    else throw new Error(`${id}: unknown tile ${char}`);
  }));
  return { id, title, chapter, briefing, hint, par, size: rows.length, pieces };
}
