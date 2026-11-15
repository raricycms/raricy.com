// ─────────────────────────────────────────────────────────────────────────────
// file-converter-pdf-layout.test.ts —— PDF 版面里**数据**那一面（零依赖）。
//
// 保留页序解析与丢页提示、打包阈值：错了会静默地多丢一页或让用户看不到原因。
// dpi / 边距 / fitContain / 体积估算属几何算术，按测试精简口径已删除。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  ZIP_PAGE_THRESHOLD,
  shouldZipPages,
  parsePageOrder,
  orderNotices,
  splitRangeLines,
} from '@/lib/file-converter/engines/pdf-layout';

describe('shouldZipPages', () => {
  it('恰好阈值不打包，超过才打包', () => {
    expect(shouldZipPages(ZIP_PAGE_THRESHOLD)).toBe(false);
    expect(shouldZipPages(ZIP_PAGE_THRESHOLD + 1)).toBe(true);
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
  it('只对发生的损失出提示（丢页 / 重复 / 越界各一条，无损时为空）', () => {
    expect(orderNotices(parsePageOrder('3,1,2', 3)!)).toEqual([]);

    const dup = orderNotices(parsePageOrder('1,1,2', 3)!);
    expect(dup).toHaveLength(2);
    expect(dup.join('\n')).toContain('丢弃');
    expect(dup.join('\n')).toContain('重复');

    const outOfRange = orderNotices(parsePageOrder('5,1', 3)!);
    expect(outOfRange).toHaveLength(2);
    expect(outOfRange.join('\n')).toContain('丢弃');
    expect(outOfRange.join('\n')).toContain('忽略');
  });
});

describe('splitRangeLines', () => {
  it('按行拆段、丢空行、去首尾空白', () => {
    expect(splitRangeLines('1-3\n\n5\n 8- ')).toEqual(['1-3', '5', '8-']);
    expect(splitRangeLines('')).toEqual([]);
    expect(splitRangeLines('\n\n')).toEqual([]);
  });
});
