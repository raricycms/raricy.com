// ─────────────────────────────────────────────────────────────────────────────
// puzzle-image.ts — 滑块题型：用 sharp 生成背景 + 缺口 + 拼图块。
//
// 底图与干扰层在 canvas.ts（与点选共用）—— 两个题型的底图必须一致，
// 否则「哪个更难」的对比全来自底图差异。
//
// ── 加固：断掉模板匹配 ──────────────────────────────────────────────────────
//
// 最初把缺口做成「拼图块自己的像素压暗 30% 贴回去」。那是**白送**：缺口与拼图块是
// 同一块像素，两图互相关当场算出答案。现在：
//
//   1. 底图有高频结构（canvas.ts 的分形场）—— 前提，不是装饰，理由见那边。
//   2. 缺口填的是**别处**的一块真实像素（donor）：纹理在（真人也需要它来对齐），
//      但原件内容在整张图上**不存在了**，模板匹配无处可去。
//      ⚠️ 别退回「把本区域水平翻转」：镜像与原件共享同一批像素，攻击者拿
//      flip(piece) 去匹配就能反推出来。
//   3. 两层干扰（随机曲线 + 点）压在图上，其中一层**横穿缺口的边缘**。
//   4. 拼图块本身加白色描边 —— 缺口那块内容被换掉了，描边让真人还能一眼看清
//      自己拖的是哪一块（这是补偿，不是加密）。**只有拼图块有描边，缺口没有。**
//
// ── 三次试错的记录（别再走一遍） ─────────────────────────────────────────────
//
//   · 缺口与拼图块**共用白色实线描边** ⇒ 等于盖了个精确的模板标记。逐点 SSD 把真答案
//     稳定排在第 1 名、分数带窄得反常（28349 vs 31000+）—— 匹配没在找内容，
//     是在**对齐那条描边**。
//   · 缺口改**虚线琥珀描边**能打断匹配，但更糟：那等于用颜色给目标打了个高亮，
//     攻击者按色相阈值取连通域即可，比模板匹配还省事 —— 题目还变简单了。
//   · 缺口改**压暗**（brightness 0.42）则反向泄漏：压暗制造恒定亮度偏移，于是
//     **匹配最差**的位置就是真答案（6/6 排在第 277/277 名），取 argmax 即可。
//
//   现在：不描边、不压暗，缺口只是一块「内容跟四周接不上」的像素。实测 8 轮，
//   真答案中位排名 **235/277**（随机期望 139），比分比最佳候选差 4%~28% ——
//   既不在第 1、也不在最后，naive 模板匹配不再收敛。
//
// ── 诚实的边界 ──────────────────────────────────────────────────────────────
//
// ⚠️ **这不等于缺口不可定位。** 它终究是一块「贴上去的」内容，与四周在边界处有断差，
//   专门找「局部统计异常 / 接缝」的方法照样能找到（235 而非 139 那个偏差就是证据）。
//   **缺口的可见性与可定位性是同一件事** —— 滑块的位置侧只能抬高成本、封不死。
//   位置想真正硬，得换题型：点选（click-image.ts）没有可对齐的形状。
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import { CANVAS_W, CANVAS_H, svg, buildBackground, interferenceSvg } from './canvas';

export { CANVAS_W, CANVAS_H };

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
 * 形状的 markup。**遮罩与拼图块描边共用同一份** —— 两处一旦不一致，描边就套不准
 * 拼图块，而症状只是「这题看着有点歪」，不报错。
 *
 * ⚠️ 缺口**不用**这个形状加描边（那正是上面记的第一个试错），它只用 maskSvg 定形状。
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

/** 遮罩：只有它决定形状的 alpha。凸起圆心压在边上、半径 8，正好顶到 64 的边界。 */
const maskSvg = (): Buffer => svg(PIECE_SIZE, PIECE_SIZE, shapeMarkup('fill="#fff"'));

/** 拼图块的描边：**实线白边，只给拼图块**（理由见文件头）。 */
const outlineSvg = (): Buffer =>
  svg(
    PIECE_SIZE,
    PIECE_SIZE,
    shapeMarkup('fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2"')
  );

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

  // 缺口的填充料取自**别处**的一块真实像素（水平错开半个画布，两个补丁必然不重叠）
  const donorX = (answerX + Math.floor((CANVAS_W - PIECE_SIZE) / 2)) % (CANVAS_W - PIECE_SIZE);
  const donorY = randomInt(0, CANVAS_H - PIECE_SIZE);
  const donorPng = await sharp(textured)
    .extract({ left: donorX, top: donorY, width: PIECE_SIZE, height: PIECE_SIZE })
    .png()
    .toBuffer();

  const mask = maskSvg();

  // 拼图块：真实内容 + 白色描边，与遮罩取交集去掉凸起外溢的那半条线
  const piece = await sharp(regionPng)
    .composite([
      { input: outlineSvg(), blend: 'over' },
      { input: mask, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();

  // 缺口：贴 donor 那一块，就这些 —— 不描边、不压暗
  const hole = await sharp(donorPng)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 第二层干扰压在最上面（横穿缺口边缘），所以它与第一层是两次独立生成
  const background = await sharp(textured)
    .composite([
      { input: hole, left: answerX, top: pieceY },
      { input: interferenceSvg(), blend: 'over' },
    ])
    .png()
    .toBuffer();

  return { background, piece, answerX, pieceY };
}
