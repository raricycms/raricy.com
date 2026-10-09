// ─────────────────────────────────────────────────────────────────────────────
// file-converter-pdf-layout.test.ts —— PDF 版面几何纯函数（零依赖）。
//
// 【为什么单测】这些算术决定「照片在 A4 上摆哪、多大」「重排哪些页丢了」——
// 错一位数不会报错，只会静默地把图摆歪 / 多丢一页。node 环境直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  PAGE_SIZES,
  MARGIN_POINTS,
  ZIP_PAGE_THRESHOLD,
  dpiScale,
  marginPoints,
  resolvePageBox,
  fitContain,
  shouldZipPages,
  estimateRasterBytes,
  parsePageOrder,
  orderNotices,
  splitRangeLines,
} from '@/lib/file-converter/engines/pdf-layout';

describe('dpiScale / marginPoints', () => {
  it('72 dpi = 1，144 dpi = 2', () => {
    expect(dpiScale(72)).toBe(1);
    expect(dpiScale(144)).toBe(2);
  });

  it('边距预设给点数，未知键回退常规', () => {
    expect(marginPoints('none')).toBe(0);
    expect(marginPoints('narrow')).toBe(18);
    expect(marginPoints('normal')).toBe(36);
    expect(marginPoints('whatever')).toBe(MARGIN_POINTS.normal);
  });
});

