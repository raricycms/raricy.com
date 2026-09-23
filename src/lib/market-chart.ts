// ─────────────────────────────────────────────────────────────────────────────
// market-chart.ts — K 线图的全部**纯计算**：窗口、聚合、刻度、映射、实时并线
//
// 【为什么单独一个模块】图表组件里最容易出错、又最难靠肉眼发现的部分全是算术：
// 缩放的锚点在不在指针下、拖动到两端会不会越界、缩到最远时那一根是不是真的一根
// 还是几十根的聚合、时间轴标签落没落在整点上。这些都不该和 SVG / 事件处理搅在一起
// —— 分出来之后它们能在 jsdom 之外被逐条钉住（tests/unit/market-chart.test.ts）。
//
// 【零依赖（外加一个常量）】唯一的值导入是 db-time.ts 的 `SITE_TZ_OFFSET_MS` ——
// 时间轴要按**本站钟面**（UTC+8）显示。db-time.ts 自己零 import，客户端组件值导入它
// 是有先例的（src/app/chat/ChatMessageItem.tsx）。**别 import market-price.ts** ——
// 那边带着服务端代码，客户端组件进不去。
//
// 【三把钟，这里只用其中一把】K 线的 openTime 是**真实 UTC 毫秒**（与 Date.now()
// 同一把尺子，可以相减）—— 本模块所有时刻都是它。库内那套「UTC+8 墙上时间贴 Z」
// 与这里无关；展示时把 openTime 加 SITE_TZ_OFFSET_MS 再 getUTC* 读出来，就得到
// 北京时间钟面（同 nowForDb 的手法）。本模块内部**不取当前时刻** —— 要「现在」
// 的调用方自己传（单测因此不需要冻时钟）。
// ─────────────────────────────────────────────────────────────────────────────

import { SITE_TZ_OFFSET_MS } from './db-time';
import type { CandleTuple } from './market-candles';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 最多可见多少根原始 K 线（再放大就顶住了）。低于它就没有「一根蜡烛」可看了。 */
export const MIN_VISIBLE_CANDLES = 20;

/** 切标的/切周期后的默认视野：最近 120 根。 */
export const DEFAULT_VISIBLE_CANDLES = 120;

/**
 * 单次最多画几个图元。缩到 1000 根全看时，一根蜡烛不到一个像素 —— 那既看不清也
 * 白烧性能，所以相邻的几根会被**聚合成一根更粗的蜡烛**（见 drawCandles）。
 */
export const MAX_DRAWN_CANDLES = 180;

/** 蜡烛实体占自己那一格的比例（剩下的留给间隙）。 */
const BODY_RATIO = 0.7;

/** 价格轴上下留白比例 —— 最高最低贴着边框不好看，也读不出「还有空间」。 */
const PRICE_PAD_RATIO = 0.08;

// ── 视口（窗口）──────────────────────────────────────────────────────────────

/**
 * 视口：原始下标区间 `[from, from + count)`。
 *
 * `from` 是**小数**——拖动因此是连续的（按整数走的话每次跳一根蜡烛，120 根时
 * 一格约 5px，拖起来一顿一顿的）。`count` 是整数（缩放档位），最小 20 根。
 */
export interface ChartWindow {
  from: number;
  count: number;
}

/** 贴右端的默认视野（图上最新那一根在最右边）。 */
export function resetWindow(len: number, visible = DEFAULT_VISIBLE_CANDLES): ChartWindow {
  const count = Math.min(Math.max(MIN_VISIBLE_CANDLES, Math.floor(visible)), Math.max(1, len));
  return { from: Math.max(0, len - count), count };
}

/** 夹进数据范围内：左边不早于第一根，右边不晚于最后一根。 */
export function clampWindow(w: ChartWindow, len: number): ChartWindow {
  if (len <= 0) return { from: 0, count: MIN_VISIBLE_CANDLES };
  const count = Math.min(Math.max(MIN_VISIBLE_CANDLES, w.count), Math.max(MIN_VISIBLE_CANDLES, len));
  const maxFrom = Math.max(0, len - count);
  return { from: Math.min(Math.max(0, w.from), maxFrom), count };
}

/**
 * 缩放。`factor > 1` = 放大（可见根数变少）。
 *
 * `anchorIndex` 是**指针下那一根**的原始下标 —— 缩放前后它必须停在屏幕上的同一处，
 * 否则滚轮会变成「放大并同时往左跳」。做法是先算出它在窗口里的比例、再反解新窗口的
 * from（见文件里的测试「锚点不动」）。
 */
