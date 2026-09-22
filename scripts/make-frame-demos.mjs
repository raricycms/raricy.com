#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// make-frame-demos.mjs —— 生成几款**示例头像框** PNG，同时也是出图规格的活文档
//
// 用法：node scripts/make-frame-demos.mjs [输出目录]
//       默认写到 instance/frames/（gitignored 的运行时数据 —— 素材**不入库**）
//
// ── 【头像框 PNG 长什么样】──────────────────────────────────────────────────
//
// 一句话：**一个中间透明的「圆角方环」**。不是圆形。
//
// 为什么是圆角方形而不是圆形：`.avatar` 盒子是 `border-radius: 8%` 的圆角方形，
// 且 `overflow: hidden` —— 框贴在同尺寸的盒子里、会被这个形状裁掉。照圆形画的框，
// 四个角会**被裁掉**（而框上正好没有东西的地方被裁了，你还不一定看得出来）。
// 环的内孔也按 8% 圆角，环的粗细才是均匀的。
//
// 几条硬规格（graph：见 docs/guide/头像框使用指南.md）：
//   · **正方形**画布。规格是「画布就是框」：`object-fit: contain`，非正方形会留白。
//   · **必须带透明通道**（PNG-32）。中间不透明 = **盖住所有人的脸**，全站一起坏。
//   · **≥ 256×256**。它会缩到 **20px**（博客列表的作者头像）—— 画完缩到 20px 看一眼。
//   · **越界会被裁**。画布之外的东西（伸出去的翅膀）不显示。
//   · 边缘留白 = 0（框顶到画布边），否则小尺寸下框会缩进头像里侧、看着像没对齐。
//
// ── 【怎么改】──────────────────────────────────────────────────────────────
// 每款框就是一个返回 SVG 字符串的函数。改颜色 / 粗细 / 加装饰都在那里面。
// 画完务必看一眼 20px 下的样子：脚本会把每款缩小一份写到 *_preview-20px.png
// （**带 `_` 前缀 = 扫盘会跳过**，不会被当成可用的框）。
//
// ⚠️ 只认 PNG。本脚本用 sharp 把 SVG 光栅化成 PNG-32 —— 别改成直接输出 SVG：
//    框目录**没有任何上游校验**，而下发 SVG 就是同源存储型 XSS 的入口
//    （见 src/lib/frame-service.ts 的 ALLOWED_FRAME_MIME）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'instance', 'frames');

const SIZE = 256;
/** 与全站头像一致的圆角比例（docs/frontend-styles.md §4.1）。**别改这个数**。 */
const RADIUS_RATIO = 0.08;
/** 头像自己的圆角（画布四角上）—— 环的**外缘**必须正好落在它上面。 */
const OUTER_R = SIZE * RADIUS_RATIO;
/**
 * ★ 环的粗细上限就是 `OUTER_R`（画布的 8%），这是个**几何硬约束**，不是审美选择 ★
 *
 * 内外两条圆弧共享圆心，粗细才等于 `r_外 − r_内`。而 `r_内` 不能为负 —— 一旦
 * `width > OUTER_R`，内缘半径被夹到 0，环在**四角就变厚**（尖角），看着像画歪了。
 *
 * 换到实际尺寸上：8% 的上限意味着**在 20px 的头像上，环最粗只有 1.6px**。
 * 所以小尺寸下能区分的维度基本只剩**颜色** —— 别指望细节。
 */
const MAX_WIDTH = OUTER_R;

/** 具体色值取自 base/_root.scss 的品牌令牌；**深浅两个主题都要看得见**，所以用饱和中间调。 */
const BLUE = '#2563EB';
const VIOLET = '#8b5cf6';
const AMBER = '#f59e0b';
const CYAN = '#06b6d4';

/** 「鱼干蓝」专用：环的渐变两端 + 压在上面的浅蓝鱼身。 */
const DEEP_BLUE = '#1d4ed8';
const SKY = '#38bdf8';
const FISH_PALE = '#e0f2fe';

/**
 * 一个圆角方环（描边形式）。
 *
 * ── 【几何：外缘必须**正好**落在头像自己的圆角上】────────────────────────────
 * 描边以路径为中心向两侧各扩 width/2。要让外缘贴合画布那圈 8% 的圆角，中线半径
 * 得取 `R - width/2`（R = SIZE × 8%），**不是** `内缘半径 + width/2`。
 *
 * ⚠️ 写错成后者的话，外缘的圆角会**比头像的圆角更圆** —— 于是四个角上露出一小块
 *    没被框盖住的头像（在 120px 的个人主页大图上最明显）。那是个**看不出来源**的
 *    小缺口：不报错、也没有任何测试会红，只能靠眼睛发现。
 *
 * 均匀性：圆弧的圆心是**共享**的，所以粗细沿对角线也是 `r_外 − r_内 = width`，
 * 四角不会变胖 —— 前提是 `width ≤ R`（否则内缘半径被夹到 0，四角才开始变厚）。
 */
