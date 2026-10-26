/** Reversible, orthogonal optics. Empty sockets transmit; a mirror reflects
 * either color identically. There is no splitting, mixing, or teleportation. */
export type Direction = 0 | 1 | 2 | 3;
export type Mirror = 0 | 1 | 2; // empty, /, \
export type Color = 'gold' | 'blue';
export interface Point { x: number; y: number }
export interface Port extends Point { color: Color; direction: Direction }
export interface Level {
  id: string;
  title: string;
  chapter: number;
  size: number;
  stock: number;
  sockets: Point[];
  sources: Port[];
  targets: Port[];
  intro: string;
  hints: readonly string[];
  insight: string;
}
export interface Beam {
  color: Color;
  points: Point[];
  mirrors: number[];
  outcome: 'arrived' | 'wrong' | 'escaped' | 'loop';
  target: number;
}
export interface Trace { beams: Beam[]; lit: number[]; used: number; shared: number[]; solved: boolean }
const DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
export const coordinate = (p: Point) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
export const countMirrors = (board: readonly Mirror[]) => board.filter(Boolean).length;
export const emptyBoard = (level: Level): Mirror[] => level.sockets.map(() => 0);
export const reflect = (dir: Direction, mirror: 1 | 2): Direction =>
  (mirror === 1 ? [1, 0, 3, 2] : [3, 2, 1, 0])[dir] as Direction;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const inside = (p: Point, size: number) => p.x >= 0 && p.y >= 0 && p.x < size && p.y < size;

export function trace(level: Level, board: readonly Mirror[]): Trace {
  const cells = new Map(level.sockets.map((p, i) => [`${p.x},${p.y}`, i]));
  const beams: Beam[] = level.sources.map((source) => {
    let { x, y, direction: dir } = source;
    const points: Point[] = [{ x, y }], mirrors: number[] = [];
    const visited = new Set<string>();
    while (true) {
      const [dx, dy] = DELTA[dir];
      x += dx; y += dy;
      points.push({ x, y });
      if (!inside({ x, y }, level.size)) {
        const target = level.targets.findIndex((p) => same(p, { x, y }));
        return { color: source.color, points, mirrors, target,
          outcome: target < 0 ? 'escaped' : level.targets[target].color === source.color ? 'arrived' : 'wrong' };
      }
      const key = `${x},${y},${dir}`;
      if (visited.has(key)) return { color: source.color, points, mirrors, target: -1, outcome: 'loop' };
      visited.add(key);
      const socket = cells.get(`${x},${y}`);
      const mirror = socket === undefined ? 0 : board[socket];
      if (mirror) { dir = reflect(dir, mirror); mirrors.push(socket!); }
    }
  });
  const lit = [...new Set(beams.filter((b) => b.outcome === 'arrived').map((b) => b.target))];
  const shared = level.sockets.flatMap((_, i) => beams.filter((b) => b.mirrors.includes(i)).length > 1 ? [i] : []);
  const used = countMirrors(board);
  return { beams, lit, used, shared, solved: used <= level.stock && beams.every((b) => b.outcome === 'arrived') && lit.length === level.targets.length };
}

/** Authoring/verification solver. Branch only when a beam encounters an unknown
 * socket, reject wrong exits immediately, and cap enumeration when requested.
 * Unvisited sockets are also enumerated: decorative dark mirrors must not make
 * an apparently unique puzzle pass the uniqueness check. Not used for hints. */
export function solve(level: Level, limit = Infinity): Mirror[][] {
  if (level.sockets.length > 18) throw new Error('Lumen 2 supports at most 18 sockets');
  const cells = new Map(level.sockets.map((p, i) => [`${p.x},${p.y}`, i]));
  const board: number[] = level.sockets.map(() => -1);
  const results: Mirror[][] = [];
  function visit(used: number) {
    if (results.length >= limit) return;
    let unknown = -1;
    for (const source of level.sources) {
      let { x, y, direction: dir } = source;
      const visited = new Set<string>();
      while (true) {
        const [dx, dy] = DELTA[dir]; x += dx; y += dy;
        if (!inside({ x, y }, level.size)) {
          if (!level.targets.some((p) => p.color === source.color && same(p, { x, y }))) return;
          break;
        }
        const key = `${x},${y},${dir}`;
        if (visited.has(key)) return;
        visited.add(key);
        const socket = cells.get(`${x},${y}`);
        if (socket !== undefined) {
          if (board[socket] === -1) { unknown = socket; break; }
          if (board[socket]) dir = reflect(dir, board[socket] as 1 | 2);
        }
      }
      if (unknown >= 0) break;
    }
    if (unknown < 0) unknown = board.indexOf(-1);
    if (unknown < 0) { if (trace(level, board as Mirror[]).solved) results.push([...board] as Mirror[]); return; }
    for (const state of used < level.stock ? [0, 1, 2] : [0]) {
      board[unknown] = state;
      visit(used + Number(state > 0));
      if (results.length >= limit) break;
    }
    board[unknown] = -1;
  }
  visit(0);
  return results;
}
