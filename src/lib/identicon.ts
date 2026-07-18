// ─────────────────────────────────────────────────────────────────────────────
// identicon.ts — 原生 GitHub 风格点阵头像（SVG）
//
// 对齐 Flask 侧 app/utils/avatar_generator.py 的算法，但输出 SVG 而非 PNG（无需 Pillow）：
//   • md5(seed) → 前 6 位 hex 决定前景色 (r,g,b)
//   • 8×8 网格，左半列由后续 hex 位的奇偶决定是否填充，右半列镜像对称
//   • 背景 (240,240,240)，与 Flask 一致
//
// 纯函数、确定性：相同 seed（用户 id）永远得到相同头像，与 Flask 生成结果的图案一致。
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

  // 构建对称网格（与 Flask 的填充顺序一致）
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

  const block = size / GRID_SIZE;
  const rects: string[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      if (grid[row][col]) {
        const x = col * block;
        const y = row * block;
        rects.push(`<rect x="${x}" y="${y}" width="${block}" height="${block}"/>`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="identicon">` +
    `<rect width="${size}" height="${size}" fill="${BG}"/>` +
    `<g fill="${fg}">${rects.join('')}</g>` +
    `</svg>`
  );
}
