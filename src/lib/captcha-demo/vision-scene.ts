// ─────────────────────────────────────────────────────────────────────────────
// vision-scene.ts — 「视觉空间任务」的场景：随机摆一组立体图形并渲染成图。
//
// ── 观感是伪造出来的 ────────────────────────────────────────────────────────
//
// 没有任何 3D 库。立体感靠三样东西堆出来：
//   1. 每个形状按面拆开，明暗不同（圆柱/圆锥/球用渐变，棱锥/长方体用平的亮暗面）；
//   2. 每个物体底下压一个模糊椭圆当影子；
//   3. 底面画一条很淡的「桌面」分界。
// 目标是「一眼看过去像实物」，不是物理正确 —— 好认比好看重要。
//
// ── 一条**没有生效**的取舍：重叠 ────────────────────────────────────────────
//
// 本意是「允许轻微重叠」来加大攻击者的分割难度（参照图里物体是互相压着的，
// 而自动求解器得先做实例分割再处理遮挡，那是整条流水线里最贵的一步）。
//
// ⚠️ **实测它根本没生效**：网格 + 抖动 + MAX_OVERLAP 这套下来，400 条会话 / 1200 次
//   判定的答案是 **0% 被遮挡，最大遮挡比例 0%** —— 物体几乎从不重叠。
//   想让它真的生效得加大抖动幅度或塞更多物体，但两者都会先伤到真人（更难看清）。
//
// 这里曾经还写着「**答案物体不许被压住**」—— 那句话**代码里根本没有实现**，
// 是注释在许一个不存在的保证。现在的诚实版本是：布局恰好让它不成问题，
// 但**没有代码在守这条**。要守就在 makeInstruction 里显式查，别写在注释里。
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import {
  SHAPE_LABEL,
  COLOR_HEX,
  type SceneObject,
  type ShapeKind,
  type ColorKind,
  type SizeRank,
} from './vision-task';

export const SCENE_W = 400;
export const SCENE_H = 230;

/** 三档大小的外接尺寸。必须**拉开**，否则「最大/最小」在人眼里都难分。 */
const SIZES: Record<SizeRank, { w: number; h: number }> = {
  0: { w: 34, h: 40 },
  1: { w: 50, h: 58 },
  2: { w: 68, h: 78 },
};

const SHAPES: ShapeKind[] = ['cylinder', 'cone', 'pyramid', 'box', 'sphere'];
const COLORS: ColorKind[] = ['blue', 'red', 'green', 'yellow', 'orange', 'purple'];

/** 允许的重叠比例上限（占两者中较小那个包围盒的面积）。 */
const MAX_OVERLAP = 0.25;
/** 物体数量区间。少了不够出「相对型」指令，多了画面糊。 */
const MIN_OBJECTS = 5;
const MAX_OBJECTS = 6;

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

function overlapRatio(a: SceneObject, b: SceneObject): number {
  const ox = Math.max(0, Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2));
  const oy = Math.max(0, Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2));
  const inter = ox * oy;
  if (inter <= 0) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return inter / smaller;
}

/**
 * 随机摆一场景。位置用「3×2 网格 + 抖动 + 重叠检查」——
 * 纯随机会摆出叠成一坨的画面，网格保证分散，抖动保证不像表格。
 */
