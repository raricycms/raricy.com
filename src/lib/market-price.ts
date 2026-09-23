// ─────────────────────────────────────────────────────────────────────────────
// market-price.ts — 练手盘的行情源（币安公开行情域）
//
// 【数据源为什么是 data-api.binance.vision】
//   生产服务器是**阿里云中国大陆**（116.62.179.232）。实测从大陆裸连：
//     · api.binance.com / api.coingecko.com / www.okx.com / api.coinbase.com
//       / api.kraken.com / api.mexc.com / www.bitstamp.net —— 要么超时要么被 DNS 投毒
//       （binance.com 解析到 157.240.17.14，那是 Facebook 的段；okx.com 解析到北大 IP）
//     · data-api.binance.vision —— 200 / ~450ms，连打 6 次无抖动；解析到真实 AWS
//       东京 IP，TLS 证书 `issuer=Amazon, subject=CN=*.binance.vision`（不是中间人假站）
//   它是币安拆出来的**纯行情公共域**，不要 key、不吃签名，自报配额 6000 权重/分。
//   api.gateio.ws 实测也可达，留作后备源（改 MARKET_PRICE_BASE_URL 即可换）。
//
// 【为什么基址必须可配】两个理由，都不是洁癖：
//   1. **e2e 不能打真实外网** —— 否则用例的成败取决于币安当时通不通、价格是多少。
//      e2e 里把 MARKET_PRICE_BASE_URL 指向 tests/e2e/mock-market-price.ts。
//   2. **上线保险** —— 万一阿里云出口连 .vision 也不通，改一行环境变量换源，
//      不用改代码、不用发版。
//
// 【★ 安全边界：展示可以缓存，成交不行 ★】
//   getCachedQuotes() 是**展示**用的，允许拿旧价；fetchQuote() 是**成交**用的，必须现取。
//   写成「成交时缓存兜底」= 看盘的人可以在价格跳动后、缓存刷新前下单 —— 那是无风险、
//   可重复、无上限的套利，不需要任何交易水平。整个功能的安全性就压在这一条上。
//
// 【两层价：WS 实时 + REST 兜底】展示缓存有**两个写入者**，合并发生在**读**的时候：
//   · market-stream.ts 的常驻 WebSocket（订 @trade）→ applyStreamTick() 写进 `stream` 字段
//   · market-poll-drainer.ts 每 15 秒的 REST 刷新 → refreshQuotes() 整份覆盖 `cache`
// 读侧 getCachedQuotes() **逐标的**挑：那一帧还在 STREAM_TRUST_MS 之内就用 WS 的，
// 否则回落到 REST 那份。于是 WS 挂掉时屏幕在 10 秒内自动降级、**不会冻住**；REST 那条
// 15 秒的循环一个字符都没动，它现在同时是兜底价源。24h 涨跌幅仍由 REST 给（WS 不带，
// 而一个 24 小时口径的百分数 15 秒旧完全无所谓）。
// ⚠️ WS 那份**不能写进 `cache`** —— refreshQuotes() 是整份覆盖写，每 15 秒会把它抹掉。
// ⚠️ 这条流**只喂展示**：成交仍然 fetchQuote() 现取，上面那条安全边界不因它松动。
//
// 阈值都有实测依据（2026-09-22 生产机，10 分钟）：0 重连、53828 tick、合计最长静默
// 0.9s、事件时间差 30~54ms（对照 REST 一次往返 402ms）。**单标的**可以冷清到 3.5 秒
// （BTC 那次），所以信任窗按单标的算、取 10 秒（3× 余量）；而「半死」判据必须盯
// **合计**静默（见 market-stream.ts）——按单标的判会把一次正常冷清误判成断流。
//
// 【两把钟不要混】缓存龄用「真实 UTC 毫秒」（fetchedAtMs，两边都是 Date.now()）；
//   写进 position 行的 quotedAt 用 nowForDb()（库内墙上时间）。两者各管各的，
//   绝不互相相减 —— 见 src/lib/db-time.ts 的来龙去脉。
//   K 线的 openTime 是**第三样东西**：交易所给的真实 UTC 毫秒（与 Date.now() 同一把尺子，
//   可以相减），但它**不是**库内那套「UTC+8 墙上时间贴 Z」。图表要按本站钟面显示时，
//   得先加 SITE_TZ_OFFSET_MS 再用 getUTC* 读 —— 而绝不可拿它去和库内时间戳比大小。
//
// 【★ 缓存住在 globalThis 上，不是模块级变量 ★】轮询器（ instrumentation 图）与
//   请求处理（应用图）是**两份编译产物**，模块级变量等于两份缓存 —— 症状是页面上的
//   价永远冻住且不报错。展开见下方 GLOBAL_KEY 处。
// ─────────────────────────────────────────────────────────────────────────────