describe('resolvePageBox', () => {
  it('A4 + auto：方向跟着图片', () => {
    const wide = resolvePageBox({ pageSize: 'a4', orientation: 'auto', imageWidth: 1200, imageHeight: 800 });
    expect(wide.width).toBeCloseTo(PAGE_SIZES.a4.height, 5);
    expect(wide.height).toBeCloseTo(PAGE_SIZES.a4.width, 5);
    const tall = resolvePageBox({ pageSize: 'a4', orientation: 'auto', imageWidth: 800, imageHeight: 1200 });
    expect(tall.width).toBeCloseTo(PAGE_SIZES.a4.width, 5);
    expect(tall.height).toBeCloseTo(PAGE_SIZES.a4.height, 5);
  });

  it('显式方向覆盖图片比例', () => {
    const box = resolvePageBox({ pageSize: 'a4', orientation: 'landscape', imageWidth: 800, imageHeight: 1200 });
    expect(box.width).toBeCloseTo(PAGE_SIZES.a4.height, 5);
    expect(box.height).toBeCloseTo(PAGE_SIZES.a4.width, 5);
  });

  it('Letter 用 Letter 的尺寸', () => {
    const box = resolvePageBox({ pageSize: 'letter', orientation: 'auto', imageWidth: 800, imageHeight: 1200 });
    expect(box.width).toBeCloseTo(PAGE_SIZES.letter.width, 5);
    expect(box.height).toBeCloseTo(PAGE_SIZES.letter.height, 5);
  });

  it('original：1 像素 = 1 点，方向可翻转', () => {
    const asIs = resolvePageBox({ pageSize: 'original', orientation: 'auto', imageWidth: 800, imageHeight: 1200 });
    expect(asIs).toEqual({ width: 800, height: 1200 });
    const flipped = resolvePageBox({ pageSize: 'original', orientation: 'landscape', imageWidth: 800, imageHeight: 1200 });
    expect(flipped).toEqual({ width: 1200, height: 800 });
  });

  it('零尺寸输入不产出退化盒子', () => {
    const box = resolvePageBox({ pageSize: 'a4', orientation: 'auto', imageWidth: 0, imageHeight: 0 });
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});

describe('fitContain', () => {
  it('宽图缩到盒宽、上下居中', () => {
    const p = fitContain(1000, 500, 500, 800);
    expect(p.width).toBeCloseTo(500, 5);
    expect(p.height).toBeCloseTo(250, 5);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(275, 5);
  });

  it('高图缩到盒高、左右居中', () => {
    const p = fitContain(500, 1000, 500, 800);
    expect(p.width).toBeCloseTo(400, 5);
    expect(p.height).toBeCloseTo(800, 5);
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it('始终等比且不超出盒子', () => {
    const p = fitContain(1234, 777, 400, 400);
    expect(p.width).toBeLessThanOrEqual(400.0001);
    expect(p.height).toBeLessThanOrEqual(400.0001);
    expect(p.width / p.height).toBeCloseTo(1234 / 777, 6);
  });
});

describe('shouldZipPages', () => {
  it('恰好阈值不打包，超过才打包', () => {
    expect(shouldZipPages(ZIP_PAGE_THRESHOLD)).toBe(false);
    expect(shouldZipPages(ZIP_PAGE_THRESHOLD + 1)).toBe(true);
  });
});

describe('estimateRasterBytes', () => {
  it('按 dpi² 缩放（分辨率翻倍 → 像素四倍）', () => {
    const base = estimateRasterBytes({ pageCount: 1, dpi: 72, bytesPerPixel: 1 });
    const double = estimateRasterBytes({ pageCount: 1, dpi: 144, bytesPerPixel: 1 });
    expect(base).toBe(Math.round(PAGE_SIZES.a4.width * PAGE_SIZES.a4.height));
    expect(double / base).toBeCloseTo(4, 2);
  });

  it('页数线性累积且至少有 1 页', () => {
    const one = estimateRasterBytes({ pageCount: 0, dpi: 96, bytesPerPixel: 1 });
    const three = estimateRasterBytes({ pageCount: 3, dpi: 96, bytesPerPixel: 1 });
    expect(three / one).toBeCloseTo(3, 2);
  });
});

describe('parsePageOrder', () => {
  it('合法顺序原样保留', () => {
    expect(parsePageOrder('3,1,2', 3)).toEqual({
      sequence: [3, 1, 2],
      omitted: [],
      outOfRange: [],
      hasDuplicate: false,
    });
  });

  it('空 / 全非数字 → null（调用方回退或报错）', () => {
    expect(parsePageOrder('', 3)).toBeNull();
    expect(parsePageOrder('   ', 3)).toBeNull();
    expect(parsePageOrder('abc', 3)).toBeNull();
    expect(parsePageOrder('1,x,2', 3)).toBeNull();
  });

  it('未列出的页进 omitted、重复进 hasDuplicate', () => {
    const r = parsePageOrder('1,1,2', 3)!;
    expect(r.sequence).toEqual([1, 1, 2]);
    expect(r.omitted).toEqual([3]);
    expect(r.hasDuplicate).toBe(true);
  });

  it('越界页码忽略并记录，合法页仍保留', () => {
    const r = parsePageOrder('5,1', 3)!;
    expect(r.sequence).toEqual([1]);
    expect(r.omitted).toEqual([2, 3]);
    expect(r.outOfRange).toEqual([5]);
  });

  it('空白也可作分隔符', () => {
    const r = parsePageOrder(' 1 2 ', 3)!;
    expect(r.sequence).toEqual([1, 2]);
    expect(r.omitted).toEqual([3]);
  });
});

describe('orderNotices', () => {
  it('只对发生的损失出提示', () => {
    expect(orderNotices(parsePageOrder('3,1,2', 3)!)).toEqual([]);
    expect(orderNotices(parsePageOrder('1,1,2', 3)!)).toEqual([
      '未列出的 1 页已丢弃',
      '重复列出的页会重复输出',
    ]);
    expect(orderNotices(parsePageOrder('5,1', 3)!)).toEqual([
      '未列出的 2 页已丢弃',
      '1 个超出范围的页码已忽略',
    ]);
  });
});

describe('splitRangeLines', () => {
  it('按行拆段、丢空行、去首尾空白', () => {
    expect(splitRangeLines('1-3\n\n5\n 8- ')).toEqual(['1-3', '5', '8-']);
    expect(splitRangeLines('')).toEqual([]);
    expect(splitRangeLines('\n\n')).toEqual([]);
  });
});
