// ─────────────────────────────────────────────────────────────────────────────
// pagination.test.ts —— 分页参数归一（R3-412 / C11）
//
// 【bug 形状】各 service 的 `Math.max(1, params.page ?? 1)` 兜不住 `parseInt('abc')`
// 的 NaN（`??` 只兜 null/undefined；`Math.max(1, NaN)` 还是 NaN），最终 `skip: NaN`
// 让 Prisma 校验失败 → 500。perPage 同式。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parsePage, parsePerPage } from '@/lib/pagination';

describe('parsePage：非法 / 非正数一律按第 1 页（不新增 400）', () => {
  it('NaN / 0 / 负数 / 小数 / 非数字字符串 → 1', () => {
    for (const raw of [NaN, 0, -1, -999, 1.5, 'abc', '', null, undefined, {}]) {
      expect(parsePage(raw), `${String(raw)} 应归一为 1`).toBe(1);
    }
  });

  it('合法正整数原样保留（数字与数字字符串都认）', () => {
    for (const [raw, want] of [
      [1, 1],
      [7, 7],
      ['42', 42],
      ['999999', 999999],
    ] as const) {
      expect(parsePage(raw)).toBe(want);
    }
  });

  it('fallback 可定制', () => {
    expect(parsePage('x', 3)).toBe(3);
  });
});

describe('parsePerPage：非法 → 默认值；0 / 负数夹到 1；合法值夹到 max', () => {
  it('NaN / 非数字 → fallback', () => {
    for (const raw of [NaN, 'abc', null, undefined, 1.5]) {
      expect(parsePerPage(raw, 20, 100), `${String(raw)} 应归一为 20`).toBe(20);
    }
  });

  it('0 / 负数夹到 1（与既有 Math.max(1, …) 语义一致）', () => {
    for (const raw of [0, -5]) {
      expect(parsePerPage(raw, 20, 100), `${String(raw)} 应归一为 1`).toBe(1);
    }
  });

  it('超过 max 夹到 max；合法值原样', () => {
    expect(parsePerPage(100000, 20, 100)).toBe(100);
    expect(parsePerPage('55', 20, 100)).toBe(55);
    expect(parsePerPage(1, 20, 100)).toBe(1);
  });
});
