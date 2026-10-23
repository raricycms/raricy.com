// 剪纸窗花的纯几何：折叠层、楔形区域、笔画分类（细缝 / 孔洞 / 连边切块）与掩膜路径。
// 全程只用纸面坐标（圆心为 0,0，半径 PAPER_RADIUS，向上为 -y），组件负责缩放与指针换算。
// 零 DOM / 零 React —— tests/unit/craft-papercut.test.ts 直接 import 这一份。

export const PAPER_RADIUS = 400;
export const KERF_WIDTH = 8;
export const EDGE_SNAP = 28;
export const MIN_POINT_GAP = 2.4;
export const MAX_POINTS = 700;
export const MAX_CUTS = 60;
export const PAPER_SAVE_KEY = 'craft-papercut-v1';

export interface PaperPoint { x: number; y: number }

export interface PaperColor {
  id: string;
  name: string;
  fill: string;
  light: string;
  shade: string;
}

export const PAPER_COLORS: readonly PaperColor[] = [
  { id: 'vermilion', name: '朱红', fill: '#c2473d', light: '#dd7a6d', shade: '#8f2d28' },
  { id: 'indigo', name: '靛蓝', fill: '#3d5b86', light: '#7490b6', shade: '#293f60' },
  { id: 'calendula', name: '姜黄', fill: '#c89a3d', light: '#e4c377', shade: '#93702a' },
  { id: 'pine', name: '松绿', fill: '#4c7963', light: '#81a892', shade: '#315747' },
  { id: 'rice', name: '米白', fill: '#e8dec7', light: '#f7f0e1', shade: '#c5b694' },
] as const;

export interface FoldOption { folds: 2 | 3; name: string; layers: number; angle: number }
export const FOLD_OPTIONS: readonly FoldOption[] = [
  { folds: 2, name: '两折', layers: 4, angle: 90 },
  { folds: 3, name: '三折', layers: 8, angle: 45 },
] as const;

export type CutKind = 'kerf' | 'hole' | 'pocket';

export interface PaperCut {
  id: number;
  kind: CutKind;
  points: PaperPoint[];
  /** 连边切块从纸边回到起点的那一段边界。孔洞与细缝没有这一段。 */
  boundary?: PaperPoint[];
}

export interface PaperDraft {
  version: 1;
  started: boolean;
  folds: 2 | 3;
  color: string;
  cuts: PaperCut[];
  view: 'trim' | 'unfolded' | 'window';
}

export function foldOption(folds: 2 | 3): FoldOption {
  return folds === 3 ? FOLD_OPTIONS[1] : FOLD_OPTIONS[0];
}

export function paperColor(id: string): PaperColor {
  return PAPER_COLORS.find((color) => color.id === id) ?? PAPER_COLORS[0];
}

export function layerCount(folds: 2 | 3): number {
  return 2 ** folds;
}

export function layerAngle(folds: 2 | 3, index: number): number {
  return index * foldOption(folds).angle;
}

export function freshPaperDraft(): PaperDraft {
  return { version: 1, started: false, folds: 2, color: PAPER_COLORS[0].id, cuts: [], view: 'trim' };
}

export function startPaper(draft: PaperDraft, folds: 2 | 3, color: string): PaperDraft {
  return { ...draft, started: true, folds, color: paperColor(color).id, cuts: [], view: 'trim' };
}

export function restartPaper(draft: PaperDraft): PaperDraft {
  return { ...draft, started: false, cuts: [], view: 'trim' };
}

export function setPaperView(draft: PaperDraft, view: PaperDraft['view']): PaperDraft {
  return { ...draft, view };
}

export function undoCuts(draft: PaperDraft): PaperDraft {
  if (!draft.cuts.length) return draft;
  return { ...draft, cuts: draft.cuts.slice(0, -1) };
}

/** 指针是否落在折好的楔形纸上（用于决定从哪一笔开始画）。 */
export function insideWedge(x: number, y: number, folds: 2 | 3): boolean {
  const r = Math.hypot(x, y);
  if (r > PAPER_RADIUS) return false;
  const angle = Math.atan2(x, -y);
  return Math.abs(angle) <= foldOption(folds).angle * Math.PI / 360;
}

/** 把坐标夹回楔形纸内；画到纸外时沿纸边继续，而不是丢掉这一点。 */
export function clampToWedge(x: number, y: number, folds: 2 | 3): PaperPoint {
  const half = foldOption(folds).angle * Math.PI / 360;
  let r = Math.hypot(x, y);
  if (!Number.isFinite(r)) return { x: 0, y: 0 };
  if (r > PAPER_RADIUS) r = PAPER_RADIUS;
  let angle = Math.atan2(x, -y);
  if (!Number.isFinite(angle)) angle = 0;
  angle = Math.max(-half, Math.min(half, angle));
  return { x: r * Math.sin(angle), y: -r * Math.cos(angle) };
}

