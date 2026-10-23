// 水面印花的纯模型：低分辨率颜料网格、滴入与拖拽的位移、以及可存草稿的游程编码。
// 复杂度按网格（200×140）而不是屏幕像素计算；组件只负责把网格放大成画布。
// 零 DOM / 零 React —— tests/unit/craft-marbling.test.ts 直接 import 这一份。

export const MARBLING_W = 200;
export const MARBLING_H = 140;
export const MARBLING_EMPTY = 255;
export const MARBLING_SAVE_KEY = 'craft-marbling-v1';
export const MARBLING_MAX_HISTORY = 16;

export interface MarblingPalette {
  id: string;
  name: string;
  colors: readonly string[];
}

export const MARBLING_PALETTES: readonly MarblingPalette[] = [
  { id: 'jade', name: '青碧', colors: ['#0f766e', '#14b8a6', '#0ea5e9', '#f0c04a', '#e85d4a', '#f3ede0'] },
  { id: 'ember', name: '晚霞', colors: ['#b23a48', '#e76f51', '#f4a261', '#e9c46a', '#2a9d8f', '#f6f1e6'] },
  { id: 'indigo', name: '夜蓝', colors: ['#1e3a8a', '#2563eb', '#38bdf8', '#a7f3d0', '#f5f3ff', '#fbbf24'] },
  { id: 'rose', name: '蔷薇', colors: ['#9d174d', '#db2777', '#f472b6', '#fbcfe8', '#7c3aed', '#fef3c7'] },
] as const;

export const MARBLING_COLOR_COUNT = 6;
export type MarblingTool = 'drop' | 'needle' | 'comb';

export interface MarblingPrint {
  palette: string;
  cells: string;
}

export interface MarblingDraft {
  version: 1;
  palette: string;
  color: number;
  tool: MarblingTool;
  cells: string;
  print: MarblingPrint | null;
  stage: 'water' | 'paper' | 'print';
}

export function marblingPalette(id: string): MarblingPalette {
  return MARBLING_PALETTES.find((palette) => palette.id === id) ?? MARBLING_PALETTES[0];
}

export function emptyGrid(): Uint8Array {
  return new Uint8Array(MARBLING_W * MARBLING_H).fill(MARBLING_EMPTY);
}

export function gridHasPaint(grid: Uint8Array): boolean {
  for (let i = 0; i < grid.length; i += 1) if (grid[i] !== MARBLING_EMPTY) return true;
  return false;
}

/** 同色成段，游程编码比逐格数组小一到两个数量级。 */
export function encodeGrid(grid: Uint8Array): string {
  const parts: string[] = [];
  let value = grid[0] ?? MARBLING_EMPTY;
  let count = 1;
  for (let i = 1; i < grid.length; i += 1) {
    if (grid[i] === value) { count += 1; continue; }
    parts.push(`${value}:${count}`);
    value = grid[i];
    count = 1;
  }
  parts.push(`${value}:${count}`);
  return parts.join(',');
}

export function decodeGrid(raw: string): Uint8Array | null {
  if (!raw || raw.length > 3_000_000) return null;
  const grid = new Uint8Array(MARBLING_W * MARBLING_H);
  let index = 0;
  for (const part of raw.split(',')) {
    const separator = part.indexOf(':');
    if (separator <= 0) return null;
    const value = Number(part.slice(0, separator));
    const count = Number(part.slice(separator + 1));
    if (!Number.isInteger(value) || value < 0 || value > MARBLING_EMPTY) return null;
    if (!Number.isInteger(count) || count < 1) return null;
    if (index + count > grid.length) return null;
    grid.fill(value, index, index + count);
    index += count;
  }
  return index === grid.length ? grid : null;
}

export function freshMarbling(): MarblingDraft {
  return {
    version: 1,
    palette: MARBLING_PALETTES[0].id,
    color: 0,
    tool: 'drop',
    cells: encodeGrid(emptyGrid()),
    print: null,
    stage: 'water',
  };
}

export function setMarblingPalette(draft: MarblingDraft, palette: string): MarblingDraft {
  return { ...draft, palette: marblingPalette(palette).id };
}

export function setMarblingColor(draft: MarblingDraft, color: number): MarblingDraft {
  return { ...draft, color: Math.max(0, Math.min(MARBLING_COLOR_COUNT - 1, Math.round(color))) };
}

export function setMarblingTool(draft: MarblingDraft, tool: MarblingTool): MarblingDraft {
  return { ...draft, tool };
}

export function clearMarbling(draft: MarblingDraft): MarblingDraft {
  return { ...draft, cells: encodeGrid(emptyGrid()), print: null, stage: 'water' };
}

