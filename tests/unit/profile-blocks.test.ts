import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZES,
  GRID_COLUMNS,
  MAX_BLOCKS,
  MOBILE_COLUMNS,
  MOBILE_HALF,
  findFreeSpot,
  mobileColumn,
  mobileNeighbors,
  mobileOrder,
  moveInMobileOrder,
  moveToOtherHalf,
  normalizeBlocks,
  normalizeConfig,
  projectMobile,
  rectsOverlap,
  swapBlockPositions,
} from '@/lib/profile-blocks';

// profile-blocks 是**零依赖的共享校验层**：编辑器与服务端 API 都跑它。
// 这里钉的是「哪些输入会被静默接受」—— 每一条都对应一个线上会出现的坏状态。
//
// 2026-10 起手机端不再是「另一套按保存顺序流式排」的布局，而是桌面 4 列布局的
// **投影**（projectMobile）：宽 ≥2 通栏、宽 1 看左右半、按桌面阅读顺序 (y,x) 紧排。
// 手机上的拖动 / 左右移 / 上下移改的都是桌面坐标。所以这里不再有「数组顺序即手机
// 顺序」的契约 —— 投影的结果是两端唯一的摆放依据。

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
});

// ── 手机两列的投影 ────────────────────────────────────────────────────────────
//
// 这些用例就是「4 列和 2 列怎么对齐」的可执行答案：两列桌面 = 一列手机；宽块通栏；
// 顺序 = 桌面阅读顺序。投影跑错时页面照常渲染、不报任何错，只是手机上的顺序 / 列
// 归属与桌面不一致 —— 所以每条都要钉住。

describe('mobileColumn：宽 ≥2 通栏，宽 1 按左右半归列', () => {
  it('宽 2 一律通栏，哪怕摆在桌面第 2–3 列（跨中线）', () => {
    expect(mobileColumn({ x: 0, w: 2 })).toEqual({ x: 0, w: 2 });
    expect(mobileColumn({ x: 1, w: 2 })).toEqual({ x: 0, w: 2 });
    expect(mobileColumn({ x: 2, w: 2 })).toEqual({ x: 0, w: 2 });
  });

  it('宽 1 看落哪一半：x < 2 左列、x ≥ 2 右列', () => {
    expect(MOBILE_HALF).toBe(2);
    expect(mobileColumn({ x: 0, w: 1 })).toEqual({ x: 0, w: 1 });
    expect(mobileColumn({ x: 1, w: 1 })).toEqual({ x: 0, w: 1 });
    expect(mobileColumn({ x: 2, w: 1 })).toEqual({ x: 1, w: 1 });
    expect(mobileColumn({ x: 3, w: 1 })).toEqual({ x: 1, w: 1 });
  });
});

