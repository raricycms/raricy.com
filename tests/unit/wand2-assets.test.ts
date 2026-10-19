import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import layout from '../../public/static/games/wand2/sprite-layout.json';

const dir = path.resolve('public/static/games/wand2');
const read = (file: string) => sharp(path.join(dir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
type Pixels = Awaited<ReturnType<typeof read>>;
let attack: Pixels, body: Pixels, character: Pixels, original: Pixels, walkDown: Pixels;
const pixel = (image: Pixels, x: number, y: number) => image.data.subarray((y * image.info.width + x) * 4, (y * image.info.width + x) * 4 + 4);

beforeAll(async () => {
  [attack, body, character, original, walkDown] = await Promise.all([
    read('attack.webp'), read('attack-body.webp'), read('character.webp'), read('source/character-original.webp'), read('walk-down.webp'),
  ]);
});

describe('Wand 2 精灵资源', () => {
  it('实际文件尺寸符合游戏切格，攻击留白不改变角色表规格', () => {
    expect([attack.info.width, attack.info.height]).toEqual([1536, 1536]);
    expect([body.info.width, body.info.height]).toEqual([1536, 1536]);
    expect([character.info.width, character.info.height]).toEqual([1024, 1024]);
  });

  it('向下步行条的四帧能独立切出，保留边距，并同步角色表中的左右步', () => {
    expect([walkDown.info.width, walkDown.info.height]).toEqual([1024, 256]);
    const changed = [0, 0, 0, 0];
    let edgePixels = 0, mismatched = 0;
    for (let frame = 0; frame < 4; frame++) for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const p = pixel(walkDown, frame * 256 + x, y);
      if ((x < 4 || x >= 252 || y < 4 || y >= 252) && p[3] > 0) edgePixels++;
      const next = pixel(walkDown, (frame + 1) % 4 * 256 + x, y);
      if (p[3] !== next[3] || p[3] > 0 && !p.equals(next)) changed[frame]++;
      if (frame !== 0 && frame !== 2) continue;
      const inCharacter = pixel(character, (frame === 0 ? 1 : 2) * 256 + x, y);
      if (inCharacter[3] !== p[3] || p[3] > 0 && !inCharacter.equals(p)) mismatched++;
    }
    expect(edgePixels).toBe(0);
    expect(mismatched).toBe(0);
    for (const count of changed) expect(count).toBeGreaterThan(100);
  });

  it('攻击的所有实际切格均有透明边距，剑、鞋和剑光不跨格或被裁切', () => {
    const cell = layout.attackCellSize, gutter = layout.gutter;
    const touching: string[] = [];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
      let count = 0, visible = 0;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const alpha = pixel(attack, col * cell + x, row * cell + y)[3];
        if (alpha > 0) visible++;
        if ((x < gutter || x >= cell - gutter || y < gutter || y >= cell - gutter) && alpha > 0) count++;
      }
      if (count) touching.push(`${row + 1},${col + 1}: ${count}`);
      expect(visible).toBeGreaterThan(1000);
    }
    expect(touching).toEqual([]);
  });

  it('每把剑的握点落在人物的实心拳头上，最终成图保留握点的手指', () => {
    const cell = layout.attackCellSize;
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
      const [hx, hy] = layout.attack[row].poses[col].hand;
      const fist = pixel(body, col * cell + hx, row * cell + hy);
      expect(fist[3]).toBeGreaterThan(240);
      expect(fist[0]).toBeGreaterThan(120);
      expect(fist[0]).toBeGreaterThan(fist[1] * 1.05);
      const grip = pixel(attack, col * cell + hx, row * cell + hy);
      expect(grip[3]).toBeGreaterThanOrEqual(fist[3]);
      // 源图掌心也有少量透明度，叠到剑柄上会出现约 1–2 级颜色变化。
      for (let c = 0; c < 3; c++) expect(Math.abs(grip[c] - fist[c])).toBeLessThanOrEqual(3);
    }
  });

  it('步态与鞋子修补只改变登记区域，其余可见像素和透明度保持原样', () => {
    let outsideChanges = 0;
    const patchChanges = layout.characterPatches.map(() => 0);
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
      const a = pixel(character, x, y), b = pixel(original, x, y);
      // WebP 可重写全透明像素中不可见的 RGB，不视为画面变化。
      if (a[3] === b[3] && (a[3] === 0 || a.equals(b))) continue;
      const index = layout.characterPatches.findIndex(p => {
        const [left, top, width, height] = p.region;
        return x >= p.col * 256 + left && x < p.col * 256 + left + width
          && y >= p.row * 256 + top && y < p.row * 256 + top + height;
      });
      if (index < 0) outsideChanges++; else patchChanges[index]++;
    }
    expect(outsideChanges).toBe(0);
    for (const changed of patchChanges) expect(changed).toBeGreaterThan(100);
  });
});
