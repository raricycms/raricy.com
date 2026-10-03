// ─────────────────────────────────────────────────────────────────────────────
// puzzle-image.ts — 用 sharp 生成滑块拼图（背景 + 缺口 + 拼图块）。
//
// 【为什么自己画背景】本仓库有一条红线：**第三方素材不入库**。所以底图不是扒来的
//   照片，是每个挑战现算的一张程序化图（渐变 + 软色斑 + 噪声 + 干扰线）。
//   好处不止合规：每次都不同 ⇒ 攻击者没法预存「这张图的缺口在哪」。
//
// ── 加固：断掉模板匹配 ──────────────────────────────────────────────────────
//
// 最初的版本把缺口做成「拼图块自己的像素压暗 30% 贴回去」。那是**白送**：
// 缺口与拼图块是同一块像素，拿两图做互相关当场算出答案。现在的做法：
//
//   1. **底图必须有高频结构**（分形场，见 fractalField）。这一条是前提，不是装饰：
//      第一版加固留着平滑渐变底图，结果模板匹配**仍然一击即中** —— 渐变太平滑，
//      「局部颜色」而不是「内容」主导了匹配。底图没有细节，缺口里换成什么都无所谓。
//   2. **缺口填的是别处的一块真实像素**（donor）：纹理在（真人也需要它来对齐），
//      但原件内容在整张图上**不存在了** —— 模板匹配无处可去。
//      ⚠️ 别退回「把本区域水平翻转」：镜像与原件共享同一批像素，攻击者拿
//      flip(piece) 去匹配就能反推出来。
//   3. 两层干扰（随机曲线 + 点）压在图上，其中一层**横穿缺口的边缘**，
//      缺口轮廓因此不再是一条干净的线。
//   4. 拼图块本身加白色描边 —— 缺口那块内容被换掉了，描边让真人还能一眼看清
//      自己拖的是哪一块（这是补偿，不是加密）。
//
// ── 诚实的边界：这买到的是「常数倍」，不是「墙」 ─────────────────────────────
//
// **缺口的轮廓必须对真人可见，因此对机器也可检测** —— 这是滑块这类题的固有属性，
// 不是没做好。上面三条把「一次互相关就出答案」抬成「要写一个 blob 检测 + 亚像素
// 定位 + 抗干扰的处理链」，但一个铁了心的攻击者仍然做得出来。
//
// 真要再上一档，得换题型而不是继续堆干扰：**点选式（按顺序点中图上的字）没有可
// 匹配的模板** —— 它要求 OCR + 顺序理解，而滑块永远有一个形状可以对齐。
// 见本目录的讨论记录。
//
// 【sharp 已是既有依赖】海报与分享卡片都在用它（package.json），这一路没有引入
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

/** 形状参数：圆角方块 + 四个边缘凸起，全部落在 PIECE_SIZE 见方之内。 */
const INSET = 8;
const BODY_RADIUS = 10;
const BUMP_RADIUS = 8;

/**
 * 形状的 markup。**遮罩、拼图块描边、缺口描边三处共用同一份** ——
 * 三处一旦不一致，拼图块与缺口就对不上，而症状只是「这题看着有点歪」，不报错。
 */
function shapeMarkup(attrs: string): string {
  const s = PIECE_SIZE;
  const half = s / 2;
  const far = s - INSET;
  return (
    `<rect x="${INSET}" y="${INSET}" width="${s - INSET * 2}" height="${s - INSET * 2}" rx="${BODY_RADIUS}" ${attrs}/>` +
    `<circle cx="${half}" cy="${INSET}" r="${BUMP_RADIUS}" ${attrs}/>` +
    `<circle cx="${half}" cy="${far}" r="${BUMP_RADIUS}" ${attrs}/>` +
    `<circle cx="${INSET}" cy="${half}" r="${BUMP_RADIUS}" ${attrs}/>` +
    `<circle cx="${far}" cy="${half}" r="${BUMP_RADIUS}" ${attrs}/>`
  );
}