export function zoomWindow(
  w: ChartWindow,
  factor: number,
  anchorIndex: number,
  len: number
): ChartWindow {
  if (!Number.isFinite(factor) || factor <= 0) return w;
  const maxCount = Math.max(MIN_VISIBLE_CANDLES, len);
  const count = Math.min(Math.max(MIN_VISIBLE_CANDLES, Math.round(w.count / factor)), maxCount);
  const frac = w.count > 0 ? (anchorIndex + 0.5 - w.from) / w.count : 0.5;
  return clampWindow({ from: anchorIndex + 0.5 - frac * count, count }, len);
}

/** 平移。`deltaCandles` 为正 = 往右看（看到更晚的行情）。 */
export function panWindow(w: ChartWindow, deltaCandles: number, len: number): ChartWindow {
  if (!Number.isFinite(deltaCandles)) return w;
  return clampWindow({ from: w.from + deltaCandles, count: w.count }, len);
}

/** 原始下标 `i` 的**中心**在视口里的位置（0 = 最左，1 = 最右）。 */
export function xFraction(i: number, w: ChartWindow): number {
  return (i + 0.5 - w.from) / w.count;
}

/** 视口位置 → 最近的那一根原始下标。命中测试与缩放锚点都用它。 */
export function indexAtFraction(f: number, w: ChartWindow): number {
  return Math.round(w.from + f * w.count - 0.5);
}

// ── 聚合（缩到很远时把相邻几根并成一根）──────────────────────────────────────

/** 覆盖的原始下标区间（含两端）。 */
export interface DrawnCandle {
  i0: number;
  i1: number;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 视口里每根图元覆盖多少根原始 K 线（1 = 一根对一根）。 */
export function bucketSizeFor(count: number, maxDrawn = MAX_DRAWN_CANDLES): number {
  return Math.max(1, Math.ceil(Math.max(1, count) / Math.max(1, maxDrawn)));
}

/**
 * 把视口里的原始 K 线聚合成要画的图元：**桶的对齐锚在绝对下标上**
 * （`bucket(i) = floor(i / size)`），所以拖动时桶不会整体重排 —— 同一根原始 K 线
 * 永远属于同一个桶。
 *
 * ⚠️ **聚合不是造假**：一根粗蜡烛就是它覆盖的那几根的开高低收与成交量之和，
 * 与真身（币安）返回一根原生的大周期 K 线是同一件事。页面上要如实标出它是哪一段
 * （图例显示 `i0..i1`），别让人以为那是「一根 1 分钟线」。
 */
export function drawCandles(
  candles: readonly CandleTuple[],
  w: ChartWindow,
  maxDrawn = MAX_DRAWN_CANDLES
): { items: DrawnCandle[]; bucketSize: number } {
  const len = candles.length;
  if (len === 0) return { items: [], bucketSize: 1 };

  const size = bucketSizeFor(w.count, maxDrawn);
  const startIdx = Math.max(0, Math.floor(w.from));
  const endIdx = Math.min(len - 1, Math.ceil(w.from + w.count) - 1);
  const firstBucket = Math.floor(startIdx / size);
  const lastBucket = Math.floor(endIdx / size);

  const items: DrawnCandle[] = [];
  for (let b = firstBucket; b <= lastBucket; b++) {
    const start = b * size;
    const stop = Math.min(len - 1, start + size - 1);
    if (start > stop) continue;
    const head = candles[start];
    const tail = candles[stop];
    let high = head[2];
    let low = head[3];
    let volume = 0;
    for (let i = start; i <= stop; i++) {
      const c = candles[i];
      if (c[2] > high) high = c[2];
      if (c[3] < low) low = c[3];
      // 非有限值当 0 收（正常路径不会出现，但 NaN 落进 SVG 高度就是一根画不出来的柱子）
      volume += Number.isFinite(c[5]) ? c[5] : 0;
    }
    items.push({
      i0: start,
      i1: stop,
      openTime: head[0],
      open: head[1],
      high,
      low,
      close: tail[4],
      volume,
    });
  }
  return { items, bucketSize: size };
}

// ── 价格映射 ────────────────────────────────────────────────────────────────

export interface PlotDomain {
  min: number;
  max: number;
}

/** 视口内的高低点 → 纵轴范围（上下各留一点白）。整段横盘时给一个人造的窄区间，
 *  免得 `max === min` 让后面的除法炸成 NaN（那会让整张图空白且不报错）。 */
export function priceDomain(items: readonly DrawnCandle[], padRatio = PRICE_PAD_RATIO): PlotDomain {
  if (items.length === 0) return { min: 0, max: 1 };
  let min = items[0].low;
  let max = items[0].high;
  for (const it of items) {
    if (it.low < min) min = it.low;
    if (it.high > max) max = it.high;
  }
  let span = max - min;
  if (!(span > 0)) {
    // 所有 K 线一模一样（替身造的数据就可能这样）：给个 ±0.5% 的窄带
    const unit = Math.abs(max) * 0.005 || 1;
    min -= unit;
    max += unit;
    span = max - min;
  }
  const pad = span * padRatio;
  return { min: min - pad, max: max + pad };
}

/** 价格 → 纵轴位置（0 = 顶部，1 = 底部）。 */
export function yFraction(price: number, d: PlotDomain): number {
  const span = d.max - d.min;
  return span > 0 ? (d.max - price) / span : 0.5;
}

/** 纵轴位置 → 价格（价格轴上的标签据此定位）。 */
export function priceAtFraction(f: number, d: PlotDomain): number {
  return d.max - f * (d.max - d.min);
}

// ── 刻度 ────────────────────────────────────────────────────────────────────

/** 步长 → 该保留几位小数（0.5 要一位，200 要零位）。 */
function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step))));
}

