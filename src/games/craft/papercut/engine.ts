// 剪纸窗花的纯几何：折叠层、楔形区域、笔画分类（细缝 / 孔洞 / 连边切块）、
// 展开时的镜像变换与掩膜路径。
// 全程只用纸面坐标（圆心为 0,0，半径 PAPER_RADIUS，向上为 -y），组件负责缩放与指针换算。
// 零 DOM / 零 React —— tests/unit/craft-papercut.test.ts 直接 import 这一份。

export const PAPER_RADIUS = 400;
export const KERF_WIDTH = 8;
export const EDGE_SNAP = 28;
export const MIN_POINT_GAP = 2.4;
export const MIN_STROKE = 14;
export const MAX_POINTS = 700;
export const MAX_CUTS = 60;
export const PAPER_SAVE_KEY = 'craft-papercut-v2';

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

export interface FoldOption { folds: 2 | 3; name: string; layers: number; axisCount: number }
/**
 * 两种折法的层数与镜像轴数。
 *
 * 【为什么是镜像、不是旋转】纸是真的折起来再剪的：折一次，剪口在两层上留下的
 * 是彼此的镜像；再折一次，这个「镜像对」又被镜像一次。所以展开后的图形由**反射**
 * 生成，不是把剪口绕着圆心转几份。
 *
 *   · 两折 → 4 层 → 二面体群 D₂：一条竖轴 + 一条横轴，相邻轴相距 90°；
 *   · 三折 → 8 层 → 二面体群 D₄：四条镜像轴，相邻轴相距 45°。
 *
 * 一般地，折数为 f 时层数 = 2^f，镜像轴数 n = 2^(f-1)，相邻轴相距 π/n，
 * 楔形半角只有它的一半（π/2n）—— 楔形夹在相邻两轴的正中间。
 * 写成「旋转 k×90°」会得到一个风车（C₄），它关于竖轴**不对称**，
 * 而任何真的折过的纸关于折痕必然对称。这条差别就是判据。
 */