function svg(w: number, h: number, body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`
  );
}

/** 遮罩：只有它决定形状的 alpha。凸起圆心压在边上、半径 8，正好顶到 64 的边界。 */
const maskSvg = (): Buffer => svg(PIECE_SIZE, PIECE_SIZE, shapeMarkup('fill="#fff"'));

/** 拼图块的描边：**实线**，用来让真人看清自己拖的是哪一块。 */
const outlineSvg = (): Buffer =>
  svg(
    PIECE_SIZE,
    PIECE_SIZE,
    shapeMarkup('fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2"')
  );

/**
 * 缺口**既不描边、也不压暗** —— 它只是「一块内容对不上的像素」。
 *
 * 【两次试错的记录，别再走一遍】
 *   · 缺口与拼图块曾共用一条白色实线描边 ⇒ 等于盖了个精确的模板标记，逐点 SSD 匹配把
 *     真答案稳定排在第 1 名、分数带窄得反常（28349 vs 31000+）—— 匹配没在找内容，
 *     是在**对齐那条描边**。
 *   · 换成「虚线琥珀色」能打断匹配，但更糟：那等于用颜色给目标打了个高亮，攻击者按色相
 *     阈值取连通域即可，比模板匹配还省事。
 *   · 换成「压暗」（brightness 0.42）则反向泄漏：压暗制造恒定亮度偏移，于是**匹配最差**
 *     的位置就是真答案（6/6 排在第 277/277 名），攻击者取 argmax 即可。
 *
 *   现在三者都不要，实测（8 轮，已知 pieceY、沿 x 全搜 277 个候选）：真答案中位排名
 *   **235/277**（随机期望 139），比分比最佳候选差 4%~28% —— 既不在第 1、也不在最后，
 *   naive 模板匹配不再收敛。
 *
 *   ⚠️ 但**这不等于缺口不可定位**：它终究是一块「贴上去的」内容，与四周在边界处有断差，
 *   专门找「局部统计异常 / 接缝」的方法照样能找到。滑块的位置侧只能抬高成本、封不死 ——
 *   缺口的可见性与可定位性是同一件事。想要位置侧真正硬，得换题型（点选没有可对齐的形状）。
 */

/** 线性同余，只为逐像素噪声与干扰线用 —— 每像素调一次 crypto 太贵，也不必要。 */
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

/**
 * 多倍频分形场（每层随机网格 + 双线性上采样，逐层减幅叠加），归一到 0..1。
 *
 * 【为什么非得是它，而不是「渐变 + 色斑」】最初的底图是对角渐变。那个底图让缺口加固
 * **完全失效**：实测把缺口换成翻转后的同源像素，模板匹配依然在第 1 名一击即中 ——
 * 因为渐变太平滑，「局部颜色」而不是「内容」主导了匹配，翻转前后的 RMS 差异只有 ~28
 * （别处是 ~107）。**底图没有高频结构，缺口里换成什么都无所谓。**
 * 所以这一层不是装饰，是位置加固的前提：内容必须真的「独一无二」才有得谈。
 */
function fractalField(rng: () => number, w: number, h: number): Float32Array {
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

/**
 * 程序化底图：分形场上色（4 个随机色标之间插值）+ 高频噪声。
 *
 * ⚠️ **别退回「渐变 + 色斑」** —— 那会让缺口加固整体失效，理由见 fractalField 的注释。
 */
function buildBackground(): Buffer {
  const rng = makeRng(randomInt(0, 2 ** 31));
  const field = fractalField(rng, CANVAS_W, CANVAS_H);

  const pick = () => randomInt(30, 236);
  const stops = Array.from({ length: 4 }, () => [pick(), pick(), pick()]);

  const buf = Buffer.alloc(CANVAS_W * CANVAS_H * 3);
  for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
    const seg = field[i] * (stops.length - 1);
    const s0 = Math.min(Math.floor(seg), stops.length - 2);
    const frac = seg - s0;
    const a = stops[s0];
    const b = stops[s0 + 1];

    // 高频项：让每个像素都带一点独有的细节，内容匹配才有意义
    const n = (rng() - 0.5) * 34;
    const k = i * 3;
    buf[k] = clamp255(a[0] + (b[0] - a[0]) * frac + n);
    buf[k + 1] = clamp255(a[1] + (b[1] - a[1]) * frac + n);
    buf[k + 2] = clamp255(a[2] + (b[2] - a[2]) * frac + n);
  }
  return buf;
}

/** 干扰层：随机贝塞尔曲线 + 随机点。每次调用都不同（第二次压在缺口之上）。 */
function interferenceSvg(): Buffer {
  const rng = makeRng(randomInt(0, 2 ** 31));
  const p = (max: number) => (rng() * max).toFixed(1);

  const curves: string[] = [];
  for (let i = 0; i < 7; i++) {
    curves.push(
      `<path d="M ${p(CANVAS_W)} ${p(CANVAS_H)} Q ${p(CANVAS_W)} ${p(CANVAS_H)} ${p(CANVAS_W)} ${p(CANVAS_H)}"/>`
    );
  }
  const dots: string[] = [];
  for (let i = 0; i < 46; i++) {
    dots.push(`<circle cx="${p(CANVAS_W)}" cy="${p(CANVAS_H)}" r="${(1 + rng() * 2.4).toFixed(1)}"/>`);
  }

  return svg(
    CANVAS_W,
    CANVAS_H,
    `<g fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.4">${curves.join('')}</g>` +
      `<g fill="#000000" fill-opacity="0.20">${dots.join('')}</g>`
  );
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
  const region = { left: answerX, top: pieceY, width: PIECE_SIZE, height: PIECE_SIZE };

  const base = await sharp(buildBackground(), {
    raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 },
  })
    .png()
    .toBuffer();

  // 第一层干扰在裁剪之前 —— 拼图块与缺口才带着同一份纹理
  const textured = await sharp(base)
    .composite([{ input: interferenceSvg(), blend: 'over' }])
    .png()
    .toBuffer();

  // 先落成 PNG 再 extract，避免 sharp 把 extract/composite 的先后顺序重排
  const regionPng = await sharp(textured).extract(region).png().toBuffer();

  // 缺口的填充料取自**别处**的一块真实像素（水平错开半个画布，两个补丁必然不会重叠）。
  //   这里曾用过「把本区域水平翻转」，已换掉：翻转与原件共享同一批像素（只是镜像），
  //   一个稍聪明的攻击者拿 flip(piece) 去匹配就能反推出缺口位置。
  //   换成别处的内容之后，原件与它的镜像在整张图上**都不存在**，匹配无处可去。
  const donorX = (answerX + Math.floor((CANVAS_W - PIECE_SIZE) / 2)) % (CANVAS_W - PIECE_SIZE);
  const donorY = randomInt(0, CANVAS_H - PIECE_SIZE);
  const donorPng = await sharp(textured)
    .extract({ left: donorX, top: donorY, width: PIECE_SIZE, height: PIECE_SIZE })
    .png()
    .toBuffer();

  const mask = maskSvg();
  const outline = outlineSvg();

  // 拼图块：真实内容 + 白色描边，与遮罩取交集去掉凸起外溢的那半条线
  const piece = await sharp(regionPng)
    .composite([
      { input: outline, blend: 'over' },
      { input: mask, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();

  // 缺口：贴 donor 那一块，就这些 —— 不描边、不压暗（理由见上面 HOLE 那一段）
  const hole = await sharp(donorPng)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 第二层干扰压在最上面（横穿缺口边缘），所以它与下面这层是两次独立生成
  const background = await sharp(textured)
    .composite([
      { input: hole, left: answerX, top: pieceY },
      { input: interferenceSvg(), blend: 'over' },
    ])
    .png()
    .toBuffer();

  return { background, piece, answerX, pieceY };
}