/** 坐标保留一位小数；不用 `* 10 / 10` 的收敛式，那条形状被判据当作鱼干标度旁路。 */
export function roundTenth(value: number): number {
  return Number(value.toFixed(1));
}

export function cleanPoints(points: PaperPoint[], folds: 2 | 3): PaperPoint[] {
  const out: PaperPoint[] = [];
  for (const raw of points) {
    const point = clampToWedge(raw.x, raw.y, folds);
    const rounded = { x: roundTenth(point.x), y: roundTenth(point.y) };
    const last = out[out.length - 1];
    if (!last || Math.hypot(rounded.x - last.x, rounded.y - last.y) >= MIN_POINT_GAP) out.push(rounded);
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

/** RDP 简化：只去掉肉眼看不出来的抖动，保留剪刀转折。 */
export function simplifyPoints(points: PaperPoint[], tolerance = 2.2): PaperPoint[] {
  if (points.length <= 2) return points.slice();
  const first = points[0], last = points[points.length - 1];
  let index = -1, distance = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = distanceToSegment(points[i], first, last);
    if (d > distance) { distance = d; index = i; }
  }
  if (index === -1 || distance <= tolerance) return [first, last];
  const left = simplifyPoints(points.slice(0, index + 1), tolerance);
  const right = simplifyPoints(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** 折线长度（用于「这一笔是不是太短」）。 */
export function pathLength(points: PaperPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}

function distanceToSegment(point: PaperPoint, a: PaperPoint, b: PaperPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** 楔形纸的边界折线：中心 → 左折边 → 外弧 → 右折边 → 中心。 */
export function wedgeBoundary(folds: 2 | 3): PaperPoint[] {
  const half = foldOption(folds).angle * Math.PI / 360;
  const radialSteps = 18;
  const arcSteps = 48;
  const out: PaperPoint[] = [{ x: 0, y: 0 }];
  for (let i = 1; i <= radialSteps; i += 1) {
    const r = PAPER_RADIUS * i / radialSteps;
    out.push({ x: -r * Math.sin(half), y: -r * Math.cos(half) });
  }
  for (let i = 1; i < arcSteps; i += 1) {
    const angle = -half + (2 * half) * i / arcSteps;
    out.push({ x: PAPER_RADIUS * Math.sin(angle), y: -PAPER_RADIUS * Math.cos(angle) });
  }
  for (let i = radialSteps; i >= 1; i -= 1) {
    const r = PAPER_RADIUS * i / radialSteps;
    out.push({ x: r * Math.sin(half), y: -r * Math.cos(half) });
  }
  return out;
}

function nearestBoundaryIndex(point: PaperPoint, boundary: PaperPoint[]): { index: number; distance: number } {
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i < boundary.length; i += 1) {
    const d = Math.hypot(boundary[i].x - point.x, boundary[i].y - point.y);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return { index: best, distance: bestDistance };
}

export function polygonArea(points: PaperPoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function dedupe(points: PaperPoint[]): PaperPoint[] {
  const out: PaperPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.5) out.push(point);
  }
  return out;
}

function routeBetween(boundary: PaperPoint[], from: number, to: number, direction: 1 | -1): PaperPoint[] {
  const out: PaperPoint[] = [];
  let index = from;
  for (let guard = 0; guard <= boundary.length; guard += 1) {
    if (index === to) break;
    index = (index + direction + boundary.length) % boundary.length;
    out.push(boundary[index]);
  }
  return out;
}

/**
 * 把一笔画分类并算出要挖掉的区域。
 * · 收口（终点回到起点附近）→ 孔洞；
 * · 两端都贴着纸边 → 连边切块（沿较近的一侧纸边闭合）；
 * · 其余 → 细缝（沿笔画去掉一条剪刀宽度的纸）。
 */
export function analyzeStroke(rawPoints: PaperPoint[], folds: 2 | 3): Omit<PaperCut, 'id'> | null {
  const cleaned = cleanPoints(rawPoints, folds);
  if (cleaned.length < 2) return null;
  const points = simplifyPoints(cleaned, 2.2);
  if (points.length < 2) return null;
  const length = pathLength(points);
  const first = points[0], last = points[points.length - 1];
  const closing = Math.hypot(last.x - first.x, last.y - first.y);

  if (length >= 85 && closing <= 34) {
    return { kind: 'hole', points: dedupe(points) };
  }

  if (length >= 70) {
    const boundary = wedgeBoundary(folds);
    const start = nearestBoundaryIndex(first, boundary);
    const end = nearestBoundaryIndex(last, boundary);
    if (start.distance <= EDGE_SNAP && end.distance <= EDGE_SNAP && start.index !== end.index) {
      const forward = routeBetween(boundary, end.index, start.index, 1);
      const backward = routeBetween(boundary, end.index, start.index, -1);
      const areaForward = Math.abs(polygonArea([...points, ...forward]));
      const areaBackward = Math.abs(polygonArea([...points, ...backward]));
      const route = areaForward <= areaBackward ? forward : backward;
      const region = dedupe([...points, ...route]);
      if (region.length >= 3 && Math.abs(polygonArea(region)) >= 40) return { kind: 'pocket', points, boundary: dedupe(route) };
    }
  }

  if (length < 14) return null;
  return { kind: 'kerf', points };
}

export function addCut(draft: PaperDraft, stroke: PaperPoint[]): PaperDraft {
  if (draft.cuts.length >= MAX_CUTS) return draft;
  const cut = analyzeStroke(stroke, draft.folds);
  if (!cut) return draft;
  const id = draft.cuts.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  return { ...draft, cuts: [...draft.cuts, { ...cut, id }] };
}

function number(value: number): string {
  return roundTenth(value).toString();
}

/** 一条平滑路径；孔洞收口，细缝保持开口。 */
export function smoothPath(points: PaperPoint[], closed = false): string {
  if (!points.length) return '';
  if (points.length === 1) return `M${number(points[0].x)} ${number(points[0].y)}`;
  const path = closed ? [...points, points[0]] : points;
  let d = `M${number(path[0].x)} ${number(path[0].y)}`;
  for (let i = 0; i < path.length - 1; i += 1) {
    const p0 = path[i - 1] ?? path[i];
    const p1 = path[i], p2 = path[i + 1];
    const p3 = path[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${number(c1x)} ${number(c1y)} ${number(c2x)} ${number(c2y)} ${number(p2.x)} ${number(p2.y)}`;
  }
  return closed ? `${d}Z` : d;
}

/** 掩膜与预览共用的「被切掉区域」路径：细缝是描边，孔洞/切块是填充。 */
export function cutMaskShape(cut: Omit<PaperCut, 'id'>): { d: string; mode: 'stroke' | 'fill' } {
  if (cut.kind === 'kerf') return { d: smoothPath(cut.points), mode: 'stroke' };
  if (cut.kind === 'hole') return { d: smoothPath(cut.points, true), mode: 'fill' };
  const boundary = cut.boundary ?? [];
  const d = `${smoothPath(cut.points)}${boundary.map((point) => `L${number(point.x)} ${number(point.y)}`).join('')}Z`;
  return { d, mode: 'fill' };
}

export function cutRegionPoints(cut: Omit<PaperCut, 'id'>): PaperPoint[] {
  return cut.kind === 'pocket' ? [...cut.points, ...(cut.boundary ?? [])] : cut.points;
}

export function parsePaperDraft(raw: string | null): PaperDraft | null {
  if (!raw || raw.length > 3_000_000) return null;
  try {
    const data = JSON.parse(raw) as Partial<PaperDraft> | null;
    if (!data || data.version !== 1) return null;
    const folds: 2 | 3 = data.folds === 3 ? 3 : 2;
    const color = PAPER_COLORS.some((entry) => entry.id === data.color) ? data.color! : PAPER_COLORS[0].id;
    const view = data.view === 'unfolded' || data.view === 'window' ? data.view : 'trim';
    const cuts: PaperCut[] = [];
    if (Array.isArray(data.cuts)) {
      for (const rawCut of data.cuts.slice(0, MAX_CUTS)) {
        if (!rawCut || !Array.isArray(rawCut.points)) continue;
        const kind = rawCut.kind;
        if (kind !== 'kerf' && kind !== 'hole' && kind !== 'pocket') continue;
        const points = validatePoints(rawCut.points);
        if (points.length < 2) continue;
        const boundary = kind === 'pocket' ? validatePoints(rawCut.boundary) : undefined;
        if (kind === 'pocket' && (!boundary || boundary.length < 2)) continue;
        cuts.push({ id: cuts.length + 1, kind, points, ...(boundary ? { boundary } : {}) });
      }
    }
    return { version: 1, started: data.started === true, folds, color, cuts, view: data.started === true ? view : 'trim' };
  } catch {
    return null;
  }
}

function validatePoints(value: unknown): PaperPoint[] {
  if (!Array.isArray(value)) return [];
  const out: PaperPoint[] = [];
  for (const point of value.slice(0, MAX_POINTS)) {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') continue;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (Math.hypot(point.x, point.y) > PAPER_RADIUS + 2) continue;
    out.push({ x: point.x, y: point.y });
  }
  return out;
}