export const FOLD_OPTIONS: readonly FoldOption[] = [
  { folds: 2, name: '两折', layers: 4, axisCount: 2 },
  { folds: 3, name: '三折', layers: 8, axisCount: 4 },
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
  version: 2;
  folds: 2 | 3;
  color: string;
  cuts: PaperCut[];
  /** 展开进度 0..1：0 还是一叠折好的纸，1 完全摊平。 */
  unfold: number;
  view: 'trim' | 'window';
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

/** 展开后图形的镜像轴数 n（二面体群 D_n 的 n）。 */
export function axisCount(folds: 2 | 3): number {
  return foldOption(folds).axisCount;
}

/**
 * 楔形张角（弧度）。
 *
 * 【楔形是"折完留下来的那一块"，不是一条居中的扇形】圆纸沿一条直线对折，剩下的
 * 半圆有**一条**直边（折痕）；再对折，得到四分之一圆，有**两条**直边 —— 两条都是
 * 折痕。所以折完的那一块总是**由两条折痕夹住**的，张角 = 2π/层数：
 * 4 层是 90°（一个象限），8 层是 45°。
 *
 * 楔形在纸面坐标里的角度区间是 `[0, θ]`（角度从正上方起算、顺时针为正，见
 * `wedgeAngleOf`）—— **两条直边都落在镜像轴上**，一条朝正上、一条偏开 θ。
 * 这个"不正中对齐"的摆法是有意的：折第一次就是沿竖直线对折，留下的一条边必然
 * 是竖直的；把它摆正才是折过纸的样子。若为了好看的对称而把楔形居中到 ±θ/2，
 * 两条边就不再是镜像轴，`layerTransform` 的铺法会**整块重叠**（4 层只剩 2 块，
 * 展开后是半张纸）—— 这个坑踩过。
 */
export function wedgeAngle(folds: 2 | 3): number {
  return (Math.PI * 2) / layerCount(folds);
}

/** 相邻两条镜像轴之间的夹角（弧度）。 */
export function axisStep(folds: 2 | 3): number {
  return wedgeAngle(folds);
}

/** 纸面坐标 (x, y) 的方位角：从正上方起算、顺时针为正，落在 [−π, π]。 */
export function wedgeAngleOf(x: number, y: number): number {
  return Math.atan2(x, -y);
}

/**
 * 第 index 层在展开纸上的变换。
 *
 * 折两次（或三次）得到的 2^folds 层，是把楔形按 2θ 的步长绕圆心铺一圈、奇偶层
 * 交替镜像出来的：
 *
 *   · k 为偶数 —— 直接转到 k·θ；
 *   · k 为奇数 —— 先把楔形关于竖轴翻转（落进 [−θ, 0]），再转到 (k+1)·θ。
 *
 * 结果是 layers 块首尾相接铺满整圈，且**相邻两块隔着一条折痕、互为镜像** ——
 * 也就是二面体群 D_(layers/2)。
 *
 * 【对照：错误的写法】若每层只做 `rotate(kθ)` 而不镜像，得到的是把剪口旋转拷贝
 * 一圈的**风车**（C_n）—— 风车关于任何一条折痕都不对称，而真的折过的纸必然对称。
 * 这条差别就是判据，`tests/unit/craft-papercut.test.ts` 钉着它。
 *
 * 返回 SVG transform 的片段，视图直接拼进 `<g>`。
 * ⚠️ SVG 的 transform 列表从右往左作用，所以奇数层写 `rotate(…) scale(…)`。
 */
export function layerTransform(folds: 2 | 3, index: number): string {
  const theta = (wedgeAngle(folds) * 180) / Math.PI;
  const degrees = (value: number) => Number(value.toFixed(4));
  if (index % 2 === 0) return `rotate(${degrees(index * theta)})`;
  return `rotate(${degrees((index + 1) * theta)}) scale(-1 1)`;
}

/**
 * 把楔形内的一个点按第 index 层的变换铺到整张纸上。
 *
 * 与 `layerTransform` 必须一致 —— 视图走 SVG transform，这里走算术，
 * 两处算出来必须是同一个点（单测拿这条对齐两者）。
 */
export function transformPoint(point: PaperPoint, folds: 2 | 3, index: number): PaperPoint {
  const theta = wedgeAngle(folds);
  const angle = index % 2 === 0 ? index * theta : (index + 1) * theta;
  // 奇数层先关于竖轴翻转，再旋转。
  const x = index % 2 === 1 ? -point.x : point.x;
  const y = point.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** 一笔剪口在展开纸上铺开后的所有折线（每层一条）。 */
export function unfoldStroke(points: PaperPoint[], folds: 2 | 3): PaperPoint[][] {
  const layers = layerCount(folds);
  const out: PaperPoint[][] = [];
  for (let index = 0; index < layers; index += 1) {
    out.push(points.map((point) => transformPoint(point, folds, index)));
  }
  return out;
}

export function freshPaperDraft(): PaperDraft {
  return { version: 2, folds: 2, color: PAPER_COLORS[0].id, cuts: [], unfold: 0, view: 'trim' };
}

export function setPaperFolds(draft: PaperDraft, folds: 2 | 3): PaperDraft {
  if (draft.folds === folds) return draft;
  // 换折法等于重新折一张纸，之前剪的口子对不上新的层数 —— 有刀口时拒绝换。
  if (draft.cuts.length) return draft;
  return { ...draft, folds };
}

export function setPaperColor(draft: PaperDraft, color: string): PaperDraft {
  return { ...draft, color: paperColor(color).id };
}

export function setPaperView(draft: PaperDraft, view: PaperDraft['view']): PaperDraft {
  return { ...draft, view };
}

/**
 * 设置展开进度。0..1，非有限数当作不变。
 *
 * 展开是连续的：折着的纸与摊平的纸之间是无数个中间态，不是"点一下翻过去"。
 */
export function setUnfold(draft: PaperDraft, value: number): PaperDraft {
  if (!Number.isFinite(value)) return draft;
  const unfold = Math.max(0, Math.min(1, value));
  if (unfold === draft.unfold) return draft;
  return { ...draft, unfold };
}

export function undoCuts(draft: PaperDraft): PaperDraft {
  if (!draft.cuts.length) return draft;
  return { ...draft, cuts: draft.cuts.slice(0, -1) };
}

export function clearCuts(draft: PaperDraft): PaperDraft {
  if (!draft.cuts.length) return draft;
  return { ...draft, cuts: [], unfold: 0 };
}

/** 指针是否落在折好的楔形纸上（用于决定从哪一笔开始画）。 */
export function insideWedge(x: number, y: number, folds: 2 | 3): boolean {
  const r = Math.hypot(x, y);
  if (r > PAPER_RADIUS) return false;
  const angle = wedgeAngleOf(x, y);
  return angle >= -1e-9 && angle <= wedgeAngle(folds) + 1e-9;
}

/** 把坐标夹回楔形纸内；画到纸外时沿纸边继续，而不是丢掉这一点。 */
export function clampToWedge(x: number, y: number, folds: 2 | 3): PaperPoint {
  const theta = wedgeAngle(folds);
  let r = Math.hypot(x, y);
  if (!Number.isFinite(r)) return { x: 0, y: 0 };
  if (r > PAPER_RADIUS) r = PAPER_RADIUS;
  let angle = wedgeAngleOf(x, y);
  if (!Number.isFinite(angle)) angle = 0;
  angle = Math.max(0, Math.min(theta, angle));
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

/**
 * 楔形纸的边界折线：中心 → 折痕边（角度 0）→ 外弧 → 另一条折痕边（角度 θ）→ 中心。
 *
 * 楔形张角 = 2π/层数（见 `wedgeAngle`）：层数为 4 时是 90° 的象限，层数为 8 时
 * 是 45°。**两条直边都是折痕，也就是展开时的镜像轴** —— 一条竖直朝上，一条偏开 θ。
 */
export function wedgeBoundary(folds: 2 | 3): PaperPoint[] {
  const theta = wedgeAngle(folds);
  const radialSteps = 18;
  const arcSteps = 48;
  const out: PaperPoint[] = [{ x: 0, y: 0 }];
  // 沿角度 0（正上方）这条折痕往外走。
  for (let i = 1; i <= radialSteps; i += 1) {
    const r = PAPER_RADIUS * i / radialSteps;
    out.push({ x: 0, y: -r });
  }
  // 外弧，从角度 0 扫到 θ。
  for (let i = 1; i < arcSteps; i += 1) {
    const angle = (theta * i) / arcSteps;
    out.push({ x: PAPER_RADIUS * Math.sin(angle), y: -PAPER_RADIUS * Math.cos(angle) });
  }
  // 沿角度 θ 这条折痕回到圆心。
  for (let i = radialSteps; i >= 1; i -= 1) {
    const r = PAPER_RADIUS * i / radialSteps;
    out.push({ x: r * Math.sin(theta), y: -r * Math.cos(theta) });
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

  if (length < MIN_STROKE) return null;
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
    if (!data || data.version !== 2) return null;
    const folds: 2 | 3 = data.folds === 3 ? 3 : 2;
    const color = PAPER_COLORS.some((entry) => entry.id === data.color) ? data.color! : PAPER_COLORS[0].id;
    const view = data.view === 'window' ? 'window' : 'trim';
    const unfold = typeof data.unfold === 'number' && Number.isFinite(data.unfold)
      ? Math.max(0, Math.min(1, data.unfold))
      : 0;
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
    return { version: 2, folds, color, cuts, unfold, view };
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
