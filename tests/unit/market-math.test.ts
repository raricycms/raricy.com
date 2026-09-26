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
import { settleClose, liquidationPrice, formatFeeRate } from '@/lib/market-math';
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

const settle = (exitPrice: number, stakeUnits = ONE, entryPrice = ENTRY, leverage = 1) =>
  settleClose({ stakeUnits, entryPrice, exitPrice, feeRate: FEE, leverage });

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

describe('settleClose（杠杆）', () => {
  it('杠杆=1 时逐位退回**加杠杆之前**的算式', () => {
    // 上面那组用例断的是几个具体的数；这一条断的是**性质**：广义公式在 1 倍下必须
    // 与旧算式逐位相同（floor(stake × 价/开仓价 × (1-费率))）。
    // 为什么值钱：存量仓位、上面那几条钉死的数、e2e 里「涨一倍 = 1.9996 条」，
    // 全都建立在旧算式上。哪天有人「化简」掉这个恒等，这组用例会当场红 ——
    // 而不是等到用户发现到手的鱼干少了一个存储单位。
    for (const px of [40000, 80000, 8015.2, 160000, 200000, 1]) {
      const legacy = Math.floor(((ONE * px) / ENTRY) * (1 - FEE));
      expect(settle(px).payoutUnits, `价=${px}`).toBe(legacy);
    }
  });

  it('10 倍仓涨 1%：盈亏约 +9.79%（10 倍收益 − 10 倍手续费）', () => {
    const s = settle(ENTRY * 1.01, ONE, ENTRY, 10);
    // 名义本金 100000，权益 = 10000 + 100000×0.01 = 11000
    // 手续费按**平仓时的名义本金**收：100000 × 1.01 × 0.0002 = 20.2
    // 实发 = floor(11000 − 20.2) = 10979 个单位 = 1.0979 条
    expect(s.payoutUnits).toBe(10979);
    expect(s.grossUnits).toBe(11000);
    // 涨跌幅仍是**行情**的 1% —— 别让它跟着杠杆变成 10%（弹窗里是两个数）
    expect(s.changePercent).toBeCloseTo(1, 6);
    expect(s.profitPercent).toBeCloseTo(9.79, 6);
    // 屏幕上「毛额 − 手续费 = 到手」要成立（这是弹窗的排版前提）
    expect(s.grossUnits - s.feeUnits).toBeCloseTo(s.payoutUnits, 6);
  });

  it('★ 以爆仓价结算，实发恒为 0 ★（强平引擎引用这条，别让它漂）', () => {
    // src/lib/market-liquidator.ts 的 liquidateOne 把 exitPrice 传成那行上存着的
    // 爆仓价，并据此**不写鱼干流水**（没有钱动过）。那条判断的全部依据就是这一条：
    // 爆仓价处权益恰好归零。
    // ⚠️ 谁把 liquidationPrice() 改成含维持保证金（爆仓时还剩一点权益），
    //    这里就会红 —— 那一刻必须回头改强平引擎：它得给用户记一条流水。
    for (const lv of [2, 3, 5, 10]) {
      const liq = liquidationPrice(ENTRY, lv);
      const s = settle(liq, ONE, ENTRY, lv);
      expect(s.payoutUnits, `${lv}× 爆仓价 ${liq}`).toBe(0);
      // ⚠️ 不断言 grossUnits === 0：浮点下权益会留 ~1.8e-12 的尘埃（实测 3×/5×/10×
      // 都有，2× 恰好干净）。它过不了 floor，所以 payout 严格是 0 —— 而强平引擎问的
      // 正是 payout（见那里的注释）。钉 gross 会得到一个随档位时红时绿的用例。
      expect(s.grossUnits, `${lv}× 权益应当已经归零（至多一个存储单位的尘埃）`)
        .toBeLessThan(1);
    }
  });

  it('跌穿爆仓价之后，手动平仓与强平给出**同一个数**（都是 0）', () => {
    // 这是刻意的（见 market-math.ts 头部）：两条路走同一个 max(0,…)。
    // 若手动平能亏穿（负数），账本当场撕裂（余额不许为负）；
    // 若强平能多留一点给用户，理性策略就变成「别平，等它爆我」。
    const liq = liquidationPrice(ENTRY, 10);
    const atLiq = settle(liq, ONE, ENTRY, 10);
    for (const px of [liq * 0.99, liq * 0.5, 1]) {
      expect(settle(px, ONE, ENTRY, 10).payoutUnits, `价=${px}`).toBe(atLiq.payoutUnits);
      expect(settle(px, ONE, ENTRY, 10).payoutUnits).toBe(0);
    }
  });

  it('实发永远 ≥ 0 且不随价格下降而上升（截断只朝下、只在一处）', () => {
    let prev = -1;
    for (let px = 1; px <= 200000; px += 613) {
      const s = settle(px, ONE, ENTRY, 10);
      expect(s.payoutUnits).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.payoutUnits)).toBe(true);
      expect(s.payoutUnits).toBeGreaterThanOrEqual(prev);
      prev = s.payoutUnits;
    }
  });

  it('1 倍永远碰不到爆仓价（它是 0，而价格到不了 0 以下）', () => {
    expect(liquidationPrice(ENTRY, 1)).toBe(0);
    // 脏输入也别返回 NaN —— 引擎的判据是 `现价 <= 爆仓价`，NaN 会让它恒 false
    //（= 永不强平），那比返回 0 危险得多。
    expect(liquidationPrice(ENTRY, 0)).toBe(0);
    expect(liquidationPrice(ENTRY, Number.NaN)).toBe(0);
  });

  it('爆仓价就是权益归零的那一条线（定义式，不是巧合）', () => {
    for (const lv of [2, 3, 5, 10]) {
      const liq = liquidationPrice(ENTRY, lv);
      // 线**之上**还有权益（拿 0.1% 而不是 0.001% 去探：后者的权益只剩个位数单位，
      // 会被浮点误差盖掉 —— 那是一种「用例自己不稳」而不是「定义错了」的红）。
      expect(settle(liq * 1.001, ONE, ENTRY, lv).grossUnits, `${lv}× 线之上`).toBeGreaterThan(0);
      // 线上至多剩一个存储单位的尘埃（小于最小可表示金额 = 事实上归零）
      expect(settle(liq, ONE, ENTRY, lv).grossUnits, `${lv}× 线上`).toBeLessThan(1);
    }
  });

  it('费率按**名义本金**收 —— 10 倍的手续费是 1 倍的 10 倍', () => {
    // 平价进出：权益 = 投入，手续费 = 名义本金 × 费率。这条就是「杠杆越高摩擦越大」。
    const one = settle(ENTRY, ONE, ENTRY, 1);
    const ten = settle(ENTRY, ONE, ENTRY, 10);
    expect(one.feeUnits).toBeCloseTo(ONE * FEE, 6); // 10000 × 0.0002 = 2
    expect(ten.feeUnits).toBeCloseTo(ONE * 10 * FEE, 6); // 20
    expect(ten.payoutUnits).toBe(ONE - 20);
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
