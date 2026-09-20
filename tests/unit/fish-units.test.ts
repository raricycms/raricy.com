// fish-units.ts —— 鱼干存储单位（0.0001 鱼干 = 1）与业务单位（鱼干）的换算契约。
//
// 这是钱的换算，双向都必须钉死：
//   • fishToUnits 静默吞精度 = 写错账（宁可抛错）
//   • unitsToFish 除以 10000 永远精确（整数 / 10^4 在双精度下可能不精确，
//     但 ≤4 位小数的结果如 2.4 是「最短可往返表示」，与字面量 2.4 同值）

import { describe, it, expect } from 'vitest';
import {
  FISH_DECIMALS,
  FISH_UNIT_SCALE,
  MAX_FISH_UNITS,
  fishToUnits,
  unitsToFish,
} from '@/lib/fish-units';

describe('fishToUnits（鱼干 → 存储单位）', () => {
  it('1 鱼干 = 10000 单位；整数与小数均正确换算', () => {
    expect(fishToUnits(0)).toBe(0);
    expect(fishToUnits(1)).toBe(10000);
    expect(fishToUnits(4.2)).toBe(42000);
    expect(fishToUnits(0.8)).toBe(8000);
    expect(fishToUnits(-3)).toBe(-30000); // 支出流水为负
  });

  it('4 位小数是合法精度（正好是存储单位的最小刻度）', () => {
    expect(fishToUnits(0.0001)).toBe(1);
    expect(fishToUnits(0.1234)).toBe(1234);
    expect(fishToUnits(12.0001)).toBe(120001);
  });

  it('投喂分成 0.8×n 的所有可能值都精确（n=1..5）', () => {
    // ⚠️ 这里是**字面量**而不是 feed-service 那条公式的副本 —— 抄一份公式过来
    // 只会让两边一起错（原先这里就抄了一份，还写着「与 feed-service 同式」）。
    const cases: Array<[income: number, units: number]> = [
      [0.8, 8000],
      [1.6, 16000],
      [2.4, 24000],
      [3.2, 32000],
      [4, 40000],
    ];
    for (const [income, units] of cases) {
      expect(fishToUnits(income)).toBe(units);
    }
  });

  it('超过 4 位小数 → 抛错（静默 round 会吞掉账目误差）', () => {
    expect(() => fishToUnits(1.00005)).toThrow(/超过 4 位小数精度/);
    expect(() => fishToUnits(0.12345)).toThrow(/超过 4 位小数精度/);
    expect(() => fishToUnits(1 / 3)).toThrow(/超过 4 位小数精度/);
  });

  it('原先被拒的 1 位小数现在合法（精度提升的直接后果）', () => {
    // 这几条在 scale=10 时代是「非法输入」；0.05 从 400 变成合法是**有意的行为变更**，
    // 不是回归。练手盘那块仍会因 MIN_STAKE_FISH 拒掉它，但理由换了一条。
    expect(fishToUnits(1.05)).toBe(10500);
    expect(fishToUnits(0.123)).toBe(1230);
    expect(fishToUnits(0.05)).toBe(500);
  });

  it('非有限值（NaN / Infinity）→ 抛错', () => {
    expect(() => fishToUnits(NaN)).toThrow(/非法/);
    expect(() => fishToUnits(Infinity)).toThrow(/非法/);
    expect(() => fishToUnits(-Infinity)).toThrow(/非法/);
  });

  it('浮点表示的 4 位小数（如 2.4000000000000004）被容忍并收敛', () => {
    // 0.8*3 的浮点结果是 2.4000000000000004 —— 业务代码 round 后是 2.4，
    // 但即便漏了 round，此处也不应误伤（误差 < 容差）
    expect(fishToUnits(0.8 * 3)).toBe(24000);
    expect(fishToUnits(0.1 + 0.2)).toBe(3000);
  });

  it('接近 i32 上限的大额合法值不被误拒（容差随量级缩放）', () => {
    // 这条盯着「容差是绝对常量」这个陷阱：固定 1e-6 在 i32 量级只剩几倍余量，
    // 一旦有人把 FISH_UNIT_SCALE 调得更大，这里就是最先炸的地方（只有最大户复现）。
    expect(fishToUnits(214748.3647)).toBe(2147483647);
    expect(fishToUnits(200000.0001)).toBe(2000000001);
    expect(fishToUnits(999999.9999)).toBe(9999999999);
  });
});

describe('unitsToFish（存储单位 → 鱼干）', () => {
  it('除以 10000 恒等还原', () => {
    expect(unitsToFish(0)).toBe(0);
    expect(unitsToFish(42000)).toBe(4.2);
    expect(unitsToFish(8000)).toBe(0.8);
    expect(unitsToFish(-30000)).toBe(-3);
    expect(unitsToFish(1)).toBe(0.0001);
  });

  it('换算可逆：fish → units → fish 回到原值（4 位小数域内）', () => {
    for (const fish of [0, 0.0001, 0.1, 0.8, 1, 4.2, 5, -2.4, 12.0001, 2045]) {
      expect(unitsToFish(fishToUnits(fish))).toBe(fish);
    }
  });
});

describe('常量契约', () => {
  it('FISH_UNIT_SCALE = 10000（改动即报警：需同步迁移脚本与 schema 注释）', () => {
    expect(FISH_UNIT_SCALE).toBe(10000);
  });

  it('FISH_DECIMALS 与 FISH_UNIT_SCALE 同源（不会各自漂移）', () => {
    expect(FISH_UNIT_SCALE).toBe(10 ** FISH_DECIMALS);
    expect(FISH_DECIMALS).toBe(4);
  });

  it('MAX_FISH_UNITS 是 Prisma Int 的 32 位有符号上界', () => {
    // 改这个数之前先读 fish-units.ts 头部「存储上限」那段：上界同时约束
    // fish_transactions.amount（历史累计成交量），不只是余额。
    expect(MAX_FISH_UNITS).toBe(2 ** 31 - 1);
    expect(MAX_FISH_UNITS / FISH_UNIT_SCALE).toBeCloseTo(214748.3647, 4);
  });
});
