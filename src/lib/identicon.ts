// ─────────────────────────────────────────────────────────────────────────────
// identicon.ts — 原生 GitHub 风格点阵头像（SVG）
//
// 输出 SVG 而非 PNG（矢量，不必引入位图处理库），算法如下：
//   • md5(seed) → 前 6 位 hex 决定前景色 (r,g,b)
//   • 8×8 网格，左半列由后续 hex 位的奇偶决定是否填充，右半列镜像对称
//   • 背景 (240,240,240) —— 改则存量用户头像图案全变
//
// 纯函数、确定性：相同 seed（用户 id）永远得到相同头像，且图案与存量头像一致。
//
// 【★ 填色的格子合成一条 <path>，不能一格一枚 <rect> ★】
// 一枚 rect 的每条边都是一条独立的抗锯齿边界。格子边长 25（SVG 单位），而头像总要被
// 缩放到非 200px 的显示尺寸（博客列表 20、讨论 36、名片 1.4em …），于是
// **25 × 缩放比几乎永远不是整数**：相邻两格各自的半覆盖边缘像素独立合成，得到
// 0.5 + 0.5×(1−0.5) = 75% 不透明度 —— 接缝处就是一条比前景浅的线，浅到接近背景色时
// 看着就是「方块之间夹着白缝」。
// 实测（判据：只统计「连同 3×3 邻域都落在填色格内部」的设备像素 —— 那些像素按定义
// 必须是纯前景色，任何偏差就一定是接缝）：
//   · 浏览器 Skia：26 个常见显示尺寸里 16 个有缝，接缝像素只有 75% 不透明度（≈ 0.25
//     的背景混进来，偏差最大 72/255）；干净的恰好只有 24/32/40/48/56/64/80/96/120/200
//     这些「格子落在整数设备像素上」的尺寸。
//   · 画报走的 librsvg：60 个「尺寸 × seed」组合里 30 个有缝，且偏差与尺寸无关地更重。
// 合成一条 path 之后两边都归零（Skia 只剩 ±1 的舍入噪声），图案本身一格未变。
// 外轮廓的抗锯齿**保留**（那是正常且想要的），所以别改用
// shape-rendering="crispEdges" 去一刀切掉抗锯齿。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

const GRID_SIZE = 8;
const BG = 'rgb(240,240,240)';

/** 由 seed 生成确定性的 GitHub 风格 identicon SVG 字符串。 */
export function generateIdenticonSvg(seed: string, size = 200): string {
  const hex = createHash('md5').update(seed, 'utf8').digest('hex'); // 32 位 hex

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const fg = `rgb(${r},${g},${b})`;

  // 构建对称网格（填充顺序固定 —— 改了同一 seed 的头像图案就变）
  const grid: boolean[][] = Array.from({ length: GRID_SIZE }, () =>
    new Array<boolean>(GRID_SIZE).fill(false)
  );
  const half = Math.floor((GRID_SIZE + 1) / 2);
  let hashIndex = 6;
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < half; col++) {
      if (parseInt(hex[hashIndex], 16) % 2 === 0) {
        grid[row][col] = true;
        grid[row][GRID_SIZE - 1 - col] = true;
      }
      hashIndex = (hashIndex + 1) % hex.length;
    }
  }

  // 一条 path、每个填色格子一个方形子路径（文件头讲了为什么不是一枚枚 rect）
  const block = size / GRID_SIZE;
  const path: string[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      if (grid[row][col]) {
        path.push(`M${col * block} ${row * block}h${block}v${block}h-${block}z`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="identicon">` +
    `<rect width="${size}" height="${size}" fill="${BG}"/>` +
    `<path fill="${fg}" d="${path.join('')}"/>` +
    `</svg>`
  );
}
