// ─────────────────────────────────────────────────────────────────────────────
// chess-pieces.test.ts —— 静态检查：每枚棋子指向的 SVG 必须真实存在
//
// 【为什么要有】棋子是 <img> 挂上去的，所以「文件名写错」的后果是**全静默**的：
// SVG 404 不抛错、构建不报、tsc 不管（路径就是个字符串），页面上只多出一张裂图。
// 而棋子的文件名是被拼出来的（Chess_<字母><l|d>t45.svg），改名或改动拼接逻辑
// 都可能在**十二个文件里错一个** —— 这正是肉眼最容易漏掉、又最刺眼的那种错。
//
// 【范围】只钉三件事，都是判定干净的：
//   1. 六种兵种 × 两种颜色 = 12 条路径，全部命中 public/ 下真实存在的文件；
//   2. 这 12 条路径互不相同（拼接逻辑写错时常常是"全都指到同一个"）；
//   3. 空格子返回 null / 空串，中文名六种齐全。
// 不钉 SVG 的内容（那是第三方素材，我们不改它）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BISHOP,
  BLACK,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  WHITE,
  piece,
  type PieceType,
} from '@/lib/chess-rules';
import { pieceIconSrc, pieceName } from '@/app/components/chess-pieces';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** `/static/img/chess/x.svg` → `public/static/img/chess/x.svg`（Next 把 public/ 挂到根）。 */
function onDisk(src: string): string {
  return path.join(ROOT, 'public', src.replace(/^\//, ''));
}

const TYPES: PieceType[] = [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING];
const COLORS = [WHITE, BLACK] as const;

describe('棋子的图形路径', () => {
  it('六种兵种 × 两种颜色都有对应文件，且文件真实存在', () => {
    for (const type of TYPES) {
      for (const color of COLORS) {
        const src = pieceIconSrc(piece(color, type));
        expect(src, `${color === WHITE ? '白' : '黑'}${type} 没有图形路径`).toBeTruthy();
        expect(fs.existsSync(onDisk(src!)), `${src} 在 public/ 下不存在`).toBe(true);
      }
    }
  });

  it('12 条路径互不相同（拼接写错时常常是全都指到同一个文件）', () => {
    const all = TYPES.flatMap((t) => COLORS.map((c) => pieceIconSrc(piece(c, t))));
    expect(new Set(all).size).toBe(12);
  });

  it('白 = l(light)、黑 = d(dark)：写反了 12 条路径照样互不相同，只有肉眼能发现', () => {
    // 上游的文件名口径是 Chess_<兵种字母><l|d>t45.svg（l = light = 白子）。
    // 把 l/d 写反不会触发上面任何一条断言 —— 文件都在、路径也仍然两两不同，
    // 只是整盘棋的黑白颠倒。故这里直接把两个端点钉死。
    expect(pieceIconSrc(piece(WHITE, KING))).toBe('/static/img/chess/Chess_klt45.svg');
    expect(pieceIconSrc(piece(BLACK, KING))).toBe('/static/img/chess/Chess_kdt45.svg');
  });

  it('空格子没有图形、也没有名字', () => {
    expect(pieceIconSrc(0)).toBeNull();
    expect(pieceName(0)).toBe('');
  });

  it('中文名与颜色都对得上（读屏靠它，字形退休后这是唯一的棋子名）', () => {
    const expectNames: Array<[number, string]> = [
      [piece(WHITE, PAWN), '白兵'],
      [piece(BLACK, PAWN), '黑兵'],
      [piece(WHITE, KNIGHT), '白马'],
      [piece(BLACK, BISHOP), '黑象'],
      [piece(WHITE, ROOK), '白车'],
      [piece(BLACK, QUEEN), '黑后'],
      [piece(WHITE, KING), '白王'],
      [piece(BLACK, KING), '黑王'],
    ];
    for (const [cell, name] of expectNames) {
      expect(pieceName(cell), `cell=${cell}`).toBe(name);
    }
  });
});
