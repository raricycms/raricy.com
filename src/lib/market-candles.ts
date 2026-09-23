// ─────────────────────────────────────────────────────────────────────────────
// market-candles.ts — K 线的**词汇表**：周期、根数上限、线上形状、缓存键
//
// 【为什么单独一个模块】这份词汇有两个调用方，而它们必须**说同一套话**：
//   · 服务端 `market-price.getCandles()` —— 拿去拼币安的 URL、当缓存键
//   · 页面（客户端组件）—— 画周期档按钮、拼取数 URL、当客户端缓存键
// 键的形状在两处各写一遍，哪天改一处（比如给键加个前缀）就会**静默地**
// 同一份数据在两处对不上号。所以只此一处，两边 import 同一个。
//
// 【零依赖】与 market-math / fish-units / fish-amount 同款：`market-price.ts`
// 拖着 db-time 与服务端代码，客户端组件进不去（见 TradePanel 里那句 `import type` 的注释）。
// 本模块**不 import 任何东西**，所以两边都能值导入。
//
// 【周期是白名单，不是自由字符串】`interval` 会被拼进币安的 URL —— 与 symbol 同理，
// 白名单之外的东西一律不许进（`parseInterval` 是唯一的入口）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 练手盘支持的 K 线周期。加一档要同步三处：本数组、`INTERVAL_MS`、`INTERVAL_LABELS`
 * （后两个都是 `Record<MarketInterval, …>`，漏键 tsc 会当场报错）。
 */
export const MARKET_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export type MarketInterval = (typeof MARKET_INTERVALS)[number];

/** 页面首屏用的周期。换它 = 换首屏那张图，先看一眼 `CANDLE_LIMIT` 下的时间跨度。 */
export const DEFAULT_INTERVAL: MarketInterval = '1h';

/** 一档周期有多长（毫秒）。跨桶判定与时间轴刻度都读它，**别在别处另写一份**。 */
export const INTERVAL_MS: Record<MarketInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/**
 * 周期按钮上的文案。**刻意用币安那套 `1m / 1h / 1d`**（而不是「1分 / 1时 / 1日」）：
 * 它同时也是接口参数与 URL 上的那个字符串，按钮与参数长得一样就不会读错；
 * 而且加密行情的用户一眼认得出。
 *
 * ⚠️ 每个键都必须有值 —— 漏一个就是**一颗没有文字的空按钮**，不报错。
 */
export const INTERVAL_LABELS: Record<MarketInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

/**
 * 入参里的周期一律过这里。**只 trim，不折叠大小写** ——
 * 币安的 `1M`（月线）与 `1m`（分钟）是两个不同的周期，折叠大小写会把月线静默画成
 * 分钟线。白名单里没有的（含 `1M`）一律 null，由调用方回 400。
 */
export function parseInterval(raw: unknown): MarketInterval | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return (MARKET_INTERVALS as readonly string[]).includes(s) ? (s as MarketInterval) : null;
}

/**
 * 单次取多少根。**1000 是币安 `/api/v3/klines` 的上限**，超了它直接报错 ——
 * 夹逼放在 `getCandles` 里，别指望调用方。
 *
 * 它同时是「能往回看多远」的全部：缩放/平移只在已拿到的这一批里做，
 * 不做懒加载（拖到最早一根就停住）。各档覆盖的时间跨度：
 * 1m ≈ 16 小时 / 5m ≈ 3.5 天 / 15m ≈ 10 天 / 1h ≈ 41 天 / 4h ≈ 166 天 / 1d ≈ 2.7 年。
 */
export const CANDLE_LIMIT = 1000;

/** 自选列表那根小走势线画多少根（3 天 × 1h，与改版前那张图同跨度）。 */
export const SPARK_CANDLES = 72;

/**
 * 一根 K 线的**线上形状**：`[openTime, open, high, low, close, volume]`。
 *
 * 【为什么是定长元组而不是对象】1000 根要进 SSR payload 与接口响应，字段名重复一千遍
 * 是白白多几万字节；而且元组的序列化/反序列化不需要任何映射代码。
 * 代价是读的时候得记索引 —— 所以下面这行是权威：
 * ```
 *   0 = openTime（**真实 UTC 毫秒**，与库内那套「UTC+8 墙上时间贴 Z」不是一把钟）
 *   1 = open   2 = high   3 = low   4 = close   5 = volume
 * ```
 * `openTime` 是这一根**桶的起点**，由交易所给（币安 1d 对齐 UTC 零点，也就是本站钟面的 08:00）。
 */
export type CandleTuple = readonly [number, number, number, number, number, number];

/**
 * K 线缓存的键：`BTCUSDT:1h`。
 *
 * 服务端那份（`market-price.ts` 的 globalThis 缓存）与客户端那份（`useCandles`）**共用**
 * 这个形状 —— 两边说的「同一份数据」必须是同一件事。
 * ⚠️ 服务端还要在后面接上 `:${limit}`（那里 limit 是参数）；客户端只按 (标的, 周期) 存。
 */
export function candleKey(symbol: string, interval: MarketInterval): string {
  return `${symbol}:${interval}`;
}

/**
 * 自选列表走势线要的收盘价序列：末尾 `SPARK_CANDLES` 根的 close。
 * 从**同一批** K 线里切出来 —— 不再为那条小曲线单独取一次数（改版前是两处各取一份）。
 */
export function sparkCloses(candles: readonly CandleTuple[]): number[] {
  return candles.slice(-SPARK_CANDLES).map((c) => c[4]);
}
