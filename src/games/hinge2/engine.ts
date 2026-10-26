// The renderer and the walking graph share these transformed coordinates.
// Crossings are not junctions: only coincident, explicitly placed landings connect.
export type Point = { x: number; y: number; z?: number };
export type Surface = 'fixed' | 'paper' | 'wing' | 'reflection';
export type Node = Point & { id: string; name: string; surface: Surface; seal?: boolean };
export type Edge = readonly [string, string];
export type Action = { type: 'walk'; to: string } | { type: 'turn'; amount: 1 | -1 } | { type: 'mirror' } | { type: 'fold' };
export type State = { player: string; turn: number; mirror: boolean; folded: boolean; seals: string[] };
export type Pose = { turn: number; mirror: number; fold: number };
export type Level = {
  id: string; title: string; subtitle: string; instruction: string; color: string;
  mechanics: readonly ('turn' | 'mirror' | 'fold')[];
  nodes: readonly Node[]; edges: readonly Edge[]; start: string; goal: string;
  hints: readonly string[];
};

export function initialState(level: Level): State {
  return { player: level.start, turn: 0, mirror: false, folded: false, seals: [] };
}
export function poseOf(state: State): Pose {
  return { turn: state.turn, mirror: state.mirror ? 1 : 0, fold: state.folded ? 1 : 0 };
}
export function transform(point: Point, surface: Surface, pose: Pose): Point {
  let { x, y } = point;
  let z = point.z ?? 0;
  if (surface === 'fixed') return { x, y, z };
  if (surface === 'reflection') {
    // Mirror line turns from the y axis to the diagonal; its image turns twice as far.
    const angle = Math.PI - pose.mirror * Math.PI / 2;
    [x, y] = [Math.cos(angle) * x + Math.sin(angle) * y, Math.sin(angle) * x - Math.cos(angle) * y];
  }
  if (surface === 'wing') {
    const angle = pose.fold * Math.PI;
    z += x * Math.sin(angle);
    x *= Math.cos(angle);
  }
  const angle = pose.turn * Math.PI / 2;
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle), z };
}
export function position(node: Node, state: State): Point { return transform(node, node.surface, poseOf(state)); }
export function graph(level: Level, state: State): Map<string, string[]> {
  const result = new Map(level.nodes.map((node) => [node.id, [] as string[]]));
  function join(a: string, b: string) { result.get(a)!.push(b); result.get(b)!.push(a); }
  level.edges.forEach(([a, b]) => join(a, b));
  for (let i = 0; i < level.nodes.length; i++) {
    for (let j = i + 1; j < level.nodes.length; j++) {
      const a = level.nodes[i], b = level.nodes[j];
      if (a.surface === b.surface) continue;
      const p = position(a, state), q = position(b, state);
      if (Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0)) < .025) join(a.id, b.id);
    }
  }
  return result;
}
export function route(level: Level, state: State, to: string): string[] | null {
  const links = graph(level, state);
  if (!links.has(to)) return null;
  const queue = [[state.player]];
  const seen = new Set([state.player]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    if (last === to) return path;
    for (const next of links.get(last) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
    }
  }
  return null;
}
export function isWon(level: Level, state: State): boolean {
  return state.player === level.goal && level.nodes.every((node) => !node.seal || state.seals.includes(node.id));
}
export function attempt(level: Level, state: State, action: Action): { state: State; error?: string } {
  if (action.type === 'walk') {
    const path = route(level, state, action.to);
    if (!path) return { state, error: '这段路还没有接上。试着改变纸页。' };
    if (action.to === state.player) return { state, error: '你已经站在这里。' };
    const seals = new Set(state.seals);
    path.forEach((id) => { if (level.nodes.find((node) => node.id === id)?.seal) seals.add(id); });
    const next = { ...state, player: action.to, seals: [...seals] };
    return { state: next, ...(action.to === level.goal && !isWon(level, next) ? { error: '门还没有亮起。先拾取路上的菱形印记。' } : {}) };
  }
  if (!level.mechanics.includes(action.type)) return { state, error: '这一页没有这个机关。' };
  if (action.type === 'turn') return { state: { ...state, turn: state.turn + action.amount } };
  if (action.type === 'mirror') return { state: { ...state, mirror: !state.mirror } };
  return { state: { ...state, folded: !state.folded } };
}
export function replay(level: Level, actions: readonly Action[]): State | null {
  let state = initialState(level);
  for (const action of actions) {
    const next = attempt(level, state, action);
    if (next.state === state) return null;
    state = next.state;
  }
  return state;
}
