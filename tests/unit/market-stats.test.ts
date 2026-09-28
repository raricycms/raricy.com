// market-stats.ts —— 练手盘个人统计的纯聚合。
//
// 【这组用例钉的是什么】统计页上每个数都从 `payout_units − stake_units` 推出来，
// 而这条算术有几处**错了也不报错**的地方（除零、把爆仓与「手动亏光」混成一件事、
// 白名单外的旧仓漏出拆解表）—— 屏幕上那几个数看着都完全合理。所以这里逐个钉：
//   • 0 笔时胜率是 null 而不是 0（0/0 是 NaN，`NaN.toFixed(1)` 会在页面上印出「NaN%」）
//   • 实发为 0 的**手动**平仓计亏损，但**不计爆仓**（爆仓按 status 判，不按实发判）
//   • 平局既不算赢也不算输，但**进胜率的分母**
//   • Σ 拆解表 === 总数（两处都是整数相等，不是 toBeCloseTo）
//   • 白名单外的标的 / 杠杆出现在表尾，恒等式仍然成立
//   • `payout_units` 缺失的行进 `incomplete` 计数，**不**被当成「全亏」
//
// 纯函数，不需要数据库也不需要清行情缓存 —— 这正是「词表由调用方传进来」的收益。

import { describe, it, expect } from 'vitest';
import {
  SETTLED_STATUSES,
  LIQUIDATED_STATUS,
  summarizeMarket,
  estimateOpenPosition,
  sumProfitUnits,
  type SettledRow,
  type StatBucket,
} from '@/lib/market-stats';
import { FISH_UNIT_SCALE } from '@/lib/fish-units';

/** 投 1 条 = 10000 个存储单位。 */
const ONE = FISH_UNIT_SCALE;

/** 页面传进来的白名单（**生产上来自 MARKET_SYMBOLS / LEVERAGE_OPTIONS**）。 */
const UNIVERSE = { symbols: ['BTCUSDT', 'ETHUSDT'], leverages: [1, 2, 3, 5, 10, 20] };

const row = (over: Partial<SettledRow> = {}): SettledRow => ({
  symbol: 'BTCUSDT',
  leverage: 1,
  status: 'closed',
  stakeUnits: ONE,
  payoutUnits: ONE,
  ...over,
});

const summarize = (rows: SettledRow[], universe = UNIVERSE) => summarizeMarket(rows, universe);

/** 按 key 取一个桶 —— 拆解表的断言几乎都要先定位。 */
const bucketOf = (buckets: StatBucket[], key: string) => buckets.find((b) => b.key === key)!;

describe('终态白名单', () => {
  it('恰好这两个 —— 加第三个终态时这里先红，它同时要改 service 的 where 与 §6.13', () => {
    expect([...SETTLED_STATUSES]).toEqual(['closed', 'liquidated']);
    expect(LIQUIDATED_STATUS).toBe('liquidated');
  });
});

describe('总览', () => {
  it('一行都没有：全是 0，胜率是 null（不是 0、更不是 NaN）', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.incomplete).toBe(0);
    expect(s.winRatePct).toBeNull();
    expect(s.stakeUnits).toBe(0);
    expect(s.payoutUnits).toBe(0);
    expect(s.realizedUnits).toBe(0);
    expect(s.liquidated).toBe(0);
  });

  it('盈亏 = 实发 − 投入（整数单位，累计精确）', () => {
    const s = summarize([
      row({ stakeUnits: 10000, payoutUnits: 10997 }),
      row({ stakeUnits: 10000, payoutUnits: 9998 }),
    ]);
    expect(s.stakeUnits).toBe(20000);
    expect(s.payoutUnits).toBe(20995);
    expect(s.realizedUnits).toBe(995);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
  });

  it('胜率是**百分比数值**（0–100），不是 0–1 的比例', () => {
    // 两笔一胜 → 50，不是 0.5
    const s = summarize([
      row({ payoutUnits: 11000 }),
      row({ payoutUnits: 9000 }),
    ]);
    expect(s.winRatePct).toBe(50);

    // 三笔两胜 → 66.67（**平局进分母**：若开除它，这里会是 100）
    const s3 = summarize([
      row({ payoutUnits: 11000 }),
      row({ payoutUnits: 11000 }),
      row({ payoutUnits: 10000 }),
    ]);
    expect(s3.flats).toBe(1);
    expect(s3.winRatePct).toBeCloseTo(66.667, 3);
  });
});