export function generateScene(rng: () => number): SceneObject[] {
  const count = MIN_OBJECTS + Math.floor(rng() * (MAX_OBJECTS - MIN_OBJECTS + 1));
  const COLS = 3;
  const ROWS = 2;
  const cellW = SCENE_W / COLS;
  const cellH = SCENE_H / ROWS;

  // 格子洗牌后依次入座，多余格子空着
  const cells = [...Array(COLS * ROWS).keys()];
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  const objects: SceneObject[] = [];
  for (let i = 0; i < count; i++) {
    const cell = cells[i];
    const col = cell % COLS;
    const row = Math.floor(cell / COLS);
    const size = pick([0, 1, 2] as SizeRank[], rng);
    const dim = SIZES[size];

    // 重试几次找一个不太压别人的位置；实在不行就用最后一次
    let placed: SceneObject | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const cx = Math.round(
        col * cellW + cellW / 2 + (rng() - 0.5) * (cellW - dim.w - 8)
      );
      const cy = Math.round(
        row * cellH + cellH / 2 + (rng() - 0.5) * (cellH - dim.h - 8)
      );
      const cand: SceneObject = {
        id: i,
        kind: pick(SHAPES, rng),
        color: pick(COLORS, rng),
        size,
        cx: Math.max(dim.w / 2 + 6, Math.min(SCENE_W - dim.w / 2 - 6, cx)),
        cy: Math.max(dim.h / 2 + 6, Math.min(SCENE_H - dim.h / 2 - 14, cy)),
        w: dim.w,
        h: dim.h,
      };
      const worst = objects.reduce((m, o) => Math.max(m, overlapRatio(cand, o)), 0);
      placed = cand;
      if (worst <= MAX_OVERLAP) break;
    }
    if (placed) objects.push(placed);
  }
  return objects;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

interface Palette {
  base: string;
  light: string;
  dark: string;
}

/** 直接在 hex 上做明暗，省掉一套 HSL 换算。 */
function palette(color: ColorKind): Palette {
  const base = COLOR_HEX[color];
  const mix = (hex: string, target: number, k: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const f = (v: number) => Math.round(v + (target - v) * k);
    return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };
  return { base, light: mix(base, 255, 0.42), dark: mix(base, 0, 0.34) };
}

function defs(o: SceneObject, p: Palette): string {
  const g = `g${o.id}`;
  return (
    `<linearGradient id="cyl${g}" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${p.dark}"/><stop offset="0.28" stop-color="${p.base}"/>` +
    `<stop offset="0.52" stop-color="${p.light}"/><stop offset="0.78" stop-color="${p.base}"/>` +
    `<stop offset="1" stop-color="${p.dark}"/></linearGradient>` +
    `<radialGradient id="sph${g}" cx="0.36" cy="0.3" r="0.78">` +
    `<stop offset="0" stop-color="${p.light}"/><stop offset="0.55" stop-color="${p.base}"/>` +
    `<stop offset="1" stop-color="${p.dark}"/></radialGradient>` +
    `<filter id="blur${g}" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="6"/></filter>`
  );
}

/** 影子：压在物体底下的模糊椭圆。所有形状共用同一套。 */
function shadowMarkup(o: SceneObject): string {
  const ry = Math.max(4, o.w * 0.16);
  return (
    `<ellipse cx="${o.cx + o.w * 0.06}" cy="${o.cy + o.h / 2 - ry * 0.3}" ` +
    `rx="${(o.w / 2) * 1.06}" ry="${ry}" fill="#6b7280" fill-opacity="0.34" ` +
    `filter="url(#blurg${o.id})"/>`
  );
}

