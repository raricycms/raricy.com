// market-chart.ts —— K 线图里**时间语义**那一面。
//
// 【这组用例钉的是什么】
//   • 时间轴是**本站钟面（UTC+8）**：库里的钟、K 线的钟、Date.now() 的钟是三回事
//   • 展示价并进末根：同桶改收、跨桶追加，**中间缺的不补**（补了就是编数据）
// 缩放锚点、聚合、刻度与命中测试属于显示层几何，按测试精简口径已删除。

import { describe, it, expect } from 'vitest';
import { formatCandleTime, mergeLivePrice } from '@/lib/market-chart';
import type { CandleTuple } from '@/lib/market-candles';

/** 造一根 K 线。默认造「阳线、量 1」。 */
const mk = (
  t: number,
  o = 100,
  h = 105,
  l = 95,
  c = 102,
  v = 1
): CandleTuple => [t, o, h, l, c, v];

describe('时间轴：本站钟面（UTC+8）', () => {
  // 2026-09-23T08:00:00+08:00 === 2026-09-23T00:00:00Z
  const BEIJING_8AM = Date.UTC(2026, 8, 23, 0, 0, 0);
  const BEIJING_MIDNIGHT = Date.UTC(2026, 8, 22, 16, 0, 0);

  it('★ 钟面是北京时间，不是 UTC（差 8 小时，且这事没有任何报错）', () => {
    expect(formatCandleTime(BEIJING_8AM, 3_600_000)).toBe('08:00');
  });

  it('日内跨零点时把标签换成日期 —— 否则一整天只有一串时间', () => {
    expect(formatCandleTime(BEIJING_MIDNIGHT, 3_600_000)).toBe('09-23');
  });

  it('★ 粒度跟着**步长**走（不是跨度）：41 天那张图步长是 7 天，该显示 MM-DD', () => {
    // 按跨度判的话这一档会整排都成「2026-09」—— 一个月的名字重复五遍，读不出东西
    expect(formatCandleTime(BEIJING_8AM, 7 * 86_400_000)).toBe('09-23');
    expect(formatCandleTime(BEIJING_8AM, 120 * 86_400_000)).toBe('2026-09');
  });
});

describe('实时并线：mergeLivePrice', () => {
  const IV = 3_600_000;
  // 起点**对齐到整点**：真身给的 openTime 就是对齐的（币安按整点切桶），
  // 对齐之后「跨桶追加」那一条才能拿 t0 + k*IV 直接当期望值
  const t0 = 1_699_999_200_000;
  const base = (): CandleTuple[] => [
    mk(t0, 100, 105, 95, 102, 1),
    mk(t0 + IV, 102, 108, 101, 107, 2),
  ];

  it('同一桶内：改收、抬最高、压最低，开盘价不动', () => {
    const cs = base();
    const up = mergeLivePrice(cs, 120, t0 + IV + 1000, IV, 1000);
    expect(up.candles[1]).toEqual([t0 + IV, 102, 120, 101, 120, 2]);
    expect(up.rolledOver).toBe(false);

    const down = mergeLivePrice(cs, 90, t0 + IV + 1000, IV, 1000);
    expect(down.candles[1]).toEqual([t0 + IV, 102, 108, 90, 90, 2]);
    // 原数组没被就地改（React 靠引用变化重渲染）
    expect(cs[1][4]).toBe(107);
  });

  it('价格没变化时返回**原引用** —— 否则每秒白重渲染一次', () => {
    const cs = base();
    const same = mergeLivePrice(cs, 107, t0 + IV + 1000, IV, 1000);
    expect(same.candles).toBe(cs);
    expect(same.rolledOver).toBe(false);
  });

  it('★ 跨桶：把末根换成「当前这一桶」，中间缺的那几根**不补**', () => {
    const cs = base();
    const at = t0 + 5 * IV + 30_000; // 整整跨过 4 个桶
    const r = mergeLivePrice(cs, 111, at, IV, 1000);
    expect(r.rolledOver, '调用方据此去重取一次真数据').toBe(true);
    expect(r.candles).toHaveLength(3);
    expect(r.candles[2]).toEqual([t0 + 5 * IV, 111, 111, 111, 111, 0]);
    // 4h 那一根的 openTime 必须是**当前**这一桶的起点，不是「上一根 + 1」
    // —— 否则每来一秒就再追加一根，图上会冒出一串平线
    const again = mergeLivePrice(r.candles, 112, at + 1000, IV, 1000);
    expect(again.rolledOver).toBe(false);
    expect(again.candles).toHaveLength(3);
  });

  it('追加以外的改动：超过 maxLen 时从头裁掉', () => {
    const cs = base();
    const r = mergeLivePrice(cs, 111, t0 + 5 * IV, IV, 3);
    expect(r.candles.length).toBeLessThanOrEqual(3);
  });

  it('非法输入与空序列原样返回（不炸、不造一根假的）', () => {
    const cs = base();
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(mergeLivePrice(cs, bad, t0 + IV, IV, 1000).candles).toBe(cs);
    }
    expect(mergeLivePrice(cs, 100, NaN, IV, 1000).candles).toBe(cs);
    expect(mergeLivePrice(cs, 100, t0 + IV, 0, 1000).candles).toBe(cs);
    const empty: CandleTuple[] = [];
    expect(mergeLivePrice(empty, 100, t0, IV, 1000).candles).toBe(empty);
  });

  it('时间戳早于末根（时钟回拨 / 陈旧帧）时不动它', () => {
    const cs = base();
    expect(mergeLivePrice(cs, 120, t0, IV, 1000).candles).toBe(cs);
  });
});