/**
 * 价格轴上那几个「整」数：步长取 1 / 2 / 2.5 / 5 × 10^k 里最合适的一档。
 * 返回落在 [min, max] 内的刻度值（升序）。
 *
 * 累加时的浮点误差靠「先算第几个、再乘」避开 —— 逐个 `+= step` 在 80000 这种量级上
 * 会攒出 79999.999999 这样的刻度值。
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = mult * mag;
  const decimals = decimalsForStep(step);
  const out: number[] = [];
  // 用 1e-6 的相对容差收两端，免得 min/max 正好是刻度时被浮点误差漏掉
  const last = Math.floor(max / step + 1e-9);
  for (let k = Math.ceil(min / step - 1e-9); k <= last; k++) {
    out.push(Number((k * step).toFixed(decimals)));
  }
  return out;
}

/** 刻度值 → 轴上的文字。位数跟着步长走 + 千分位。**不用 toLocale***（见 db-time-guard）。 */
export function formatAxisPrice(v: number, step: number): string {
  return groupThousands(v.toFixed(decimalsForStep(step)));
}

/** 价格展示：保留 2 位小数并加千分位（持仓行、确认弹窗、图例共用同一份）。 */
export function formatPrice(n: number): string {
  return groupThousands(n.toFixed(2));
}

/** 涨跌幅：带符号，2 位小数。0 既不是涨也不是跌，所以不带正号。 */
export function formatPct(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 千分位。**别用 toLocaleString** —— 它按运行机器的时区/语言变，且是 db-time-guard 规则 4。 */
function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** 时间轴的步长阶梯（毫秒）。取「跨度 / 步长 ≤ maxTicks」里最小的一档。 */
const TIME_STEP_LADDER = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000,
  6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000,
];

/**
 * 时间轴刻度：先按跨度选一个步长，再把区间里每个**整点**就近吸附到某根已绘制的
 * K 线上 —— 标签用整点的钟面，位置用那一根。
 *
 * 【为什么不按可见根数等分取点】那样标签会随拖动左右漂移（「09-21」这行字每拖一格
 * 就挪一点），而真实行情软件的日期是**钉在时间上**的。吸附而不是「要求整点正好落在
 * 某根上」：聚合之后桶的起点与整点未必对齐，硬要精确对齐会一根标签都落不下。
 */
export function timeTicks(
  items: readonly DrawnCandle[],
  spanMs: number,
  maxTicks = 6
): { index: number; label: string }[] {
  if (items.length === 0) return [];
  const start = items[0].openTime;
  const end = items[items.length - 1].openTime;
  const span = Math.max(spanMs, end - start, 1);

  const step =
    TIME_STEP_LADDER.find((s) => span / s <= maxTicks) ?? TIME_STEP_LADDER[TIME_STEP_LADDER.length - 1];

  // 整点边界按**本站钟面**算：先平移到 UTC+8，对齐后再平移回来
  const off = SITE_TZ_OFFSET_MS;
  const first = Math.ceil((start + off) / step) * step;
  const out: { index: number; label: string }[] = [];
  let prevIndex = -1;
  for (let t = first; t <= end + off; t += step) {
    const wallMs = t - off;
    // 就近找一根：K 线的 openTime 严格递增（getCandles 出门前理过），线性扫足够
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < items.length; i++) {
      const gap = Math.abs(items[i].openTime - wallMs);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best === prevIndex) continue; // 同一个桶被两个整点吸附上了，只标一个
    prevIndex = best;
    out.push({ index: best, label: formatCandleTime(wallMs, span) });
  }
  return out;
}

