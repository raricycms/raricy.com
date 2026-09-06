// fish-units.ts —— 鱼干存储单位（0.1 鱼干 = 1）与业务单位（鱼干）的换算契约。
//
// 这是钱的换算，双向都必须钉死：
//   • fishToUnits 静默吞精度 = 写错账（宁可抛错）
//   • unitsToFish 除以 10 永远精确（整数 / 10 在双精度下可能不精确，
//     但 1 位小数的结果如 2.4 是「最短可往返表示」，与字面量 2.4 同值）

import { describe, it, expect } from 'vitest';
import { FISH_UNIT_SCALE, fishToUnits, unitsToFish } from '@/lib/fish-units';

describe('fishToUnits（鱼干 → 存储单位）', () => {
  it('1 鱼干 = 10 单位；整数与小数均正确换算', () => {
    expect(fishToUnits(0)).toBe(0);
    expect(fishToUnits(1)).toBe(10);
    expect(fishToUnits(4.2)).toBe(42);
    expect(fishToUnits(0.8)).toBe(8);
    expect(fishToUnits(-3)).toBe(-30); // 支出流水为负
  });

  it('投喂分成 0.8×n 的所有可能值都精确（n=1..5）', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const income = Math.round(n * 0.8 * 10) / 10; // 与 feed-service 同式
      expect(fishToUnits(income)).toBe(n * 8);
    }
  });

  it('超过 1 位小数 → 抛错（静默 round 会吞掉账目误差）', () => {
    expect(() => fishToUnits(1.05)).toThrow(/超过 1 位小数精度/);
    expect(() => fishToUnits(0.123)).toThrow(/超过 1 位小数精度/);
  });

  it('非有限值（NaN / Infinity）→ 抛错', () => {
    expect(() => fishToUnits(NaN)).toThrow(/非法/);
    expect(() => fishToUnits(Infinity)).toThrow(/非法/);
    expect(() => fishToUnits(-Infinity)).toThrow(/非法/);
  });

  it('浮点表示的 1 位小数（如 2.4000000000000004）被容忍并收敛', () => {
    // 0.8*3 的浮点结果是 2.4000000000000004 —— 业务代码 Math.round 后是 2.4，
    // 但即便漏了 round，此处也不应误伤（误差 < 1e-6）
    expect(fishToUnits(0.8 * 3)).toBe(24);
  });
});

describe('unitsToFish（存储单位 → 鱼干）', () => {
  it('除以 10 恒等还原', () => {
    expect(unitsToFish(0)).toBe(0);
    expect(unitsToFish(42)).toBe(4.2);
    expect(unitsToFish(8)).toBe(0.8);
    expect(unitsToFish(-30)).toBe(-3);
  });

  it('换算可逆：fish → units → fish 回到原值（1 位小数域内）', () => {
    for (const fish of [0, 0.1, 0.8, 1, 4.2, 5, -2.4]) {
      expect(unitsToFish(fishToUnits(fish))).toBe(fish);
    }
  });
});

describe('常量契约', () => {
  it('FISH_UNIT_SCALE = 10（改动即报警：需同步迁移脚本与 schema 注释）', () => {
    expect(FISH_UNIT_SCALE).toBe(10);
  });
});
