// ─────────────────────────────────────────────────────────────────────────────
// click-image.ts — 点选题型：出「请依次点击 A B C」的题。
//
// ── 为什么要有这个题型 ──────────────────────────────────────────────────────
//
// 滑块的位置侧有个死结（见 puzzle-image.ts）：**缺口必须对真人可见，因此对机器可见** ——
// 攻击者只要找到那块「贴上去」的缺口就赢，模板匹配不行就换接缝检测。加固只能抬成本。
//
// 点选不一样：**它没有可以对齐的形状**。图上那些字没有「正确的落点」，正确与否取决于
// 你**读没读懂**这是哪个字。所以绕过它需要一个真正的 OCR 流水线，而不是一次互相关。
// 这才是「位置侧」真正上一档的地方 —— 而且它同样产出指针轨迹，行为分析一点不损失
// （见 click-trace.ts）。
//
// ── 渲染方式与它的前提 ──────────────────────────────────────────────────────
//
// 字是**运行期用 sharp 的 SVG `<text>` 现画的**，靠 librsvg 找系统字体。
// ⚠️ **这引入了字体依赖**：生产机（Linux）上必须装中文字体，否则整块渲染成豆腐块 □□□，
//   而**不会报任何错** —— 站长会看到一屏方块却查不出原因。
//   本机（Windows）实测没问题（Microsoft YaHei 命中）。
//   要上生产有两条路：① 装 Noto Sans CJK；② 照本站既有的构建期产物路数
//   （scripts/copy-emoji-assets.mjs 那样）把字模在构建期烘成 PNG 入库。
//   本 demo 走的是第 ① 条，部署前必须确认。
//
// ── 干扰与难度 ──────────────────────────────────────────────────────────────
//
//   · 目标字之间**混入同样字体/字号/颜色的干扰字** —— 否则「图上只有那三个字」，
//     定位即完成，等于没有点选。
//   · 每个字随机旋转 ±28°，破坏基于形状的模板匹配。
//   · 一层干扰线/点压在字**之上**，让 OCR 的预处理更难做。
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import { CANVAS_W, CANVAS_H, svg, buildBackground, interferenceSvg } from './canvas';

/** 备选字池。挑的是笔画差异大、互相不易混的字。 */
const CHAR_POOL = [
  '山', '明', '聪', '鱼', '干', '签',
  '到', '云', '海', '星', '风', '雨',
  '花', '木', '火', '土', '金', '水',
  '日', '月', '石', '田', '白', '青',
];

const TARGET_COUNT = 3;
const DISTRACTOR_COUNT = 3;

/** 字阵：4 列 × 2 行。一个字一格 ⇒ 天然不重叠，也不必做碰撞检测。 */
const COLS = 4;
const ROWS = 2;
const CELL_W = CANVAS_W / COLS;
const CELL_H = CANVAS_H / ROWS;

/** 格子内的抖动幅度。压得比 (格子 - 字宽) 小得多，保证字不会越格相撞。 */
const JITTER = 14;

/**
 * 点击容差半径（px）。字约 42px 见方，格间距 85px ——
 * 24 既能容忍真人的手抖，又不会吃到隔壁格的字。
 */
export const CLICK_RADIUS = 24;

export interface ClickTarget {
  x: number;
  y: number;
}

export interface ClickPuzzle {
  /** 成品 PNG（底图 + 字 + 干扰）。 */
  image: Buffer;
  /** **按点击顺序**要求点的字。顺序是随机的，不等于左右顺序。 */
  promptChars: string[];
  /** 与 promptChars 一一对应的字心坐标。 */
  targets: ClickTarget[];
  /** 图上**全部**字的字心（含干扰字）—— 只给行为分析用，见 store.ts 的说明。 */
  glyphs: ClickTarget[];
  /**
   * 答案底表：每个字画在哪。**只给测试与攻击模拟用，路由绝不下发** ——
   * 下发了就没有验证码可言了。判据见本目录 scripts/captcha-attack/attack-click.mts。
   */
  placements: { ch: string; x: number; y: number }[];
  radius: number;
  width: number;
  height: number;
}

function shuffled<T>(list: readonly T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface Placement {
  ch: string;
  x: number;
  y: number;
  rotation: number;
  size: number;
}

/** 一个字画两遍：先粗白描边当光晕（保证在任何底图上都看得清），再压深色实心。 */
function charMarkup(p: Placement): string {
  const common =
    `x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" ` +
    `font-family="Microsoft YaHei, Noto Sans CJK SC, SimSun, sans-serif" ` +
    `font-size="${p.size}" text-anchor="middle" dominant-baseline="central" ` +
    `transform="rotate(${p.rotation.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})"`;
  return (
    `<text ${common} fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="3">${p.ch}</text>` +
    `<text ${common} fill="#141414" fill-opacity="0.92">${p.ch}</text>`
  );
}

export async function buildClickPuzzle(): Promise<ClickPuzzle> {
  const bg = await sharp(buildBackground(), {
    raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 },
  })
    .png()
    .toBuffer();

  const total = TARGET_COUNT + DISTRACTOR_COUNT;
  const picked = shuffled(CHAR_POOL).slice(0, total);
  const promptChars = picked.slice(0, TARGET_COUNT); // 顺序即答案顺序
  const all = picked; // 目标字与干扰字混在一起渲染，外观上无从区分

  // 从 COLS×ROWS 个格子里随机取 total 个 —— 位置先打散，再让字随机入座，
  // 于是「哪个字在哪一格」与「要按什么顺序点」互相独立
  const cells = shuffled([...Array(COLS * ROWS).keys()]).slice(0, total);
  const placements: Placement[] = all.map((ch, i) => {
    const cell = cells[i];
    const col = cell % COLS;
    const row = Math.floor(cell / COLS);
    return {
      ch,
      x: col * CELL_W + CELL_W / 2 + (Math.random() - 0.5) * 2 * JITTER,
      y: row * CELL_H + CELL_H / 2 + (Math.random() - 0.5) * 2 * JITTER,
      rotation: (Math.random() - 0.5) * 56, // ±28°
      size: 38 + Math.round(Math.random() * 6),
    };
  });

  const byChar = new Map(placements.map((p) => [p.ch, p]));
  const targets: ClickTarget[] = promptChars.map((ch) => {
    const p = byChar.get(ch);
    // 字池与取字都无重复，取不到只可能是代码被改坏了 —— 宁可炸，别静默出题
    if (!p) throw new Error(`[click-image] 目标字 ${ch} 没有落位`);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });

  const overlay = svg(CANVAS_W, CANVAS_H, placements.map(charMarkup).join(''));

  // 干扰层压在字**之上**（顺序要紧）—— 让 OCR 的预处理更难做
  const image = await sharp(bg)
    .composite([
      { input: overlay, blend: 'over' },
      { input: interferenceSvg(), blend: 'over' },
    ])
    .png()
    .toBuffer();

  return {
    image,
    promptChars,
    targets,
    glyphs: placements.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    placements: placements.map((p) => ({ ch: p.ch, x: Math.round(p.x), y: Math.round(p.y) })),
    radius: CLICK_RADIUS,
    width: CANVAS_W,
    height: CANVAS_H,
  };
}