import { nowForDb } from './db-time';
import {
  CANDLE_LIMIT,
  DEFAULT_INTERVAL,
  candleKey,
  type CandleTuple,
  type MarketInterval,
} from './market-candles';

/** 练手盘支持的标的。加币要同步 prisma/schema.prisma 的注释与页面文案。 */
export const MARKET_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

/** 币安公开行情域。可用 MARKET_PRICE_BASE_URL 覆盖（见文件头两条理由）。 */
const DEFAULT_BASE_URL = 'https://data-api.binance.vision';

/** 单次出站超时。行情是同步等待的（用户点了下单就在等），所以要比 5s 的量级更短。 */
const FETCH_TIMEOUT_MS = 3000;

/**
 * 展示缓存的保鲜期。轮询间隔（market-poll-drainer 默认 15s）的两倍多一点 ——
 * 允许漏掉一轮不立刻标脏，连续两轮拉不到才说「数据可能过期」。
 */
export const QUOTE_STALE_MS = 40_000;

/**
 * WS 那一帧的**信任窗**：超过这么久没有新帧，就不再用它、回落到 REST 那条。
 *
 * 10 秒 = 实测最大**单标的**间隔（3501ms）的 3 倍。它决定的是「流挂了以后屏幕多久
 * 自动降级」—— 10 秒内回落到 REST（≤15 秒旧），不会出现「看着新鲜其实是冻住的」。
 * 与 market-stream.ts 的 `MARKET_STREAM_SILENCE_MS`（30 秒，合计静默 → 强制重连）
 * 是两个不同的判据：**显示可以先降级，组件后放弃重连**。
 */
export const STREAM_TRUST_MS = 10_000;

/** K 线缓存期。图表不需要秒级新鲜，60s 一档既省请求又看不出延迟。 */
const CANDLE_CACHE_MS = 60_000;

export interface Quote {
  symbol: MarketSymbol;
  /** 最新成交价（USDT）。 */
  price: number;
  /** 24h 涨跌幅（%）。现取单价的路径拿不到它，为 null。 */
  changePercent: number | null;
  /** 取到这笔价的**库内时刻**（nowForDb()）—— 写进 position 行做审计。 */
  quotedAt: Date;
}

/** 展示用的报价：多带上「这份数据有多旧」。 */
export interface CachedQuote extends Quote {
  /** 距上次成功刷新的毫秒数。两边都是真实 UTC 毫秒，与库内时间戳无关。 */
  ageMs: number;
  /** 超过 QUOTE_STALE_MS —— 页面要明说「行情可能不是最新的」。 */
  stale: boolean;
  /**
   * 这个价是从哪来的：`stream` = 常驻 WebSocket 那一帧，`poll` = 15 秒的 REST 轮询。
   * **只进接口响应供排障**（页面不渲染它）—— 判断「流是不是活着」以前只能靠日志。
   */
  source: QuoteSource;
}

export type QuoteSource = 'stream' | 'poll';

