// market-chart.ts —— K 线图的纯计算。
//
// 【这组用例钉的是什么】图表里最容易出错、又最难靠肉眼发现的那部分全是算术：
//   • 滚轮缩放要**钉住指针下那一根**，否则手感是「放大并往左跳」
//   • 缩到 1000 根全看时画的是**聚合蜡烛**，而桶必须锚在绝对下标上 ——
//     否则一拖动整张图就重排，看起来像数据变了
//   • 时间轴是**本站钟面（UTC+8）**：库里的钟、K 线的钟、Date.now() 的钟是三回事
//   • 展示价并进末根：同桶改收、跨桶追加，**中间缺的不补**（补了就是编数据）
// 这些错了都不会报错，只会安静地画出一张「看着挺像」的错图。

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VISIBLE_CANDLES,
  MAX_DRAWN_CANDLES,
  MIN_VISIBLE_CANDLES,
  bodyWidthFraction,
  bucketSizeFor,
  clampWindow,
  drawCandles,
  formatAxisPrice,
  formatCandleTime,
  formatPct,
  formatPrice,
  indexAtFraction,
  itemIndexAtFraction,
  mergeLivePrice,
  niceTicks,
  panWindow,
  priceAtFraction,
  priceDomain,
  resetWindow,
  timeTicks,
  xFraction,
  yFraction,
  zoomWindow,
  type ChartWindow,
} from '@/lib/market-chart';
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

/** 造一串 openTime 递增的 K 线（默认按 1 小时）。第二参步长、第三参按根覆写某几项。 */
interface Override {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}
const series = (n: number, stepMs = 3_600_000, f: (i: number) => Override = () => ({})) => {
  const out: CandleTuple[] = [];
  for (let i = 0; i < n; i++) {
    const x = f(i);
    out.push(
      mk(
        x.t ?? 1_700_000_000_000 + i * stepMs,
        x.o ?? 100,
        x.h ?? 105,
        x.l ?? 95,
        x.c ?? 102,
        x.v ?? 1
      )
    );
  }
  return out;
};

describe('窗口：resetWindow / clampWindow', () => {
  it('默认视野贴右端，且不超过数据长度', () => {
    expect(resetWindow(1000)).toEqual({ from: 1000 - DEFAULT_VISIBLE_CANDLES, count: DEFAULT_VISIBLE_CANDLES });
    expect(resetWindow(30)).toEqual({ from: 0, count: 30 });
  });

  it('左端不早于第一根、右端不晚于最后一根', () => {
    expect(clampWindow({ from: -50, count: 120 }, 1000).from).toBe(0);
    expect(clampWindow({ from: 5000, count: 120 }, 1000)).toEqual({ from: 880, count: 120 });
  });

  it('可见根数夹在 [MIN, len] —— 缩得太狠就没有「一根蜡烛」可看了', () => {
    expect(clampWindow({ from: 0, count: 1 }, 1000).count).toBe(MIN_VISIBLE_CANDLES);
    expect(clampWindow({ from: 0, count: 99999 }, 1000).count).toBe(1000);
    expect(clampWindow({ from: 0, count: 120 }, 30).count, '数据比最少可见数还少').toBe(30);
  });

  it('空数据不炸', () => {
    expect(clampWindow({ from: 0, count: 120 }, 0).count).toBe(MIN_VISIBLE_CANDLES);
  });
});