describe('projectMobile：按桌面阅读顺序 (y, x) 紧排', () => {
  it('宽 1 的块落在对应的手机列，同一行左右并排', () => {
    const projected = projectMobile([
      { id: 'a', x: 1, y: 0, w: 1, h: 1 }, // 桌面左半
      { id: 'b', x: 2, y: 0, w: 1, h: 1 }, // 桌面右半
      { id: 'c', x: 0, y: 1, w: 1, h: 1 },
    ]);
    expect(projected).toEqual([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 1, y: 0, w: 1, h: 1 },
      // 左列 y=0 已被 a 占着 → 往下落到第二行
      { x: 0, y: 1, w: 1, h: 1 },
    ]);
  });

  it('宽 2 / 2×2 在手机上通栏，跨中线的摆法也不例外', () => {
    const projected = projectMobile([
      { id: 'wide', x: 1, y: 0, w: 2, h: 1 }, // 跨中线 2×1
      { id: 'large', x: 2, y: 1, w: 2, h: 2 }, // 2×2
    ]);
    expect(projected).toEqual([
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 0, y: 1, w: 2, h: 2 },
    ]);
  });

  it('桌面上刻意留的空行在手机上不保留（只关心顺序，不关心空位）', () => {
    const projected = projectMobile([
      { id: 'a', x: 0, y: 5, w: 2, h: 1 },
      { id: 'b', x: 2, y: 9, w: 2, h: 1 },
    ]);
    expect(projected).toEqual([
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 0, y: 1, w: 2, h: 1 },
    ]);
  });

  it('按 (y, x) 排序，数组顺序不参与；投影结果与输入同序（按下标对齐）', () => {
    const projected = projectMobile([
      // 数组里 B 在前、A 在后，但桌面阅读顺序是 A（y=0）先
      { id: 'b', x: 0, y: 1, w: 2, h: 1 },
      { id: 'a', x: 0, y: 0, w: 2, h: 1 },
    ]);
    expect(projected).toEqual([
      { x: 0, y: 1, w: 2, h: 1 },
      { x: 0, y: 0, w: 2, h: 1 },
    ]);
  });

  it('后面来的窄块可以补进前面高块旁边留出的洞里', () => {
    const projected = projectMobile([
      { id: 'tall', x: 0, y: 0, w: 1, h: 2 }, // 左列占两行
      { id: 'right', x: 3, y: 1, w: 1, h: 1 }, // 按阅读顺序在后，但右列第 0 行空着
    ]);
    expect(projected).toEqual([
      { x: 0, y: 0, w: 1, h: 2 },
      { x: 1, y: 0, w: 1, h: 1 },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(projectMobile([])).toEqual([]);
  });
});

describe('mobileOrder / mobileNeighbors', () => {
  const blocks = [
    { id: 'a', x: 0, y: 0, w: 1, h: 1 }, // 手机左列第 0 行
    { id: 'b', x: 3, y: 0, w: 1, h: 1 }, // 手机右列第 0 行
    { id: 'c', x: 0, y: 1, w: 1, h: 1 }, // 手机左列第 1 行
  ];

  it('mobileOrder 是投影后的行优先序（读屏 / DOM 顺序）', () => {
    expect(mobileOrder(blocks)).toEqual(['a', 'b', 'c']);
  });

  it('上下邻居只在同一列里找 —— 不会去换隔壁列那块', () => {
    // c 的同列上一块是 a，不是桌面上与 a 同一行的 b
    expect(mobileNeighbors(blocks, 'c')).toEqual({ prev: 'a', next: null });
    expect(mobileNeighbors(blocks, 'a')).toEqual({ prev: null, next: 'c' });
    expect(mobileNeighbors(blocks, 'b')).toEqual({ prev: null, next: null });
    expect(mobileNeighbors(blocks, '不存在')).toEqual({ prev: null, next: null });
  });

  it('宽块之间按通栏对通栏找邻居', () => {
    const wide = [
      { id: 'w1', x: 0, y: 0, w: 2, h: 1 },
      { id: 'w2', x: 2, y: 1, w: 2, h: 1 },
    ];
    expect(mobileNeighbors(wide, 'w2')).toEqual({ prev: 'w1', next: null });
  });
});

describe('swapBlockPositions：只换位置，尺寸不动', () => {
  it('两块换位成功', () => {
    const out = swapBlockPositions(
      [
        { id: 'a', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', x: 2, y: 0, w: 2, h: 1 },
      ],
      'a',
      'b'
    );
    expect(out).toEqual([
      { id: 'a', x: 2, y: 0, w: 1, h: 1 },
      { id: 'b', x: 0, y: 0, w: 2, h: 1 },
    ]);
  });

  it('同 id / 不存在 id 一律返回 null（调用方保持原样）', () => {
    const blocks = [{ id: 'a', x: 0, y: 0, w: 1, h: 1 }];
    expect(swapBlockPositions(blocks, 'a', 'a')).toBeNull();
    expect(swapBlockPositions(blocks, 'a', 'nope')).toBeNull();
    expect(swapBlockPositions(blocks, 'nope', 'a')).toBeNull();
  });

  it('换完会压到第三块时返回 null —— 不自作主张找空位', () => {
    // A 2×2 在左、B 宽 2 在右上、C 宽 2 在右下：A 与 B 换位后 A 会盖住 C
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 2, h: 2 },
      { id: 'b', x: 2, y: 0, w: 2, h: 1 },
      { id: 'c', x: 2, y: 1, w: 2, h: 1 },
    ];
    expect(swapBlockPositions(blocks, 'a', 'b')).toBeNull();
  });
});

