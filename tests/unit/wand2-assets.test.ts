// wand2 资产契约（最小恢复版）：render.ts 的 sprite() 用 naturalWidth/4 与 naturalHeight/rows
// 现算格子（world/character/attack 4×4，walkDown 单行 4 帧）。尺寸不整除、被引用格子为空、帧内容
// 贴边，都只表现为「草长得怪 / 角色错位 / 相邻帧串色」，不报错 —— 这里只守这三条，不比较像素内容。
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import layout from '../../public/static/games/wand2/sprite-layout.json';

const DIR = path.resolve(import.meta.dirname, '../../public/static/games/wand2');
const raw = (file: string) => sharp(path.join(DIR, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

describe('Wand 2 资产契约（sprite() 切格依据）', () => {
  it('图集尺寸整除 4、被引用的格子非空、walkDown 帧内容不贴边', async () => {
    const meta = (file: string) => sharp(path.join(DIR, file)).metadata();
    const [attack, character, world, walkDown] = await Promise.all(
      ['attack.webp', 'character.webp', 'world.webp', 'walk-down.webp'].map(meta)
    );
    expect([attack.width, attack.height]).toEqual([layout.attackCellSize * 4, layout.attackCellSize * 4]);
    expect([character.width, character.height]).toEqual([1024, 1024]);
    expect([world.width, world.height]).toEqual([1024, 1024]);
    expect(walkDown.height).toBe(256);
    expect([walkDown.width! % 4, walkDown.width! / 4]).toEqual([0, 256]);

    // makeGround/render 引用 world 第 4 行 col 0–3（碎石/灌木/小花/死亡帧）：空格子会画成透明块。
    const w = await raw('world.webp');
    for (const col of [0, 1, 2, 3]) {
      let visible = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        if (w.data[((3 * 256 + y) * w.info.width + col * 256 + x) * 4 + 3] > 0) visible++;
      }
      expect(visible, `world.webp 第 4 行第 ${col + 1} 格是空的`).toBeGreaterThan(100);
    }

    // 4 帧各留 4px 透明边距：内容越过帧边 = 相邻帧相互串色（换图/裁图时最容易踩）。
    const wd = await raw('walk-down.webp');
    const bleeding: string[] = [];
    for (let frame = 0; frame < 4; frame++) for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      if (!(x < 4 || x >= 252 || y < 4 || y >= 252)) continue;
      if (wd.data[(y * wd.info.width + frame * 256 + x) * 4 + 3] > 0) bleeding.push(`${frame}:${x},${y}`);
    }
    expect(bleeding.slice(0, 5), '帧边距内出现像素：内容越界 / 相邻帧会串色').toEqual([]);
  });
});