describe('缩放：锚点不动', () => {
  it('★ 放大后，指针下那一根仍停在屏幕上的同一处', () => {
    const w = resetWindow(1000);
    const anchor = indexAtFraction(0.25, w); // 指针在左边四分之一处

    const zin = zoomWindow(w, 2, anchor, 1000); // factor > 1 = 放大
    expect(zin.count).toBeLessThan(w.count);
    expect(Math.abs(xFraction(anchor, zin) - xFraction(anchor, w)), '锚点漂了就是「放大并往左跳」').toBeLessThan(0.02);

    // 缩回去，锚点同样不动
    const zout = zoomWindow(zin, 0.5, anchor, 1000);
    expect(Math.abs(xFraction(anchor, zout) - xFraction(anchor, w))).toBeLessThan(0.05);
  });

  it('放大到顶 = 最少可见根数；缩到底 = 全部数据', () => {
    const w = resetWindow(1000);
    expect(zoomWindow(w, 1000, 500, 1000).count).toBe(MIN_VISIBLE_CANDLES);
    expect(zoomWindow(w, 0.001, 500, 1000).count).toBe(1000);
  });

  it('缩放后仍然夹在数据范围内（在最右端放大不会越界）', () => {
    const w = resetWindow(1000);
    const z = zoomWindow(w, 4, 999, 1000);
    expect(z.from + z.count).toBeLessThanOrEqual(1000);
  });

  it('非法的缩放倍数原样返回（守卫 NaN 进不了窗口）', () => {
    const w = resetWindow(1000);
    for (const bad of [0, -1, NaN, Infinity]) expect(zoomWindow(w, bad, 500, 1000)).toBe(w);
  });
});

describe('平移：到两端就停住', () => {
  it('往右看看到更晚的行情，到最右端停住', () => {
    const w = { from: 400, count: 120 } as ChartWindow;
    expect(panWindow(w, 10, 1000).from).toBe(410);
    expect(panWindow(w, 9999, 1000).from).toBe(880);
  });

  it('往左看到更早的行情，到 0 停住（画面左边就是数据起点）', () => {
    const w = { from: 100, count: 120 } as ChartWindow;
    expect(panWindow(w, -10, 1000).from).toBe(90);
    expect(panWindow(w, -9999, 1000).from).toBe(0);
  });

  it('NaN 平移量原样返回', () => {
    const w = { from: 100, count: 120 } as ChartWindow;
    expect(panWindow(w, NaN, 1000)).toBe(w);
  });
});

describe('xFraction / indexAtFraction', () => {
  it('互为反函数（命中测试靠这条）', () => {
    const w = { from: 880, count: 120 } as ChartWindow;
    for (const i of [880, 900, 999]) expect(indexAtFraction(xFraction(i, w), w)).toBe(i);
  });

  it('窗口两端：第一根的中心在 0 与 1/count 之间，最后一根在 1 附近', () => {
    const w = { from: 0, count: 100 } as ChartWindow;
    expect(xFraction(0, w)).toBeCloseTo(0.005, 6);
    expect(xFraction(99, w)).toBeCloseTo(0.995, 6);
  });
});