function ringPath(width, attrs = '') {
  const inset = width / 2;
  // 顶到上限也只到 MAX_WIDTH；超了就夹住并在下面那条注释里说明后果
  const w = Math.min(width, MAX_WIDTH);
  const rx = Math.max(0, OUTER_R - inset);
  return `<rect x="${inset}" y="${inset}" width="${SIZE - width}" height="${SIZE - width}"
            rx="${rx.toFixed(2)}" fill="none" stroke-width="${width}" ${attrs}/>`;
}

/** 四角的小方块装饰（缩到 20px 会糊掉 —— 那正是要展示的退化）。 */
function cornerOrnaments(color) {
  const s = 26; // 边长
  const m = 6; // 距画布边的距离
  const r = 7; // 自己的圆角
  return [
    [m, m],
    [SIZE - m - s, m],
    [m, SIZE - m - s],
    [SIZE - m - s, SIZE - m - s],
  ]
    .map(
      ([x, y]) =>
        `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="${color}" opacity="0.9"/>`
    )
    .join('\n  ');
}

/**
 * 一条小鱼干：椭圆身 + 三角尾 + 一只眼睛。画在原点、**朝 +x**，由 `angle` 转过去。
 *
 * 尺寸是刻意的：总长 20（-8..+12，含尾鳍）、身高 11（ry 5.5）；`scale` 由调用方
 * 按摆放处剩下的余量给（圆角方环的四个角上必须缩，见 fishOrnaments）。
 */
function fishOrnament(cx, cy, angle, scale, fill, eye) {
  return `<g transform="translate(${cx} ${cy}) rotate(${angle}) scale(${scale})">
    <ellipse cx="0" cy="0" rx="8" ry="5.5" fill="${fill}"/>
    <path d="M 6.5 0 L 12 -5 L 12 5 Z" fill="${fill}"/>
    <circle cx="-4" cy="-1.5" r="1.5" fill="${eye}"/>
  </g>`;
}

/**
 * 四角各摆一条鱼，**压在中线上、朝向沿对角线**。
 *
 * ── 【坐标是算出来的，不是手填的】────────────────────────────────────────────
 * 一个关键性质：环的中线圆角矩形，其四个角的**圆弧圆心恒在 (OUTER_R, OUTER_R)**
 * ——与环多粗无关（外缘永远贴画布 8% 圆角，内缘跟着内缩，圆心不动）。
 * 于是「圆弧中点」= 圆心 ± 半径/√2，「该点的切线方向」就是 45° 整数：
 *
 *     中线半径 r = OUTER_R − 环宽/2      中点离画布角 = OUTER_R − r/√2
 *
 * 手填坐标的话，改一次环宽四条鱼就全错位 —— 而且**看不出是错的**（鱼还压在环上，
 * 只是歪了一点点），只有拿尺子量才发现。
 *
 * ⚠️ **鱼必须缩着放（scale < 1）**，这不是审美选择：角上的环是**弧**，而鱼是**直线**
 *    的，两者的切线在弧的两端就对不上了 —— 鱼越长，尾巴越会甩到环外。
 *    最远的那点是尾鳍的外角（局部 (12, −5) 那一侧），它离画布圆角的外缘本来就只有
 *    几个像素。按环宽 16、scale 1 算，它会落到 y = −0.36 —— **画布之外，直接被裁掉**
 *    （表现为尾巴被齐齐切平，而且只在四个角上，很容易看漏）。
 *    缩到 0.8 时同一点回到距圆角圆心 19.07（外缘 20.48），余量 1.4px。
 */
function fishOrnaments(width, fill, eye, scale) {
  const r = OUTER_R - width / 2; // 中线圆角半径
  const d = r / Math.SQRT2; // 在 45° 方向上的投影
  const lo = OUTER_R - d; // 左上 / 左下（两轴同值）
  const hi = SIZE - OUTER_R + d; // 右下 / 右上
  // 角度按「顺时针游」排：左上是 ↗、右上是 ↘、右下是 ↙、左下是 ↖
  return [
    [lo, lo, -45],
    [hi, lo, 45],
    [hi, hi, 135],
    [lo, hi, 225],
  ]
    .map(([x, y, angle]) => fishOrnament(x, y, angle, scale, fill, eye))
    .join('\n  ');
}