describe('赢 / 输 / 平三分，以及爆仓怎么算', () => {
  it('爆仓行：计亏损、计入爆仓数（实发恒为 0 = 亏光投入）', () => {
    const s = summarize([row({ status: 'liquidated', leverage: 10, payoutUnits: 0 })]);
    expect(s.losses).toBe(1);
    expect(s.liquidated).toBe(1);
    expect(s.realizedUnits).toBe(-ONE);
  });

  it('★ 实发为 0 的**手动**平仓计亏损，但**不算爆仓**（判据是 status，不是实发）', () => {
    // 跌穿爆仓价的杠杆仓手动平掉，走的是同一个 max(0, …)，实发同样是 0
    const s = summarize([row({ status: 'closed', leverage: 10, payoutUnits: 0 })]);
    expect(s.losses).toBe(1);
    expect(s.liquidated).toBe(0);
  });

  it('平局（实发恰好等于投入）既不算赢也不算输，但进分母', () => {
    const s = summarize([row({ payoutUnits: ONE })]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.flats).toBe(1);
    expect(s.count).toBe(1);
    expect(s.winRatePct).toBe(0);
    expect(s.realizedUnits).toBe(0);
  });
});

describe('拆解表', () => {
  it('白名单里的标的 / 杠杆即便一笔没有也有一行（0 笔 → 胜率「—」）', () => {
    const s = summarize([row()]);
    expect(s.bySymbol.map((b) => b.key)).toEqual(['BTCUSDT', 'ETHUSDT']);
    const eth = bucketOf(s.bySymbol, 'ETHUSDT');
    expect(eth.count).toBe(0);
    expect(eth.winRatePct).toBeNull();
    expect(eth.realizedUnits).toBe(0);
    expect(s.byLeverage.map((b) => b.key)).toEqual(['1', '2', '3', '5', '10', '20']);
    expect(bucketOf(s.byLeverage, '20').winRatePct).toBeNull();
  });

  it('★ Σ 拆解表 === 总数（整数相等 —— 加上「拆解表里看不见的那些行」也得成立）', () => {
    const rows = [
      row({ symbol: 'BTCUSDT', leverage: 1, stakeUnits: 10000, payoutUnits: 10997 }),
      row({ symbol: 'BTCUSDT', leverage: 10, stakeUnits: 10000, payoutUnits: 0, status: 'liquidated' }),
      row({ symbol: 'ETHUSDT', leverage: 5, stakeUnits: 3000, payoutUnits: 2999 }),
    ];
    const s = summarize(rows);
    expect(s.bySymbol.reduce((a, b) => a + b.realizedUnits, 0)).toBe(s.realizedUnits);
    expect(s.byLeverage.reduce((a, b) => a + b.realizedUnits, 0)).toBe(s.realizedUnits);
    expect(s.bySymbol.reduce((a, b) => a + b.count, 0)).toBe(s.count);
    expect(s.byLeverage.reduce((a, b) => a + b.liquidated, 0)).toBe(s.liquidated);
  });

  it('★ 白名单外的旧仓（改过 MARKET_SYMBOLS 之后残留的）出现在**表尾**，且恒等式仍成立', () => {
    // market-liquidator.ts 头部明写存在这种行 —— 漏了它，拆解表之和就与总数对不上
    const s = summarize([
      row({ symbol: 'BTCUSDT', payoutUnits: 11000 }),
      row({ symbol: 'DOGEUSDT', leverage: 3, stakeUnits: 2000, payoutUnits: 1000 }),
    ]);
    expect(s.bySymbol.map((b) => b.key)).toEqual(['BTCUSDT', 'ETHUSDT', 'DOGEUSDT']);
    expect(s.byLeverage.map((b) => b.key)).toEqual(['1', '2', '3', '5', '10', '20']);
    expect(bucketOf(s.bySymbol, 'DOGEUSDT').realizedUnits).toBe(-1000);
    expect(s.bySymbol.reduce((a, b) => a + b.realizedUnits, 0)).toBe(s.realizedUnits);
  });

  it('白名单里没有的杠杆也照样进表（不静默吞掉）', () => {
    const s = summarize([row({ leverage: 7, payoutUnits: 11000 })]);
    expect(s.byLeverage.map((b) => b.key)).toContain('7');
    expect(s.byLeverage.reduce((a, b) => a + b.realizedUnits, 0)).toBe(s.realizedUnits);
  });
});

