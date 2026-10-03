// ─────────────────────────────────────────────────────────────────────────────
// canvas.ts — 两个题型共用的画布：程序化底图 + 干扰层。
//
// 滑块（puzzle-image.ts）与点选（click-image.ts）共用这一份 —— 两条管线的底图风格必须
// 一致，否则「哪个题型更难」的对比就没意义了（底图不一样，难度差可能全来自底图，
// 而不是来自题型本身）。
//
// 【为什么底图必须自己画】本仓库有一条红线：**第三方素材不入库**。所以底图不是扒来的
//   照片，是每个挑战现算的一张程序化图。好处不止合规：每次都不同 ⇒ 攻击者没法预存
//   「这张图的答案在哪」。
// ─────────────────────────────────────────────────────────────────────────────

import { randomInt } from 'node:crypto';

/** 画布尺寸（两个题型共用）。 */
export const CANVAS_W = 340;
export const CANVAS_H = 180;

/** 线性同余。逐像素调一次 crypto 太贵，噪声与干扰线用这个就够。 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function svg(w: number, h: number, body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`
  );
}

/**
 * 多倍频分形场（每层随机网格 + 双线性上采样，逐层减幅叠加），归一到 0..1。
 *
 * 【为什么非得是它，而不是「渐变 + 色斑」】滑块那边最初用对角渐变做底图，结果位置加固
 *   **完全失效**：渐变太平滑，「局部颜色」而不是「内容」主导了匹配（实测翻转前后的 RMS
 *   只差 ~28，别处是 ~107）—— 底图没有高频结构，「这块内容属于哪里」根本无从谈起。
 *   所以这一层不是装饰，是「内容」这个概念成立的前提。
 */
export function fractalField(rng: () => number, w: number, h: number): Float32Array {
  const field = new Float32Array(w * h);
  let amp = 1;
  let cells = 4;
  for (let octave = 0; octave < 5; octave++) {
    const gw = cells + 1;
    const gh = Math.max(2, Math.round((cells * h) / w)) + 1;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();

    for (let y = 0; y < h; y++) {
      const fy = (y / h) * (gh - 1);
      const y0 = Math.floor(fy);
      const y1 = Math.min(y0 + 1, gh - 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * (gw - 1);
        const x0 = Math.floor(fx);
        const x1 = Math.min(x0 + 1, gw - 1);
        const tx = fx - x0;
        const top = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * tx;
        const bot = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * tx;
        field[y * w + x] += (top + (bot - top) * ty) * amp;
      }
    }
    amp *= 0.55;
    cells *= 2;
  }

  let mn = Infinity;
  let mx = -Infinity;
  for (const v of field) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const span = mx - mn || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - mn) / span;
  return field;
}

/** 程序化底图：分形场上色（4 个随机色标之间插值）+ 高频噪声。 */
export function buildBackground(w = CANVAS_W, h = CANVAS_H): Buffer {
  const rng = makeRng(randomInt(0, 2 ** 31));
  const field = fractalField(rng, w, h);

  const pick = () => randomInt(30, 236);
  const stops = Array.from({ length: 4 }, () => [pick(), pick(), pick()]);

  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const seg = field[i] * (stops.length - 1);
    const s0 = Math.min(Math.floor(seg), stops.length - 2);
    const frac = seg - s0;
    const a = stops[s0];
    const b = stops[s0 + 1];

    // 高频项：让每个像素都带一点独有的细节，「内容匹配」才有意义
    const n = (rng() - 0.5) * 34;
    const k = i * 3;
    buf[k] = clamp255(a[0] + (b[0] - a[0]) * frac + n);
    buf[k + 1] = clamp255(a[1] + (b[1] - a[1]) * frac + n);
    buf[k + 2] = clamp255(a[2] + (b[2] - a[2]) * frac + n);
  }
  return buf;
}

/** 干扰层：随机贝塞尔曲线 + 随机点。每次调用都不同。 */
export function interferenceSvg(w = CANVAS_W, h = CANVAS_H): Buffer {
  const rng = makeRng(randomInt(0, 2 ** 31));
  const p = (max: number) => (rng() * max).toFixed(1);

  const curves: string[] = [];
  for (let i = 0; i < 7; i++) {
    curves.push(`<path d="M ${p(w)} ${p(h)} Q ${p(w)} ${p(h)} ${p(w)} ${p(h)}"/>`);
  }
  const dots: string[] = [];
  for (let i = 0; i < 46; i++) {
    dots.push(`<circle cx="${p(w)}" cy="${p(h)}" r="${(1 + rng() * 2.4).toFixed(1)}"/>`);
  }

  return svg(
    w,
    h,
    `<g fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.4">${curves.join('')}</g>` +
      `<g fill="#000000" fill-opacity="0.20">${dots.join('')}</g>`
  );
}
