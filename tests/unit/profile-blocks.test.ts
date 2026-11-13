import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZES,
  GRID_COLUMNS,
  MAX_BLOCKS,
  normalizeBlocks,
  normalizeConfig,
  sanitizeInline,
  sanitizeText,
} from '@/lib/profile-blocks';

// profile-blocks 是**零依赖的共享校验层**：编辑器与服务端 API 都跑它。
// 这里钉的是「哪些输入会被静默接受」—— 每一条都对应一个线上会出现的坏状态：
// 整页校验（重叠 / 白名单 / 上限 / 越界 / 重复 id）与配置净化（链接 scheme、
// 文字控制字符与码点截断）。手机端投影与拖动几何属排版算术，已按精简口径删除。

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

  it('截断按码点，不切出孤立代理项（emoji 占两个 UTF-16 码元）', () => {
    // 旧实现用 slice(0, max)（码元）：max=5、三个 emoji 共 6 码元，会切在第三个
    // emoji 的代理对中间、产出孤立高位代理。按码点截断后只可能得到完整字符。
    const out = sanitizeInline('🐟🐟🐟', 5);
    expect(out).toBe('🐟🐟🐟'); // 3 个码点 ≤ 5，一个都不该丢
    expect(out).toBe(Array.from(out).join('')); // 无孤立代理
    expect(sanitizeInline('🐟🐟🐟🐟', 3)).toBe('🐟🐟🐟');
    expect(sanitizeText('a🐟b🐟c', 3)).toBe('a🐟b'); // 多行版同一判据
  });

  it('空的文字 / 图片 / 音频 / 文章一律不合法', () => {
    expect(normalizeConfig('text', { text: '   ' })).toBeNull();
    expect(normalizeConfig('image', {})).toBeNull();
    expect(normalizeConfig('audio', {})).toBeNull();
    expect(normalizeConfig('blog', {})).toBeNull();
  });
});

describe('normalizeBlocks 原样保留输入顺序', () => {
  // 它只校验、不重排：布局顺序的唯一来源是桌面坐标 (x, y)，手机顺序再由投影得出。
  // 重排数组反而会让「保存请求里的第几块」与调用方对不上（id 也对不上）。
  it('哪怕 x/y 是反的也不动数组', () => {
    const r = normalizeBlocks([
      text({ id: 'aaaaaaaaaaaa', x: 0, y: 5 }),
      text({ id: 'bbbbbbbbbbbb', x: 2, y: 0 }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks.map((b) => b.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });
});