/**
 * 时间标签（按本站钟面 UTC+8）：
 * 跨度 ≥ 30 天 → `YYYY-MM`；≥ 2 天 → `MM-DD`；更短 → `HH:MM`，但**零点换成日期**
 * —— 否则跨日的那张图上一整天只有一串时间，看不出是哪天。
 *
 * 阈值取 2 天而不是 1 天：正好 24 小时的那一档（1h × 24 根）在「≥1 天」的判据下
 * 会整排变成日期，把最容易读的时刻信息扔掉。
 */
export function formatCandleTime(ms: number, spanMs: number): string {
  const d = new Date(ms + SITE_TZ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  const mo = p(d.getUTCMonth() + 1);
  const da = p(d.getUTCDate());
  if (spanMs >= 30 * 86_400_000) return `${d.getUTCFullYear()}-${mo}`;
  if (spanMs >= 2 * 86_400_000) return `${mo}-${da}`;
  const hh = p(d.getUTCHours());
  const mm = p(d.getUTCMinutes());
  return hh === '00' && mm === '00' ? `${mo}-${da}` : `${hh}:${mm}`;
}

// ── 实时并线 ────────────────────────────────────────────────────────────────

export interface MergeResult {
  /** 并过之后的序列。**没有变化时返回原引用** —— 调用方据此跳过重渲染。 */
  candles: CandleTuple[];
  /** 展示价跨过了最后一根的桶边界：中间缺的那几根本模块不补，调用方据此重取一次。 */
  rolledOver: boolean;
}

/**
 * 把**展示价**并进最后一根 K 线（交易所的图就是这么动的：末根随每一笔成交长高长低）。
 *
 * 【★ 它只是展示 ★】并出来的那一根**绝不能**作为成交价 —— 成交只有 fetchQuote()
 * 一条路（见 market-price.ts 的文件头）。它落进的是客户端那份用于绘制的副本。
 *
 * 【跨桶了怎么办】把末根换成「当前这一桶」的新 K 线（open=high=low=close=该价），
 * **中间缺的那几根不补** —— 补出来就是编数据。调用方拿到 rolledOver 后去重取一次，
 * 真数据由那一趟带回来。不这么做（比如按「距上一根几个桶」补齐）会得到一串
 * 价格一模一样的平线，看起来像真的、其实是假的。
 *
 * `atMs` 必须是**真实 UTC 毫秒**（与 openTime 同一把尺子，可以相减）——
 * 库内那套墙上时间戳传进来会直接算错 8 小时，且不报任何错。
 */
export function mergeLivePrice(
  candles: CandleTuple[],
  price: number,
  atMs: number,
  intervalMs: number,
  maxLen: number
): MergeResult {
  const unchanged: MergeResult = { candles, rolledOver: false };
  if (candles.length === 0) return unchanged;
  if (!Number.isFinite(price) || price <= 0) return unchanged;
  if (!Number.isFinite(atMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) return unchanged;

  const last = candles[candles.length - 1];
  const bucketStart = last[0];

  if (atMs < bucketStart) return unchanged; // 时钟回拨/旧数据，不动

  if (atMs < bucketStart + intervalMs) {
    const close = price;
    const high = Math.max(last[2], price);
    const low = Math.min(last[3], price);
    if (close === last[4] && high === last[2] && low === last[3]) return unchanged;
    const next = candles.slice();
    next[next.length - 1] = [last[0], last[1], high, low, close, last[5]];
    return { candles: next, rolledOver: false };
  }

  const nowBucket = Math.floor(atMs / intervalMs) * intervalMs;
  const fresh: CandleTuple = [nowBucket, price, price, price, price, 0];
  const next = candles.concat([fresh]);
  if (maxLen > 0 && next.length > maxLen) next.splice(0, next.length - maxLen);
  return { candles: next, rolledOver: true };
}