function shapeMarkup(o: SceneObject, p: Palette): string {
  const { cx, cy, w, h } = o;
  const top = cy - h / 2;
  const bot = cy + h / 2;
  const g = `g${o.id}`;

  switch (o.kind) {
    case 'cylinder': {
      const ry = w * 0.16;
      const bodyTop = top + ry;
      const bodyBot = bot - ry;
      return (
        `<path d="M ${cx - w / 2} ${bodyTop} L ${cx - w / 2} ${bodyBot} ` +
        `A ${w / 2} ${ry} 0 0 0 ${cx + w / 2} ${bodyBot} L ${cx + w / 2} ${bodyTop} Z" ` +
        `fill="url(#cyl${g})"/>` +
        `<ellipse cx="${cx}" cy="${top + ry}" rx="${w / 2}" ry="${ry}" fill="${p.light}"/>` +
        `<ellipse cx="${cx}" cy="${top + ry}" rx="${w / 2 * 0.68}" ry="${ry * 0.68}" ` +
        `fill="${p.base}" fill-opacity="0.55"/>`
      );
    }
    case 'cone': {
      const ry = w * 0.16;
      const baseY = bot - ry;
      return (
        `<path d="M ${cx - w / 2} ${baseY} L ${cx} ${top} L ${cx + w / 2} ${baseY} ` +
        `A ${w / 2} ${ry} 0 0 1 ${cx - w / 2} ${baseY} Z" fill="url(#cyl${g})"/>` +
        `<ellipse cx="${cx}" cy="${baseY}" rx="${w / 2}" ry="${ry}" fill="${p.dark}" fill-opacity="0.5"/>`
      );
    }
    case 'pyramid': {
      // 四棱锥：底面画成菱形（等轴测），拆左右两个面
      const bhw = w / 2;
      const bh = w * 0.42;
      const baseY = bot - bh / 2;
      return (
        `<polygon points="${cx},${top} ${cx - bhw},${baseY} ${cx},${baseY + bh / 2}" fill="${p.dark}"/>` +
        `<polygon points="${cx},${top} ${cx + bhw},${baseY} ${cx},${baseY + bh / 2}" fill="${p.light}"/>`
      );
    }
    case 'box': {
      // 长方体：正面 + 顶面 + 右侧面
      const ox = w * 0.26;
      const oy = w * 0.2;
      const fx0 = cx - w / 2;
      const fx1 = cx + w / 2 - ox;
      const fy0 = top + oy;
      const fy1 = bot;
      return (
        `<polygon points="${fx0},${fy0} ${fx0 + ox},${top} ${fx1 + ox},${top} ${fx1},${fy0}" fill="${p.light}"/>` +
        `<polygon points="${fx1},${fy0} ${fx1 + ox},${top} ${fx1 + ox},${fy1 - oy} ${fx1},${fy1}" fill="${p.dark}"/>` +
        `<rect x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${fy1 - fy0}" fill="${p.base}"/>`
      );
    }
    case 'sphere': {
      const r = Math.min(w, h) / 2;
      return (
        `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${r}" fill="url(#sph${g})"/>` +
        `<ellipse cx="${cx - r * 0.34}" cy="${cy - r * 0.38}" rx="${r * 0.2}" ry="${r * 0.14}" ` +
        `fill="#ffffff" fill-opacity="0.7"/>`
      );
    }
  }
}

/** 把一场景渲染成 PNG。`markAnswer` 只在调试 / 攻击脚本里用，正常出题绝不开。 */
export async function renderScene(
  objects: SceneObject[],
  markAnswer?: { cx: number; cy: number; r: number }
): Promise<Buffer> {
  const palettes = new Map(objects.map((o) => [o.id, palette(o.color)]));

  const defsAll = objects.map((o) => defs(o, palettes.get(o.id)!)).join('');
  const shadows = objects.map(shadowMarkup).join('');
  // 远的先画（cy 小的在上面），近的压住远的
  const sorted = [...objects].sort((a, b) => a.cy - b.cy);
  const bodies = sorted.map((o) => shapeMarkup(o, palettes.get(o.id)!)).join('');

  const debug = markAnswer
    ? `<circle cx="${markAnswer.cx}" cy="${markAnswer.cy}" r="${markAnswer.r}" fill="none" ` +
      `stroke="#ff2d55" stroke-width="2"/><circle cx="${markAnswer.cx}" cy="${markAnswer.cy}" r="2.5" fill="#ff2d55"/>`
    : '';

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_W}" height="${SCENE_H}">` +
    `<defs>${defsAll}` +
    `<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#f4f4f6"/><stop offset="0.62" stop-color="#e6e7ea"/>` +
    `<stop offset="1" stop-color="#dcdde1"/></linearGradient></defs>` +
    `<rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#floor)"/>` +
    `<rect y="${SCENE_H * 0.72}" width="${SCENE_W}" height="${SCENE_H * 0.28}" fill="#c9cbd1" fill-opacity="0.28"/>` +
    shadows +
    bodies +
    debug +
    `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 给攻击脚本 / 报告用的中文描述。 */
export function describeObject(o: SceneObject): string {
  const sizeWord = o.size === 0 ? '小' : o.size === 1 ? '中' : '大';
  return `${sizeWord}${SHAPE_LABEL[o.kind]}(${o.color})`;
}
