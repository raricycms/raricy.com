// A sheet has two material faces. Folding brings the currently upward faces into
// contact; the opposite face of the flap becomes visible, but does not print.
// A press reads one snapshot, so a fresh impression cannot bounce back in that press.
export type Face = 'front' | 'back';
export type Color = 'red' | 'blue';
export type Point = { x: number; y: number };
export type Matrix = readonly [number, number, number, number];
export type Crease = { id: string; name: string; nx: number; ny: number; c: number; side: 1 | -1 };
export type Hole = Point & { width: number; height: number };
export type Mark = Point & { face: Face; color: Color; matrix: Matrix; wet: boolean };
export type Goal = Omit<Mark, 'wet'>;
export type Level = { id: string; title: string; rule: string; hints: readonly string[]; creases: readonly Crease[]; holes: readonly Hole[]; ink: readonly Mark[]; goals: readonly Goal[] };
export type Action = { type: 'fold'; crease: string } | { type: 'press' } | { type: 'unfold' } | { type: 'flip' };
export type State = { face: Face; ink: Mark[]; fold: { crease: string; pressed: boolean } | null };
export type Transfer = { source: Mark; target: Mark };
export const SIZE = 8;
export const IDENTITY: Matrix = [1, 0, 0, 1];
export const otherFace = (face: Face): Face => face === 'front' ? 'back' : 'front';
const round = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

export function initialState(level: Level): State { return { face: 'front', ink: level.ink.map((mark) => ({ ...mark })), fold: null }; }
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]].map(round) as unknown as Matrix;
}
export function signedDistance(p: Point, crease: Crease): number { return (p.x * crease.nx + p.y * crease.ny - crease.c) / Math.hypot(crease.nx, crease.ny); }
export function reflected(p: Point, crease: Crease): Point {
  const d = 2 * (p.x * crease.nx + p.y * crease.ny - crease.c) / (crease.nx ** 2 + crease.ny ** 2);
  return { x: round(p.x - d * crease.nx), y: round(p.y - d * crease.ny) };
}
export function reflectionMatrix(crease: Crease): Matrix {
  const n = crease.nx ** 2 + crease.ny ** 2;
  return [1 - 2 * crease.nx ** 2 / n, -2 * crease.nx * crease.ny / n, -2 * crease.nx * crease.ny / n, 1 - 2 * crease.ny ** 2 / n].map(round) as unknown as Matrix;
}
export function markKey(mark: Goal): string { return `${mark.face}:${mark.color}:${mark.x},${mark.y}:${mark.matrix.join(',')}`; }
export function hasPaper(level: Level, p: Point): boolean {
  return p.x >= .45 && p.x <= SIZE - .45 && p.y >= .45 && p.y <= SIZE - .45 && !level.holes.some((h) => Math.abs(p.x - h.x) < h.width / 2 && Math.abs(p.y - h.y) < h.height / 2);
}
export function transfers(level: Level, state: State): Transfer[] {
  const crease = level.creases.find((item) => item.id === state.fold?.crease);
  if (!crease || state.fold?.pressed) return [];
  return state.ink.flatMap((source) => {
    if (!source.wet || source.face !== state.face || Math.abs(signedDistance(source, crease)) < .45) return [];
    const target = { ...source, ...reflected(source, crease), matrix: multiply(reflectionMatrix(crease), source.matrix) };
    return hasPaper(level, source) && hasPaper(level, target) ? [{ source, target }] : [];
  });
}
export function goalStatus(goal: Goal, state: State): 'empty' | 'wrong' | 'matched' {
  const marks = state.ink.filter((mark) => mark.face === goal.face && Math.hypot(mark.x - goal.x, mark.y - goal.y) < .01);
  if (!marks.length) return 'empty';
  return marks.every((mark) => markKey(mark) === markKey(goal)) ? 'matched' : 'wrong';
}
export function isWon(level: Level, state: State): boolean { return !state.fold && level.goals.every((goal) => goalStatus(goal, state) === 'matched'); }
export function attempt(level: Level, state: State, action: Action): { state: State; error?: string; printed?: number } {
  if (action.type === 'fold') {
    if (state.fold) return { state, error: '先展开纸页，再沿另一条线折叠。' };
    if (!level.creases.some((crease) => crease.id === action.crease)) return { state, error: '这条折痕不存在。' };
    return { state: { ...state, fold: { crease: action.crease, pressed: false } } };
  }
  if (action.type === 'flip') {
    if (state.fold) return { state, error: '先展开纸页，再翻看另一面。' };
    return { state: { ...state, face: otherFace(state.face) } };
  }
  if (action.type === 'unfold') return state.fold ? { state: { ...state, fold: null } } : { state, error: '纸页已经展开。' };
  if (!state.fold) return { state, error: '先沿折痕折起，让两处纸面接触。' };
  if (state.fold.pressed) return { state, error: '这次已经压过，请展开查看印痕。' };
  const pairs = transfers(level, state);
  const sources = new Set(pairs.map(({ source }) => markKey(source)));
  const ink = new Map(state.ink.map((mark) => [markKey(mark), sources.has(markKey(mark)) ? { ...mark, wet: false } : mark]));
  pairs.forEach(({ target }) => ink.set(markKey(target), target));
  return { state: { ...state, ink: [...ink.values()], fold: { ...state.fold, pressed: true } }, printed: pairs.length };
}
export function replay(level: Level, actions: readonly Action[]): State | null {
  let state = initialState(level);
  for (const action of actions) { const result = attempt(level, state, action); if (result.state === state) return null; state = result.state; }
  return state;
}

/** Affine projection of a flap rotating out of a flat sheet, used for paper, holes and ink alike. */
export function flapMatrix(crease: Crease, progress: number): readonly [number, number, number, number, number, number] {
  const length = Math.hypot(crease.nx, crease.ny), nx = crease.nx / length, ny = crease.ny / length, c = crease.c / length;
  const angle = Math.PI * progress, bend = 1 - Math.cos(angle), lift = Math.sin(angle) * crease.side * .65;
  return [1 - bend * nx * nx, -bend * nx * ny - lift * nx, -bend * nx * ny, 1 - bend * ny * ny - lift * ny, bend * nx * c, bend * ny * c + lift * c];
}
export function clippedHalf(crease: Crease, side: 1 | -1): Point[] {
  const square = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }];
  const result: Point[] = [];
  for (let i = 0; i < square.length; i++) {
    const a = square[i], b = square[(i + 1) % square.length], da = signedDistance(a, crease) * side, db = signedDistance(b, crease) * side;
    if (da >= -1e-8) result.push(a);
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) { const t = da / (da - db); result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return result;
}