describe('聚合：drawCandles / bucketSizeFor', () => {
  it('桶大小 = ceil(可见根数 / 上限)，至少 1', () => {
    expect(bucketSizeFor(1000, MAX_DRAWN_CANDLES)).toBe(6);
    expect(bucketSizeFor(100, MAX_DRAWN_CANDLES)).toBe(1);
    expect(bucketSizeFor(181, 180)).toBe(2);
    expect(bucketSizeFor(0, 180)).toBe(1);
  });

  it('一根对一根时不聚合，OHLCV 原样', () => {
    const cs = series(10);
    const { items, bucketSize } = drawCandles(cs, { from: 0, count: 10 }, 180);
    expect(bucketSize).toBe(1);
    expect(items).toHaveLength(10);
    expect(items[3]).toMatchObject({ i0: 3, i1: 3, open: cs[3][1], high: cs[3][2], low: cs[3][3], close: cs[3][4] });
  });

  it('★ 聚合出来的一根 = 首开 / 最高 / 最低 / 末收 / 量和', () => {
    const cs = [
      mk(1000, 10, 12, 9, 11, 1),
      mk(2000, 11, 20, 10, 19, 2), // 这一段里的最高
      mk(3000, 19, 19.5, 5, 6, 4), // 这一段里的最低
      mk(4000, 6, 8, 5.5, 7, 8),
      mk(5000, 7, 9, 6, 8, 16),
      mk(6000, 8, 30, 7, 29, 32),
    ];
    const { items, bucketSize } = drawCandles(cs, { from: 0, count: 6 }, 2);
    expect(bucketSize).toBe(3);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ i0: 0, i1: 2, open: 10, close: 6, high: 20, low: 5, volume: 7 });
    expect(items[1]).toMatchObject({ i0: 3, i1: 5, open: 6, close: 29, high: 30, low: 5.5, volume: 56 });
  });

  it('★ 桶锚在绝对下标上：拖动只挪视口，同一根原始 K 线永远属于同一个桶', () => {
    const cs = series(12);
    const a = drawCandles(cs, { from: 0, count: 12 }, 4); // size 3
    const b = drawCandles(cs, { from: 2.2, count: 12 }, 4); // 同一个 size，视口右移
    expect(a.bucketSize).toBe(3);
    expect(b.bucketSize).toBe(3);
    expect(a.items.map((it) => it.i0)).toEqual([0, 3, 6, 9]);
    expect(b.items.map((it) => it.i0), '同一张网格 —— 换了 from 也不重排').toEqual([0, 3, 6, 9]);
  });

  it('视口只覆盖一部分时，半截的桶也要**整根画**（否则拖动到边界会跳一下）', () => {
    const cs = series(100);
    const { items, bucketSize } = drawCandles(cs, { from: 50, count: 10 }, 3);
    expect(bucketSize).toBe(4);
    expect(items[0].i0, '第一个桶从 48 起：它跨在视口左边界上，仍按整桶画').toBe(48);
    expect(items[items.length - 1].i1).toBeGreaterThanOrEqual(59);
  });

  it('空数据给空数组（行情没回来时不炸）', () => {
    expect(drawCandles([], resetWindow(0))).toEqual({ items: [], bucketSize: 1 });
  });
});

describe('命中测试与实体宽度', () => {
  const w = { from: 0, count: 12 } as ChartWindow;
  const { items } = drawCandles(series(12), w, 4); // size 3

  it('指针落的那一列 → 对应的图元（聚合的按 i0..i1 归属）', () => {
    expect(itemIndexAtFraction(items, w, xFraction(0, w))).toBe(0);
    expect(itemIndexAtFraction(items, w, xFraction(5, w)), '第 5 根属于 3..5 那个桶').toBe(1);
    expect(itemIndexAtFraction(items, w, xFraction(11, w))).toBe(3);
  });

  it('指到空处 / 空数据 / NaN 一律 -1（不返回一个假的命中）', () => {
    expect(itemIndexAtFraction([], w, 0.5)).toBe(-1);
    const left = { from: 100, count: 12 } as ChartWindow; // 窗口挪到了数据外面
    expect(itemIndexAtFraction(items, left, 0.5)).toBe(-1);
    expect(itemIndexAtFraction(items, w, NaN)).toBe(-1);
  });

  it('实体宽度：一格对一根时是格宽的 70%，聚合的按覆盖根数变宽', () => {
    const wide = { from: 0, count: 100 } as ChartWindow;
    expect(bodyWidthFraction(0, 0, wide)).toBeCloseTo(0.007, 6);
    expect(bodyWidthFraction(0, 9, wide), '十根并一根').toBeCloseTo(0.07, 6);
  });
});