/** 取价失败。调用方（market-service）把它翻成 503，**绝不降级到缓存价成交**。 */
export class MarketPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketPriceError';
  }
}

/** 行情基址。每次读 env：测试可 stubEnv，无需重启进程语义。 */
export function priceBaseUrl(): string {
  const raw = (process.env.MARKET_PRICE_BASE_URL || '').trim();
  // 去掉尾斜杠，免得拼出 `//api/v3/...`
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

/** 入参里的 symbol 一律过这里 —— 白名单之外的东西不许进 URL、不许进库。 */
export function parseSymbol(raw: unknown): MarketSymbol | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return (MARKET_SYMBOLS as readonly string[]).includes(s) ? (s as MarketSymbol) : null;
}

/** 币安返回的价格是十进制字符串，解析后必须是个正有限数 —— 否则当取价失败。 */
function parsePrice(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new MarketPriceError(`交易所返回了非法价格: ${JSON.stringify(raw)}`);
  }
  return n;
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      // 别让 Next 的 fetch 缓存把行情钉住 —— 这里的时间语义由我们自己管
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    throw new MarketPriceError(`行情源不可达: ${String(e)}`);
  }
  if (!res.ok) {
    throw new MarketPriceError(`行情源返回 ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    // 非 JSON 不炸出一堆栈 —— 归成取价失败，调用方统一处理
    throw new MarketPriceError('行情源返回的不是 JSON');
  }
}

/**
 * **现取**一批标的的价（成交专用）。
 *
 * 用 /ticker/price 而不是 /ticker/24hr：成交只需要价，24hr 的字段多、体积大、
 * 而且它的 lastPrice 与 ticker/price 是同一份数据。24h 涨跌幅由轮询那条路带。
 *
 * 任何失败都抛 MarketPriceError —— **没有「退回缓存」这一档**（见文件头）。
 */
export async function fetchQuotesLive(symbols: readonly MarketSymbol[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const qs = encodeURIComponent(JSON.stringify(symbols));
  const raw = await fetchJson(`${priceBaseUrl()}/api/v3/ticker/price?symbols=${qs}`);
  if (!Array.isArray(raw)) throw new MarketPriceError('行情源返回的形状不对（expected array）');

  const quotedAt = nowForDb();
  const bySymbol = new Map<string, number>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { symbol, price } = row as { symbol?: unknown; price?: unknown };
    if (typeof symbol !== 'string') continue;
    // 只收白名单内的 —— 交易所回什么我们不照单全收
    if (!(MARKET_SYMBOLS as readonly string[]).includes(symbol)) continue;
    bySymbol.set(symbol, parsePrice(price));
  }

  const missing = symbols.filter((s) => !bySymbol.has(s));
  if (missing.length > 0) {
    throw new MarketPriceError(`行情源没有返回这些标的: ${missing.join(', ')}`);
  }
  return symbols.map((symbol) => ({
    symbol,
    price: bySymbol.get(symbol)!,
    changePercent: null,
    quotedAt,
  }));
}

/**
 * **现取单个标的**的价。成交路径的唯一入口。
 *
 * 与 fetchQuotesLive 分开是因为成交只需要一个标的，少一个数组解析步骤、
 * 且返回形状更直白。两者都不降级。
 */
export async function fetchQuote(symbol: MarketSymbol): Promise<Quote> {
  const raw = await fetchJson(`${priceBaseUrl()}/api/v3/ticker/price?symbol=${symbol}`);
  if (!raw || typeof raw !== 'object') {
    throw new MarketPriceError('行情源返回的形状不对（expected object）');
  }
  const { price } = raw as { price?: unknown };
  return { symbol, price: parsePrice(price), changePercent: null, quotedAt: nowForDb() };
}

// ── 展示缓存（轮询写入，页面与 /quote 接口只读） ──────────────────────────────

interface CacheState {
  quotes: Quote[];
  /** 上次成功刷新的真实 UTC 毫秒。**不存库内时间戳** —— 见文件头「两把钟不要混」。 */
  fetchedAtMs: number;
}

interface CandleCacheEntry {
  candles: CandleTuple[];
  fetchedAtMs: number;
}

/**
 * ★ 行情缓存的唯一真身住在 `globalThis` 上，**不要改回模块级变量** ★
 *
 * 【为什么】Next 把 `src/instrumentation.ts` 编进**独立的 webpack compilation**，
 * 于是本文件在同一份构建产物里存在**两份模块实例** —— 实测（`next build` 产物）：
 *   · `chunks/7345.js` 的 module 7345 —— 轮询器那一份，含 `[market-poller]` 日志
 *   · `chunks/5856.js` 的 module 25198 —— 页面与三个接口那一份
 *
 * 模块级的 `let cache` 会跟着变成**两个互不相干的变量**：轮询器每 15 秒勤快地刷
 * 自己那一份，而请求处理读的是另一份；`getCachedQuotes()` 又只在缓存为空时才去拉一次
 * —— 于是页面上那个价从第一次渲染起**永远不再变**，而且**不报任何错**。
 * 2026-09 实测症状：BTC 半小时振幅 $375，页面上纹丝不动。
 *
 * 挂到 `globalThis` 上，两份实例就共用同一个对象。webhook-drainer 把定时器挂在
 * globalThis 上是同一个理由（那边的状态本来就在库表里，所以只有定时器需要）。
 *
 * 【单进程前提】见 docs/architecture.md §2 —— 多实例部署时每个进程各有一份缓存，
 * 只是各自多刷几次，不影响正确性（轮询是幂等的只读 GET）。
 * 回归测试见 tests/unit/market-price.test.ts 的「缓存跨模块实例共享」。
 */
const GLOBAL_KEY = '__raricyMarketPriceState';

interface MarketPriceState {
  /** 展示缓存（REST 轮询写的那一份）。null = 还没成功拉过。 */
  cache: CacheState | null;
  /**
   * K 线缓存，键 `${symbol}:${interval}:${limit}`（见 market-candles.ts 的 candleKey）。
   * ⚠️ **周期必须在键里**：少写它，切到 4h 会原样读回 1h 那一份，且不报任何错
   * （2026-09 改版前就是这样 —— 那时 interval 还硬编码在 URL 里，所以没暴露）。
   */
  candles: Map<string, CandleCacheEntry>;
  /**
   * WS 实时价（market-stream.ts 写的那一份）。null = 还没收到过任何帧。
   *
   * ⚠️ **与 `cache` 平级，不是它的一部分** —— `refreshQuotes()` 整份覆盖 `cache`，
   * 写进去的东西每 15 秒会被抹一次。合并只在 `getCachedQuotes()` 里做。
   */
  stream: { prices: Map<string, { price: number; atMs: number }> } | null;
}

/** 取（必要时建）那份共享状态。两份模块实例拿到的是同一个对象。 */
function priceState(): MarketPriceState {
  const g = globalThis as unknown as Record<string, unknown>;
  let s = g[GLOBAL_KEY] as MarketPriceState | undefined;
  if (!s) {
    s = { cache: null, candles: new Map(), stream: null };
    g[GLOBAL_KEY] = s;
  }
  return s;
}

/** 供轮询器、行情流与测试重置。**跨实例生效** —— 清的正是共享的那一份。 */
export function __resetPriceCache(): void {
  const s = priceState();
  s.cache = null;
  s.candles.clear();
  // WS 那份也要清：它是跨测试文件共享的同一份状态，留着会让「这个价来自哪」的断言
  // 静默失真（前一个文件留下的帧被后一个文件读走）。
  s.stream = null;
}

/**
 * 刷一次缓存（展示用，带 24h 涨跌幅）。失败**不抛** —— 轮询器不该因为一次网络抖动
 * 就打日志刷屏，调用方读 ageMs 就知道数据新不新。
 *
 * 用 /ticker/24hr 是因为它一次把价与涨跌幅都给全，省一半请求。
 */
export async function refreshQuotes(): Promise<boolean> {
  try {
    const qs = encodeURIComponent(JSON.stringify(MARKET_SYMBOLS));
    const raw = await fetchJson(`${priceBaseUrl()}/api/v3/ticker/24hr?symbols=${qs}`);
    if (!Array.isArray(raw)) return false;

    const quotedAt = nowForDb();
    const rows = new Map<string, { price: number; changePercent: number | null }>();
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { symbol?: unknown; lastPrice?: unknown; priceChangePercent?: unknown };
      if (typeof r.symbol !== 'string') continue;
      if (!(MARKET_SYMBOLS as readonly string[]).includes(r.symbol)) continue;
      try {
        const cp = Number(r.priceChangePercent);
        rows.set(r.symbol, {
          price: parsePrice(r.lastPrice),
          changePercent: Number.isFinite(cp) ? cp : null,
        });
      } catch {
        // 单个标的的数据有问题就跳过它，别让整轮刷新失败
      }
    }
    if (rows.size === 0) return false;

    priceState().cache = {
      quotes: MARKET_SYMBOLS.filter((s) => rows.has(s)).map((symbol) => ({
        symbol,
        price: rows.get(symbol)!.price,
        changePercent: rows.get(symbol)!.changePercent,
        quotedAt,
      })),
      fetchedAtMs: Date.now(),
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * WS 那一帧的写入口。**唯一** —— market-stream.ts 收到每个 @trade 都调它一次。
 *
 * 白名单与「有限正数」两道校验都在这儿做：交易所回什么我们不照单全收（同 fetchQuotesLive）。
 * 键固定走 `parseSymbol`，所以库里/缓存里不会有白名单外的标的。
 */
export function applyStreamTick(rawSymbol: unknown, price: unknown, atMs: number): void {
  const symbol = parseSymbol(rawSymbol);
  if (!symbol) return;
  const p = typeof price === 'number' ? price : NaN;
  if (!Number.isFinite(p) || p <= 0) return;
  if (!Number.isFinite(atMs)) return;
  const s = priceState();
  if (!s.stream) s.stream = { prices: new Map() };
  s.stream.prices.set(symbol, { price: p, atMs });
}

/**
 * 读展示报价。带「多旧」。
 *
 * 缓存为空时会尝试现拉一次（页面首次渲染的路径）；拉不到就返回空数组 + `ok: false`，
 * 由页面显示「行情暂不可用」—— **绝不编一个价出来**。
 *
 * 【两个源怎么合】逐标的挑：WS 那一帧还在 STREAM_TRUST_MS 之内就用它，否则用 REST 那份。
 * `ageMs` 取自被选中的那一个源，所以「流挂了但轮询还活着」时页面上的数据龄会自动变大，
 * 40 秒那道 `stale` 提示照旧说真话。
 *
 * ⚠️ **不拿 WS 单独撑起一份报价**：`cache` 为空时仍然返回 `ok: false`，哪怕流里有价。
 * 展示的可用性跟着**成交**走 —— 成交那条路用的是同一个行情源（`fetchQuote`），它挂了
 * 的时候给一个你买不进的价只会误导（路由会 503 拒单）。
 */
export async function getCachedQuotes(): Promise<{ quotes: CachedQuote[]; ok: boolean }> {
  const s = priceState();
  if (!s.cache) await refreshQuotes();
  // 必须在 await 之后再取一次：刷新正是往这份共享状态里写的
  const hit = s.cache;
  if (!hit) return { quotes: [], ok: false };

  // 两边都是真实 UTC 毫秒 —— 不涉及库内时间戳，见文件头
  const now = Date.now();
  const pollAgeMs = Math.max(0, now - hit.fetchedAtMs);
  const stream = s.stream;

  return {
    quotes: hit.quotes.map((q) => {
      const tick = stream?.prices.get(q.symbol);
      const streamAgeMs = tick ? Math.max(0, now - tick.atMs) : Infinity;
      if (tick && streamAgeMs <= STREAM_TRUST_MS) {
        // 价用流里的；changePercent 仍来自 REST 那份（WS 的 @trade 帧不带 24h 涨跌幅）
        return {
          ...q,
          price: tick.price,
          ageMs: streamAgeMs,
          stale: streamAgeMs > QUOTE_STALE_MS,
          source: 'stream' as const,
        };
      }
      return { ...q, ageMs: pollAgeMs, stale: pollAgeMs > QUOTE_STALE_MS, source: 'poll' as const };
    }),
    ok: true,
  };
}

// ── K 线（图表用，短缓存。与展示缓存同住一份 globalThis 状态） ────────────────

/** limit 夹到 [1, CANDLE_LIMIT] —— 币安对超限直接报错，别指望调用方守规矩。 */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return CANDLE_LIMIT;
  return Math.min(CANDLE_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * 币安 kline 行 → 六元组。形状见 market-candles.ts 的 CandleTuple。
 *
 * 【坏行只丢那一行】一行脏数据不该让整张图消失 —— 与 `refreshQuotes` 里
 * 「单个标的的数据有问题就跳过它」同款。六项里前五项必须有限且为正（价格不可能 ≤ 0），
 * 量可以正好是 0（那一根没人成交），所以只要求 ≥ 0。
 *
 * 【出门前排一次序、去掉重复时刻】图表数学（窗口 / 聚合 / 命中测试）假定这条序列
 * **严格递增**，而交易所偶尔会给乱序或同一 openTime 的行。重复时刻留**后到的那根**。
 */
function parseKlines(raw: unknown[]): CandleTuple[] {
  const rows: CandleTuple[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (![t, o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    if (!Number.isFinite(v) || v < 0) continue;
    rows.push([t, o, h, l, c, v]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out: CandleTuple[] = [];
  for (const r of rows) {
    if (out.length > 0 && out[out.length - 1][0] === r[0]) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

/**
 * 取一段 K 线（图表用）。失败返回空数组 —— 图是装饰，缺了不该让整页 500。
 *
 * 【★ 与 fetchQuote 的区别：这份也是展示 ★】它落在 globalThis 的 K 线缓存里、有 60 秒
 * 保鲜期，**绝不可拿来成交**（同 getCachedQuotes）。成交只有 `fetchQuote()` 一条路。
 *
 * 【格式与周期】完整六元组（开高低收 + 量）都留着 —— 蜡烛图与成交量柱都要用，
 * 不是只画一条收盘价曲线。周期走白名单类型，拼进 URL 的不可能是白名单外的东西。
 *
 * 缓存键带上 interval 与 limit；`limit` 由本函数夹逼后再进键，所以 `limit=99999`
 * 与 `limit=1000` 是同一格缓存，不会各存一份。
 */
export async function getCandles(
  symbol: MarketSymbol,
  interval: MarketInterval = DEFAULT_INTERVAL,
  limit: number = CANDLE_LIMIT
): Promise<CandleTuple[]> {
  const n = clampLimit(limit);
  const key = `${candleKey(symbol, interval)}:${n}`;
  const hit = priceState().candles.get(key);
  if (hit && Date.now() - hit.fetchedAtMs < CANDLE_CACHE_MS) return hit.candles;

  try {
    const raw = await fetchJson(
      `${priceBaseUrl()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${n}`
    );
    if (!Array.isArray(raw)) return hit?.candles ?? [];
    const candles = parseKlines(raw);
    if (candles.length === 0) return hit?.candles ?? [];
    priceState().candles.set(key, { candles, fetchedAtMs: Date.now() });
    return candles;
  } catch {
    return hit?.candles ?? [];
  }
}