describe('moveToOtherHalf：宽 1 的块换到另一半', () => {
  it('目标格空着就直接搬过去', () => {
    const out = moveToOtherHalf([{ id: 'a', x: 0, y: 0, w: 1, h: 1 }], 'a');
    expect(out).toEqual([{ id: 'a', x: 2, y: 0, w: 1, h: 1 }]);
  });

  it('目标格被占时先与那一块换位', () => {
    const out = moveToOtherHalf(
      [
        { id: 'a', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', x: 2, y: 0, w: 1, h: 1 },
      ],
      'a'
    );
    expect(out).toEqual([
      { id: 'a', x: 2, y: 0, w: 1, h: 1 },
      { id: 'b', x: 0, y: 0, w: 1, h: 1 },
    ]);
  });

  it('宽 ≥2 是通栏，没有左右可言 → null（调用方置灰按钮）', () => {
    expect(moveToOtherHalf([{ id: 'a', x: 1, y: 0, w: 2, h: 1 }], 'a')).toBeNull();
  });

  it('换位会压到第三块时，在目标半区里往下找空位', () => {
    // A 在左；右半被 B（2×2）占满两行；C 让 A↔B 换位失效（B 换到左边会压住 C）。
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 1, h: 1 },
      { id: 'b', x: 2, y: 0, w: 2, h: 2 },
      { id: 'c', x: 0, y: 1, w: 1, h: 1 },
    ];
    const out = moveToOtherHalf(blocks, 'a');
    expect(out).not.toBeNull();
    const a = out!.find((b) => b.id === 'a')!;
    expect([a.x, a.y]).toEqual([2, 2]);
  });

  it('不存在的 id → null', () => {
    expect(moveToOtherHalf([{ id: 'a', x: 0, y: 0, w: 1, h: 1 }], 'nope')).toBeNull();
  });
});

describe('moveInMobileOrder：与同列相邻块换位', () => {
  it('上移与同列上一块交换桌面坐标', () => {
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 1, h: 1 },
      { id: 'b', x: 3, y: 0, w: 1, h: 1 },
      { id: 'c', x: 0, y: 1, w: 1, h: 1 },
    ];
    const out = moveInMobileOrder(blocks, 'c', -1);
    expect(out).toEqual([
      { id: 'a', x: 0, y: 1, w: 1, h: 1 },
      { id: 'b', x: 3, y: 0, w: 1, h: 1 },
      { id: 'c', x: 0, y: 0, w: 1, h: 1 },
    ]);
  });

  it('同列没有上一块 / 下一块时返回 null', () => {
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 1, h: 1 },
      { id: 'b', x: 3, y: 0, w: 1, h: 1 },
    ];
    expect(moveInMobileOrder(blocks, 'a', -1)).toBeNull();
    expect(moveInMobileOrder(blocks, 'a', 1)).toBeNull();
  });

  it('换位会压到第三块时返回 null（不静默挪位）', () => {
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 1, h: 2 },
      { id: 'b', x: 0, y: 2, w: 1, h: 1 },
      { id: 'c', x: 0, y: 3, w: 2, h: 1 },
    ];
    // a 下移到 b 的位置会占满第 2–3 行，压住第 3 行的 c
    expect(moveInMobileOrder(blocks, 'b', -1)).toBeNull();
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

// 手机网格的列数是 2 —— 投影里所有 w 的上限都读它，别在别处再写死一遍。
it('手机列数是 2', () => {
  expect(MOBILE_COLUMNS).toBe(2);
});