describe('纵轴：priceDomain / yFraction / priceAtFraction', () => {
  const items = drawCandles(series(5, 3_600_000, () => ({ h: 110, l: 90 })), { from: 0, count: 5 }, 180).items;

  it('范围包住所有高低点，并留出上下白边', () => {
    const d = priceDomain(items);
    expect(d.min).toBeLessThan(90);
    expect(d.max).toBeGreaterThan(110);
  });

  it('纵轴 0 = 最高价、1 = 最低价，中点在中间', () => {
    const d = { min: 100, max: 200 };
    expect(yFraction(200, d)).toBe(0);
    expect(yFraction(100, d)).toBe(1);
    expect(yFraction(150, d)).toBe(0.5);
  });

  it('yFraction 与 priceAtFraction 互逆（价格轴标签与蜡烛必须落在同一条线上）', () => {
    const d = priceDomain(items);
    for (const p of [d.min, 95, 100, d.max]) expect(priceAtFraction(yFraction(p, d), d)).toBeCloseTo(p, 6);
  });

  it('整段横盘（max === min）时不炸成 NaN —— 那会让整张图空白且不报错', () => {
    const flat = drawCandles(series(5, 3_600_000, () => ({ o: 100, h: 100, l: 100, c: 100 })), { from: 0, count: 5 }, 180).items;
    const d = priceDomain(flat);
    expect(d.max).toBeGreaterThan(d.min);
    expect(Number.isFinite(yFraction(100, d))).toBe(true);
  });

  it('没有图元时给一个安全的默认范围', () => {
    expect(priceDomain([])).toEqual({ min: 0, max: 1 });
  });
});

describe('价格刻度：niceTicks', () => {
  it('落在范围内、严格升序、步长是 1/2/2.5/5 × 10^k 那一族', () => {
    const ticks = niceTicks(79000, 81000, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(79000);
      expect(t).toBeLessThanOrEqual(81000);
    }
    // 相邻差恒定（这就是「整齐」的定义）
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6);
  });

  it('80000 这个量级不会攒出 79999.999999 那种刻度值', () => {
    for (const t of niceTicks(79500, 80500, 5)) expect(Number.isInteger(t), String(t)).toBe(true);
  });

  it('小数量级的也能用（ETH 那一档、或极窄区间）', () => {
    const ticks = niceTicks(0, 0.1, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
  });

  it('min === max 时给一个刻度而不是空数组', () => {
    expect(niceTicks(100, 100)).toEqual([100]);
  });
});

describe('刻度与价格的文字', () => {
  it('千分位 + 位数跟着步长走', () => {
    expect(formatAxisPrice(80000, 200)).toBe('80,000');
    expect(formatAxisPrice(80000.5, 0.5)).toBe('80,000.5');
    expect(formatPrice(80000)).toBe('80,000.00');
    expect(formatPrice(3000.5)).toBe('3,000.50');
  });

  it('formatPct：0 不带正号（0 既不是涨也不是跌）', () => {
    expect(formatPct(0)).toBe('0.00%');
    expect(formatPct(1.5)).toBe('+1.50%');
    expect(formatPct(-0.75)).toBe('-0.75%');
  });
});

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

  it('刻度落在整点上，且数量受控', () => {
    // 24 根 1 小时线：从北京时间 00:00 起
    const cs = series(24, 3_600_000, () => ({}));
    const shifted = cs.map((c, i) => mk(BEIJING_MIDNIGHT + i * 3_600_000, c[1], c[2], c[3], c[4], c[5]));
    const items = drawCandles(shifted, { from: 0, count: 24 }, 180).items;
    const ticks = timeTicks(items, 24 * 3_600_000, 6);

    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks[0].label, '半夜那一个是日期').toBe('09-23');
    expect(ticks[1].label).toBe('04:00');
    expect(ticks[2].label).toBe('08:00');
    // 刻度必须指向真实存在的图元，且不重复
    expect(new Set(ticks.map((t) => t.index)).size).toBe(ticks.length);
    for (const t of ticks) expect(items[t.index]).toBeTruthy();
  });

  it('聚合之后仍然能吸附上（桶起点与整点未必对齐）', () => {
    const cs = series(240, 60_000, () => ({}));
    const items = drawCandles(cs, { from: 0, count: 240 }, 40).items;
    const ticks = timeTicks(items, 240 * 60_000, 6);
    expect(ticks.length).toBeGreaterThan(1);
    for (const t of ticks) expect(Number.isFinite(t.index)).toBe(true);
  });

  it('没有图元时给空数组', () => {
    expect(timeTicks([], 3_600_000)).toEqual([]);
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
