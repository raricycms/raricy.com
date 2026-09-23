// market-math.ts —— 练手盘平仓结算的唯一公式。
//
// 【这组用例钉的是什么】服务端真结算与页面上「涨跌幅 / 手续费 / 预计到手」走的是
// **同一个函数**，所以这里的每个数同时是两边的事实：
//   • 涨一倍 → 1.9996 条（e2e tests/e2e/fish-trade.spec.ts 也钉着这个数 ——
//     这里钉算式，那里钉「现取的价真的被用上了」）
//   • 平价卖出**也要亏**：亏的正好是手续费。「买进去立刻卖是负和」就是这一条，
//     也是「宁可少发也不多铸」在用户侧的可见后果
//   • 涨跌幅与盈亏率差一个费率 —— 弹窗里是两个数，别让它们悄悄变成同一个
//
// ⚠️ 这几个数字跟着**存储精度**与**费率**走：精度从 0.1 条抬到 0.0001 条之后 floor
// 少丢的零头让涨一倍的实发从 1.9 变成 1.998，费率从 0.1% 降到 0.02% 之后又变成
// 1.9996。再动这两个数时这几处必红（同 e2e 文件头那条提醒）。

import { describe, it, expect } from 'vitest';
import { settleClose, formatFeeRate } from '@/lib/market-math';
import { FISH_UNIT_SCALE } from '@/lib/fish-units';

/** 投 1 条 = 10000 个存储单位 —— 结果可以直接读成鱼干。 */
const ONE = FISH_UNIT_SCALE;
/**
 * 费率 fixture。**要跟着生产的 `MARKET_FEE_RATE` 走**（那个值由
 * tests/service/market-service.test.ts 钉着）—— 它是输入参数，不是这里定义的事实，
 * 漂了的话这组用例算的就是另一个世界的账，而结论看起来完全合理。
 */
const FEE = 0.0002;
const ENTRY = 80000;

const settle = (exitPrice: number, stakeUnits = ONE, entryPrice = ENTRY) =>
  settleClose({ stakeUnits, entryPrice, exitPrice, feeRate: FEE });

describe('settleClose（平仓结算）', () => {
  it('平价卖出：实发只少一个手续费；涨跌幅 0%，盈亏率 −0.02%', () => {
    const s = settle(ENTRY);
    expect(s.grossUnits).toBe(10000);
    expect(s.payoutUnits).toBe(9998); // 1.0000 − 0.0002
    expect(s.feeUnits).toBeCloseTo(2, 6);
    expect(s.changePercent).toBe(0);
    expect(s.profitPercent).toBeCloseTo(-0.02, 6);
  });

  it('涨一倍：floor(10000 × 2 × 0.9998) = 19996 个单位 = 1.9996 条', () => {
    const s = settle(ENTRY * 2);
    expect(s.payoutUnits).toBe(19996);
    expect(s.changePercent).toBeCloseTo(100, 6);
    expect(s.profitPercent).toBeCloseTo(99.96, 6);
  });

  it('腰斩：floor(10000 × 0.5 × 0.9998) = 4999 个单位 = 0.4999 条', () => {
    const s = settle(ENTRY / 2);
    expect(s.payoutUnits).toBe(4999);
    expect(s.changePercent).toBeCloseTo(-50, 6);
    expect(s.profitPercent).toBeCloseTo(-50.01, 6);
  });

  it('费率乘在**未 floor 的毛额**上，全程只 floor 一次', () => {
    // 毛额刻意取一个除不尽、小数部分又接近 1 的数：10000 × 8015.2 / 80000 = 1001.9
    const s = settle(8015.2);
    expect(s.grossUnits).toBeCloseTo(1001.9, 6);
    // 正确：floor(1001.9 × 0.9998) = floor(1001.69962) = 1001
    expect(s.payoutUnits).toBe(1001);
    // 若先把毛额 floor 掉再乘费率：1001 × 0.9998 = 1000.7998 → 少发 1 个单位。
    // 这个数就是「先算毛额」这条纪律的全部收益 —— 它落在用户的到手金额上。
    expect(s.payoutUnits).not.toBe(Math.floor(Math.floor(s.grossUnits) * (1 - FEE)));
  });

  it('手续费与 floor 一律朝系统一侧：实发 ≤ 毛额 × (1 − 费率)，且是整数个单位', () => {
    for (let px = 40000; px <= 200000; px += 777) {
      const s = settle(px);
      expect(s.payoutUnits).toBeLessThanOrEqual(s.grossUnits * (1 - FEE));
      expect(Number.isInteger(s.payoutUnits), '实发必须是整数个单位').toBe(true);
      expect(s.feeUnits).toBeGreaterThanOrEqual(0);
      // 屏幕上「毛额 − 手续费 = 到手」要逐字对得上（弹窗就是照这个排的）
      expect(s.grossUnits - s.feeUnits).toBeCloseTo(s.payoutUnits, 6);
    }
  });

  it('盈亏率与涨跌幅是两个数，差的正好是手续费那一截', () => {
    // 涨 12.5% 的一笔：到手比行情少 0.02 个点（费率），这就是「频繁进出被磨」
    const s = settle(90000);
    expect(s.changePercent).toBeCloseTo(12.5, 6);
    expect(s.profitPercent).toBeCloseTo(((s.payoutUnits - ONE) / ONE) * 100, 6);
    expect(s.profitPercent).toBeLessThan(s.changePercent);
  });

  it('投入为 0 时不做保护 —— 这是调用方的前提，不是本函数的义务', () => {
    // 仓位行不可能有 0 投入（market-service 的 MIN_STAKE_FISH）。钉在这里是为了让
    // 「我给它传个 0 会怎样」有个明确答案：NaN / Infinity，而不是某个看起来合理的数。
    expect(Number.isNaN(settle(ENTRY, 0).profitPercent)).toBe(true);
  });
});

describe('formatFeeRate（页面上的费率文本）', () => {
  it('当前费率渲染成 0.02% —— 别掉到「0.0%」那一档', () => {
    expect(formatFeeRate(0.0002)).toBe('0.02%');
  });

  it('★ 费率变小也不会塌成 0.0% —— 页面照旧显示「手续费 0.0%」，不报任何错', () => {
    // 原先页面上是 (feeRate * 100).toFixed(1)：对 0.1% 是对的，0.02% 就写成「0.0%」。
    // 位数在这里由 feeRate 自己定，所以再小的费率也读得出来。
    expect(formatFeeRate(0.001)).toBe('0.10%');
    expect(formatFeeRate(0.00002)).toBe('0.002%');
    expect(formatFeeRate(0.01)).toBe('1.00%');
  });
});