/** 一款框 = 一个 SVG 字符串。改这里就是改框。 */
const FRAMES = {
  // ① 最基础的一款：单色实心环。20px 下也认得出，是「能用的下限」的参照。
  ring: `
  ${ringPath(20, `stroke="${BLUE}"`)}`,

  // ② 同一几何、换配色：渐变。展示「改配色就是另一款框」，零几何成本。
  gradient: `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${CYAN}"/>
      <stop offset="55%" stop-color="${BLUE}"/>
      <stop offset="100%" stop-color="${VIOLET}"/>
    </linearGradient>
  </defs>
  ${ringPath(20, `stroke="url(#g)"`)}`,

  // ③ 虚线环。中等尺寸好看，20px 下会糊成一条灰环 —— 刻意留着当反面参照。
  dashed: `
  ${ringPath(20, `stroke="${AMBER}" stroke-dasharray="21 14" stroke-linecap="round"`)}`,

  // ④ 细环 + 四角装饰。大尺寸（120px 主页）好看，20px 只剩环 —— 细节会丢。
  corner: `
  ${ringPath(13, `stroke="${VIOLET}"`)}
  ${cornerOrnaments(VIOLET)}`,

  // ⑤ 光晕：外侧一圈实线 + 内侧两圈递弱的宽描边。
  //    用三条同心描边而不是高斯模糊滤镜 —— librsvg 的滤镜支持因版本而异，
  //    而这三条是确定的，且缩到 20px 时正好退化成「一圈柔和的环」。
  glow: `
  ${ringPath(5, `stroke="${CYAN}"`)}
  ${ringPath(13, `stroke="${CYAN}" opacity="0.34"`)}
  ${ringPath(20, `stroke="${CYAN}" opacity="0.13"`)}`,

  // ⑥ 鱼干蓝：深→浅的蓝色环 + 一圈内侧高光 + 四角四条小鱼干。
  //    这是第一款**带装饰的实心环**：几何比 `corner` 厚一倍（16 vs 13），
  //    所以缩到 20px 时环还在、鱼糊成四小团浅色 —— 颜色（蓝）仍是主要识别手段。
  //    内侧高光用的是「贴着环内缘的一圈细描边」：hugInner 那条矩形以 16 为外缘、
  //    半径与环内缘同算法，于是它与环**共边**，不会露出一条缝。
  fishblue: `
  <defs>
    <linearGradient id="fb" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${DEEP_BLUE}"/>
      <stop offset="55%" stop-color="${BLUE}"/>
      <stop offset="100%" stop-color="${SKY}"/>
    </linearGradient>
  </defs>
  ${ringPath(16, `stroke="url(#fb)"`)}
  <rect x="16" y="16" width="${SIZE - 32}" height="${SIZE - 32}"
        rx="${(OUTER_R - 16).toFixed(2)}" fill="none" stroke="${SKY}" stroke-width="3" opacity="0.45"/>
  ${fishOrnaments(16, FISH_PALE, DEEP_BLUE, 0.8)}`,
};

function svgFor(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  ${body.trim()}
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [key, body] of Object.entries(FRAMES)) {
  const svg = Buffer.from(svgFor(body), 'utf8');

  // 正式的框：PNG-32（带 alpha）。sharp 从 SVG 光栅化默认就带 alpha。
  const out = path.join(OUT_DIR, `${key}.png`);
  await sharp(svg).png({ compressionLevel: 9 }).toFile(out);

  // 缩到 20px 的预览，给人眼看「小尺寸下还剩什么」。
  // ⚠️ `_` 前缀 = frame-service 的扫盘会跳过它（见 isSkippedName 那条规则），
  //    所以它不会被当成一款可用的框。
  await sharp(svg)
    .resize(20, 20, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(OUT_DIR, `_preview-20px-${key}.png`));

  const { size } = fs.statSync(out);
  console.log(`  ✓ ${key}.png  (${SIZE}×${SIZE}, ${size} 字节)  + _preview-20px-${key}.png`);
}

console.log(`\n已写入 ${OUT_DIR}`);
console.log('下一步：在 src/lib/frame-refs.ts 的 FRAME_KEYS / FRAMES 里登记这些 key。');
console.log('自查：npm run cli -- frame list --keys');
