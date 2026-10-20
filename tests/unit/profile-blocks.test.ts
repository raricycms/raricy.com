import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZES,
  GRID_COLUMNS,
  MAX_BLOCKS,
  findFreeSpot,
  mobileSpan,
  normalizeBlocks,
  normalizeConfig,
  rectsOverlap,
} from '@/lib/profile-blocks';

// profile-blocks 是**零依赖的共享校验层**：编辑器与服务端 API 都跑它。
// 这里钉的是「哪些输入会被静默接受」—— 每一条都对应一个线上会出现的坏状态。

const text = (extra: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaaaaaa',
  kind: 'text',
  x: 0,
  y: 0,
  w: 2,
  h: 1,
  config: { title: '', text: '你好' },
  ...extra,
});

describe('normalizeBlocks 整页校验', () => {
  it('接受一份合法布局', () => {
    const r = normalizeBlocks([text(), text({ id: 'bbbbbbbbbbbb', x: 2 })]);
    expect(r.ok).toBe(true);
  });

  it('重叠必须拒绝 —— 否则其中一块永远看不见，用户会以为没保存', () => {
    const r = normalizeBlocks([text(), text({ id: 'bbbbbbbbbbbb', x: 1 })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('重叠');
  });

  it('尺寸只认四档白名单', () => {
    for (const s of BLOCK_SIZES) {
      expect(normalizeBlocks([text({ w: s.w, h: s.h, x: 0 })]).ok).toBe(true);
    }
    expect(normalizeBlocks([text({ w: 3, h: 1 })]).ok).toBe(false);
    expect(normalizeBlocks([text({ w: 2, h: 3 })]).ok).toBe(false);
  });

  it('超出右边界拒绝（x + w > 列数）', () => {
    expect(normalizeBlocks([text({ x: GRID_COLUMNS - 2 })]).ok).toBe(true);
    expect(normalizeBlocks([text({ x: GRID_COLUMNS - 1 })]).ok).toBe(false);
  });

  it('块数上限', () => {
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => text({ id: `id${i}xxxxxx`.slice(0, 12), x: 0, y: i }));
    expect(normalizeBlocks(many).ok).toBe(false);
  });

  it('重复 id 拒绝', () => {
    const r = normalizeBlocks([text(), text({ x: 2 })]);
    expect(r.ok).toBe(false);
  });

  it('未知块类型拒绝', () => {
    expect(normalizeBlocks([text({ kind: 'iframe' })]).ok).toBe(false);
  });
});

describe('normalizeConfig', () => {
  it('链接只收 http/https，且不带用户名密码', () => {
    expect(normalizeConfig('link', { url: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeConfig('link', { url: 'https://user:pass@evil.com' })).toBeNull();
    const ok = normalizeConfig('link', { url: 'https://example.com/a' });
    expect(ok).toMatchObject({ url: 'https://example.com/a', label: 'example.com' });
  });

  it('文字去控制字符、压空行、截断到 200', () => {
    const c = normalizeConfig('text', { text: `a\u0000b\n\n\n\nc${'x'.repeat(500)}` });
    expect(c).toBeTruthy();
    expect(String(c?.text).length).toBeLessThanOrEqual(200);
    expect(String(c?.text)).not.toContain('\u0000');
  });

  it('空的文字 / 图片 / 音频 / 文章一律不合法', () => {
    expect(normalizeConfig('text', { text: '   ' })).toBeNull();
    expect(normalizeConfig('image', {})).toBeNull();
    expect(normalizeConfig('audio', {})).toBeNull();
    expect(normalizeConfig('blog', {})).toBeNull();
  });
});

describe('网格算术', () => {
  it('rectsOverlap 边界相接不算重叠', () => {
    const a = { x: 0, y: 0, w: 2, h: 1 };
    expect(rectsOverlap(a, { x: 2, y: 0, w: 2, h: 1 })).toBe(false);
    expect(rectsOverlap(a, { x: 1, y: 0, w: 2, h: 1 })).toBe(true);
    expect(rectsOverlap(a, { x: 0, y: 1, w: 2, h: 1 })).toBe(false);
  });

  it('findFreeSpot 找第一个不重叠的位置', () => {
    expect(findFreeSpot([], 2, 1)).toEqual({ x: 0, y: 0 });
    expect(findFreeSpot([{ x: 0, y: 0, w: 4, h: 1 }], 2, 1)).toEqual({ x: 0, y: 1 });
    expect(findFreeSpot([{ x: 0, y: 0, w: 2, h: 1 }], 2, 1)).toEqual({ x: 2, y: 0 });
  });

  it('手机端宽 2 压两列，宽 1 保持一列', () => {
    expect(mobileSpan(1)).toBe(1);
    expect(mobileSpan(2)).toBe(2);
  });
});

describe('顺序即数组顺序', () => {
  // 手机端的显示顺序 = 保存时的数组顺序（服务端按下标写 profile_blocks.sort，
  // 见迁移 32）。所以 normalizeBlocks **不能**重排数组 —— 重排会让用户刚调好的
  // 上移 / 下移在保存后静默变回去。
  it('normalizeBlocks 原样保留输入顺序（哪怕 x/y 是反的）', () => {
    const r = normalizeBlocks([
      text({ id: 'aaaaaaaaaaaa', x: 0, y: 5 }),
      text({ id: 'bbbbbbbbbbbb', x: 2, y: 0 }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks.map((b) => b.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });
});
