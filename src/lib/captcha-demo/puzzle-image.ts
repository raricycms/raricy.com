// ─────────────────────────────────────────────────────────────────────────────
// puzzle-image.ts — 用 sharp 生成滑块拼图（背景 + 缺口 + 拼图块）。
//
// 【为什么自己画背景】本仓库有一条红线：**第三方素材不入库**。所以底图不是扒来的
//   照片，是每个挑战现算的一张程序化图（渐变 + 几个软色斑 + 噪声）。好处还不止合规：
//   每次都不一样 ⇒ 攻击者没法预存「这张图的缺口在哪」。
//
// 【它挡不住什么】缺口与拼图块是**同一块像素**裁出来的，所以拿两图做互相关 / 边缘
//   匹配就能算出答案 —— 这是个**图像取证题**，对稍微认真点的脚本等于白送。
//   滑块的价值本来也不在「图难解」，而在于它逼出一个**可分析的交互过程**
//   （见 trace.ts）。真要加图像强度，得上干扰线 / 局部扭曲 —— 演示版刻意不做，
//   留个诚实的缺口给下一次迭代。
//
// 【sharp 已是既有依赖】海报与分享卡片都在用它（package.json），所以这一路没有引入
//   任何新的原生依赖。
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { randomInt } from 'node:crypto';

/** 画布尺寸。 */
export const CANVAS_W = 340;
export const CANVAS_H = 180;
/** 拼图块外框边长（含凸起），= 遮罩 SVG 的宽高。 */
export const PIECE_SIZE = 64;

/** 答案的落点范围：别贴边，否则「缺口在角上」本身就成了提示。 */
const X_MIN = 40;
const X_MAX = CANVAS_W - PIECE_SIZE - 10;
const Y_MIN = 16;
const Y_MAX = CANVAS_H - PIECE_SIZE - 16;

/**
 * 拼图块的遮罩：一个圆角方块 + 四个边缘凸起。
 * 全部落在 64×64 内（凸起圆心就压在边上、半径 8，正好顶到边）——
 * 越界会被裁掉，而裁掉之后拼图块还是个「方形」，白做。
 */
function maskSvg(): Buffer {
  const s = PIECE_SIZE;
  const half = s / 2;
  const body = 8;
  const r = 8;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
      `<rect x="${body}" y="${body}" width="${s - body * 2}" height="${s - body * 2}" rx="10" fill="#fff"/>` +
      `<circle cx="${half}" cy="${body}" r="${r}" fill="#fff"/>` +
      `<circle cx="${half}" cy="${s - body}" r="${r}" fill="#fff"/>` +
      `<circle cx="${body}" cy="${half}" r="${r}" fill="#fff"/>` +
      `<circle cx="${s - body}" cy="${half}" r="${r}" fill="#fff"/>` +
      `</svg>`
  );
}

/** 线性同余，只为逐像素噪声用 —— 每像素调一次 crypto 太贵，也不必要。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 程序化底图：对角渐变 + 三个软色斑 + 噪声。 */
function buildBackground(): Buffer {
  const rng = makeRng(randomInt(0, 2 ** 31));
  const pick = () => randomInt(40, 226);
  const c1 = [pick(), pick(), pick()];
  const c2 = [pick(), pick(), pick()];

  const blobs = Array.from({ length: 3 }, () => ({
    cx: rng() * CANVAS_W,
    cy: rng() * CANVAS_H,
    r: 40 + rng() * 70,
    color: [pick(), pick(), pick()],
    strength: 0.35 + rng() * 0.35,
  }));

  const buf = Buffer.alloc(CANVAS_W * CANVAS_H * 3);
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const t = (x / CANVAS_W + y / CANVAS_H) / 2;
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;

      for (const bl of blobs) {
        const dx = x - bl.cx;
        const dy = y - bl.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bl.r * bl.r) {
          const k = (1 - Math.sqrt(d2) / bl.r) ** 2 * bl.strength;
          r += (bl.color[0] - r) * k;
          g += (bl.color[1] - g) * k;
          b += (bl.color[2] - b) * k;
        }
      }

      const n = (rng() - 0.5) * 18;
      const i = (y * CANVAS_W + x) * 3;
      buf[i] = clamp255(r + n);
      buf[i + 1] = clamp255(g + n);
      buf[i + 2] = clamp255(b + n);
    }
  }
  return buf;
}

export interface Puzzle {
  /** 带缺口的背景（PNG）。 */
  background: Buffer;
  /** 可拖动的拼图块（PNG，带 alpha）。 */
  piece: Buffer;
  /** 正确答案：拼图块该落在哪个 x。 */
  answerX: number;
  /** 拼图块的固定纵坐标。 */
  pieceY: number;
}

export async function buildPuzzle(): Promise<Puzzle> {
  const answerX = randomInt(X_MIN, X_MAX + 1);
  const pieceY = randomInt(Y_MIN, Y_MAX + 1);

  const base = await sharp(buildBackground(), {
    raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 },
  })
    .png()
    .toBuffer();

  const region = { left: answerX, top: pieceY, width: PIECE_SIZE, height: PIECE_SIZE };
  const mask = maskSvg();

  // 拼图块 = 该块原像素 ∩ 遮罩
  const piece = await sharp(base)
    .extract(region)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 缺口 = 该块原像素压暗 ∩ 同一个遮罩，再贴回原位
  const hole = await sharp(base)
    .extract(region)
    .modulate({ brightness: 0.3 })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const background = await sharp(base)
    .composite([{ input: hole, left: answerX, top: pieceY }])
    .png()
    .toBuffer();

  return { background, piece, answerX, pieceY };
}