describe('数据缺一块时不猜', () => {
  it('★ payout_units 为 null 的行进 incomplete，**不计**进赢/输/平（不 `?? 0` 当成全亏）', () => {
    const s = summarize([row({ payoutUnits: 11000 }), row({ payoutUnits: null })]);
    expect(s.count).toBe(1);
    expect(s.incomplete).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.realizedUnits).toBe(1000);
    // 不变式：两半加起来才是这一桶真的行数
    expect(s.count + s.incomplete).toBe(2);
    expect(bucketOf(s.bySymbol, 'BTCUSDT').incomplete).toBe(1);
  });
});

describe('summary 的合计（持仓浮动盈亏）', () => {
  it('没有持仓 → 0（那是一个完整的答案）', () => {
    expect(sumProfitUnits([])).toBe(0);
  });

  it('★ 有一行取不到价 → null（整体显示「—」，不显示一个看着像完整的数）', () => {
    const est = estimateOpenPosition({
      stakeUnits: ONE,
      entryPrice: 80000,
      leverage: 1,
      liquidationPrice: 0,
      exitPrice: 88000,
      feeRate: 0.0002,
    });
    expect(est.profitUnits).toBeGreaterThan(0);
    expect(sumProfitUnits([est])).toBe(est.profitUnits);
    expect(sumProfitUnits([est, null])).toBeNull();
    expect(sumProfitUnits([null, est])).toBeNull();
  });
});

describe('单笔持仓的浮动盈亏', () => {
  const base = {
    stakeUnits: ONE,
    entryPrice: 80000,
    leverage: 1,
    liquidationPrice: 0,
    exitPrice: 88000,
    feeRate: 0.0002,
  };

  it('涨 10% 的 1 倍仓：到手 1.0997 条（含平仓手续费）', () => {
    const est = estimateOpenPosition(base);
    // floor(10000 × 1.1 × 0.9998) = 10997，不是 11000 —— 手续费在里头
    expect(est.payoutUnits).toBe(10997);
    expect(est.profitUnits).toBe(997);
  });

  it('平价时代理**也是亏的**（就是那一笔手续费）—— 钉住「与卖出弹窗同口径」', () => {
    const est = estimateOpenPosition({ ...base, exitPrice: 80000 });
    expect(est.payoutUnits).toBe(9998);
    expect(est.profitUnits).toBe(-2);
  });

  it('★ 杠杆真的参与：同样的涨幅，10 倍仓的盈亏是 1 倍的十倍量级', () => {
    const one = estimateOpenPosition(base);
    const ten = estimateOpenPosition({ ...base, leverage: 10, liquidationPrice: 72000 });
    expect(ten.profitUnits).toBe(9978);
    expect(ten.profitUnits).not.toBe(one.profitUnits);
  });

  it('跌穿爆仓价：实发 0、盈亏 = −投入，并标记 belowLiquidation', () => {
    const est = estimateOpenPosition({ ...base, leverage: 10, liquidationPrice: 72000, exitPrice: 70000 });
    expect(est.payoutUnits).toBe(0);
    expect(est.profitUnits).toBe(-ONE);
    expect(est.belowLiquidation).toBe(true);
  });

  it('1 倍仓（爆仓价恒为 0）永远不标记 belowLiquidation —— 0 是「不适用」不是「已跌破」', () => {
    const est = estimateOpenPosition({ ...base, exitPrice: 1 });
    expect(est.belowLiquidation).toBe(false);
  });
});