export function printMarbling(grid: Uint8Array, palette: string): MarblingPrint {
  return { palette: marblingPalette(palette).id, cells: encodeGrid(grid) };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 滴一滴颜料。新颜色占据中心，外圈按半径把原有颜色往外推，并带一点角向摆动；
 * 从外向内回采旧网格，所以滴完像一圈被撑开的晕。
 */
export function dropPaint(source: Uint8Array, cx: number, cy: number, color: number): Uint8Array {
  if (color < 0 || color >= MARBLING_COLOR_COUNT) return source;
  const out = source.slice();
  const radius = 36;
  const core = 10;
  const seed = (cx * 12.9898 + cy * 78.233) % (Math.PI * 2);
  const minX = Math.max(0, Math.floor(cx - radius - 2));
  const maxX = Math.min(MARBLING_W - 1, Math.ceil(cx + radius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - 2));
  const maxY = Math.min(MARBLING_H - 1, Math.ceil(cy + radius + 2));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const rim = radius * (0.94 + 0.06 * Math.sin(angle * 3 + seed));
      if (distance > rim) continue;
      const inner = core * (0.86 + 0.14 * Math.cos(angle * 2 - seed));
      const index = y * MARBLING_W + x;
      if (distance <= inner) { out[index] = color; continue; }
      const t = (distance - inner) / (rim - inner);
      const sourceDistance = inner + (distance - inner) * (0.28 + 0.72 * t);
      const swirl = angle + 0.1 * Math.sin(angle * 4 + seed) * (1 - t);
      const sx = Math.round(cx + Math.cos(swirl) * sourceDistance);
      const sy = Math.round(cy + Math.sin(swirl) * sourceDistance);
      if (sx < 0 || sy < 0 || sx >= MARBLING_W || sy >= MARBLING_H) { out[index] = MARBLING_EMPTY; continue; }
      out[index] = source[sy * MARBLING_W + sx];
    }
  }
  return out;
}

/**
 * 一个针尖印章：把当前点附近的颜色沿拖动方向拖过来，越靠中心拖得越远，
 * 同时沿法线加一点弯，针尖留下的就是弧线而不是直线。
 */
function stampNeedle(source: Uint8Array, out: Uint8Array, cx: number, cy: number,
  moveX: number, moveY: number, radius: number, strength: number): void {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(MARBLING_W - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(MARBLING_H - 1, Math.ceil(cy + radius));
  const length = Math.hypot(moveX, moveY) || 1;
  const normalX = -moveY / length;
  const normalY = moveX / length;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const falloff = Math.pow(1 - distance / radius, 1.35) * strength;
      const curl = Math.sin(distance / radius * Math.PI) * strength * 1.6;
      const sx = Math.round(x - moveX * falloff + normalX * curl);
      const sy = Math.round(y - moveY * falloff + normalY * curl);
      if (sx < 0 || sy < 0 || sx >= MARBLING_W || sy >= MARBLING_H) continue;
      out[y * MARBLING_W + x] = source[sy * MARBLING_W + sx];
    }
  }
}

/** 针：沿这一段拖动，位移取本段方向；快速划动会补足中间的印章。 */
export function needleStroke(source: Uint8Array, from: { x: number; y: number }, to: { x: number; y: number }, radius = 14): Uint8Array {
  const out = source.slice();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.4) return out;
  const moveX = clamp(dx, -7, 7);
  const moveY = clamp(dy, -7, 7);
  const steps = Math.max(1, Math.ceil(distance / (radius * 0.6)));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    stampNeedle(source, out, from.x + dx * t, from.y + dy * t, moveX, moveY, radius, 1);
  }
  return out;
}

/** 梳子：七枚齿沿法线排开，各自拖出一条与运动方向平行的纹理。 */
export function combStroke(source: Uint8Array, from: { x: number; y: number }, to: { x: number; y: number }): Uint8Array {
  const out = source.slice();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.4) return out;
  const moveX = clamp(dx, -6, 6);
  const moveY = clamp(dy, -6, 6);
  const length = Math.hypot(moveX, moveY) || 1;
  const normalX = -moveY / length;
  const normalY = moveX / length;
  const steps = Math.max(1, Math.ceil(distance / 8));
  const spacing = 13;
  const radius = 5.6;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    for (let tooth = -3; tooth <= 3; tooth += 1) {
      stampNeedle(source, out, cx + normalX * tooth * spacing, cy + normalY * tooth * spacing,
        moveX * 1.15, moveY * 1.15, radius, 1);
    }
  }
  return out;
}

export function parseMarblingDraft(raw: string | null): MarblingDraft | null {
  if (!raw || raw.length > 4_000_000) return null;
  try {
    const data = JSON.parse(raw) as Partial<MarblingDraft> | null;
    if (!data || data.version !== 1) return null;
    if (typeof data.cells !== 'string' || !decodeGrid(data.cells)) return null;
    const palette = MARBLING_PALETTES.some((entry) => entry.id === data.palette) ? data.palette! : MARBLING_PALETTES[0].id;
    const color = Number.isInteger(data.color) && Number(data.color) >= 0 && Number(data.color) < MARBLING_COLOR_COUNT
      ? Number(data.color) : 0;
    const tool: MarblingTool = data.tool === 'needle' || data.tool === 'comb' ? data.tool : 'drop';
    let print: MarblingPrint | null = null;
    if (data.print && typeof data.print.cells === 'string' && typeof data.print.palette === 'string'
      && MARBLING_PALETTES.some((entry) => entry.id === data.print!.palette) && decodeGrid(data.print.cells)) {
      print = { palette: data.print.palette, cells: data.print.cells };
    }
    let stage: MarblingDraft['stage'] = data.stage === 'paper' || data.stage === 'print' ? data.stage : 'water';
    if (stage === 'print' && !print) stage = 'water';
    return { version: 1, palette, color, tool, cells: data.cells, print, stage };
  } catch {
    return null;
  }
}
