// market-price 的单元测试。
//
// 【最要紧的一条是「成交不降级」】练手盘唯一的安全边界是：**成交价必须现取，
// 缓存只能用于展示**（见 src/lib/market-price.ts 的文件头）。这条性质靠「读代码时
// 看着像对的」保不住 —— 一次「失败时用缓存兜底」的善意改动就会把它拆掉，而拆掉之后
// 功能照常工作、测试照常绿，只有看盘的人在偷偷套利。所以这里钉一条专门的用例。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKET_SYMBOLS,
  MarketPriceError,
  STREAM_TRUST_MS,
  __resetPriceCache,
  applyStreamTick,
  fetchQuote,
  fetchQuotesLive,
  getCachedQuotes,
  getCandles,
  parseSymbol,
  priceBaseUrl,
  QUOTE_STALE_MS,
} from '@/lib/market-price';

/** 造一个只认识给定 JSON 的 fetch 替身。 */
function stubFetch(payload: unknown, init: { ok?: boolean; status?: number; raw?: string } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  // 形参声明出来是为了用例能断言「打到了哪个 URL」—— 不声明的话 mock.calls 是空元组
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    ({
      ok,
      status,
      json: async () => {
        if (init.raw !== undefined) return JSON.parse(init.raw);
        return payload;
      },
    }) as unknown as Response
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  __resetPriceCache();
  // 默认基址必须是「没配 env 时兜底的那个」—— 用例里断言 URL 时依赖它
  delete process.env.MARKET_PRICE_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.MARKET_PRICE_BASE_URL;
});

describe('菜名白名单：parseSymbol', () => {
  it('只放行白名单内的标的，大小写与空白归一', () => {
    expect(parseSymbol('BTCUSDT')).toBe('BTCUSDT');
    expect(parseSymbol('  ethusdt ')).toBe('ETHUSDT');
  });

  it('白名单之外一律 null —— 不允许任何东西进 URL 或进库', () => {
    for (const bad of ['DOGEUSDT', 'btc', '', 'BTC/USDT', '../../etc/passwd', null, 42, {}]) {
      expect(parseSymbol(bad)).toBeNull();
    }
  });

  it('白名单本身只有两个标的（加币要同步页面文案，别悄悄扩）', () => {
    expect([...MARKET_SYMBOLS]).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('基址可配：priceBaseUrl', () => {
  it('未配置时用币安公开行情域，并去掉尾斜杠', () => {
    expect(priceBaseUrl()).toBe('https://data-api.binance.vision');
    process.env.MARKET_PRICE_BASE_URL = 'https://example.test/';
    expect(priceBaseUrl()).toBe('https://example.test');
    process.env.MARKET_PRICE_BASE_URL = '   ';
    expect(priceBaseUrl()).toBe('https://data-api.binance.vision');
  });
});

describe('现取成交价：fetchQuote', () => {
  it('解析币安的真实形状（price 是十进制字符串）', async () => {
    stubFetch({ symbol: 'BTCUSDT', price: '81236.25000000' });
    const q = await fetchQuote('BTCUSDT');
    expect(q.symbol).toBe('BTCUSDT');
    expect(q.price).toBe(81236.25);
    // quotedAt 必须是**库内墙上时间**（nowForDb），不是真实 UTC —— 它要写进 position 行
    expect(q.quotedAt).toBeInstanceOf(Date);
  });

  it('打到单币端点上，且基址取 env', async () => {
    process.env.MARKET_PRICE_BASE_URL = 'https://example.test';
    const fn = stubFetch({ symbol: 'ETHUSDT', price: '3000' });
    await fetchQuote('ETHUSDT');
    expect(String(fn.mock.calls[0][0])).toBe('https://example.test/api/v3/ticker/price?symbol=ETHUSDT');
  });

  it('价格非法（0 / 负数 / NaN / 缺字段）一律当取价失败', async () => {
    for (const bad of ['0', '-1', 'abc', '', undefined, null, {}]) {
      stubFetch({ symbol: 'BTCUSDT', price: bad });
      await expect(fetchQuote('BTCUSDT'), `price=${JSON.stringify(bad)}`).rejects.toBeInstanceOf(
        MarketPriceError
      );
    }
  });

  it('非 200 / 非 JSON / 网络异常都抛 MarketPriceError', async () => {
    stubFetch({}, { ok: false, status: 503 });
    await expect(fetchQuote('BTCUSDT')).rejects.toBeInstanceOf(MarketPriceError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response)
    );
    await expect(fetchQuote('BTCUSDT')).rejects.toBeInstanceOf(MarketPriceError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => { throw new Error('ECONNRESET'); })
    );
    await expect(fetchQuote('BTCUSDT')).rejects.toBeInstanceOf(MarketPriceError);
  });

  // ★★★ 这条是整个功能的安全边界，别删也别「优化」掉 ★★★
  it('★ 缓存再新鲜也不许拿来成交：行情源挂了就必须拒单', async () => {
    // 先让缓存里有一份完全新鲜的价
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '1.0' }]);
    const cached = await getCachedQuotes();
    expect(cached.ok).toBe(true);
    expect(cached.quotes[0].price).toBe(80000);
    expect(cached.quotes[0].stale).toBe(false);

    // 现在行情源挂了 —— 现取必须失败，**绝不能**返回上面那个 80000
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('行情源挂了'); }));
    await expect(
      fetchQuote('BTCUSDT'),
      '成交路径降级到缓存价 = 看盘的人可以无风险套利，这条测试就是拦它的'
    ).rejects.toBeInstanceOf(MarketPriceError);
  });
});

describe('批量现取：fetchQuotesLive', () => {
  it('一次拿多个标的，顺序按入参', async () => {
    stubFetch([
      { symbol: 'ETHUSDT', price: '3000' },
      { symbol: 'BTCUSDT', price: '80000' },
    ]);
    const out = await fetchQuotesLive(['BTCUSDT', 'ETHUSDT']);
    expect(out.map((q) => q.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(out.map((q) => q.price)).toEqual([80000, 3000]);
  });

  it('行情源漏了标的 → 整体失败（不许静默少一个）', async () => {
    stubFetch([{ symbol: 'BTCUSDT', price: '80000' }]);
    await expect(fetchQuotesLive(['BTCUSDT', 'ETHUSDT'])).rejects.toBeInstanceOf(MarketPriceError);
  });

  it('白名单外的标的混在应答里一律丢弃；空入参不发请求', async () => {
    const fn = stubFetch([{ symbol: 'DOGEUSDT', price: '1' }]);
    await expect(fetchQuotesLive(['BTCUSDT'])).rejects.toBeInstanceOf(MarketPriceError);
    expect(fn).toHaveBeenCalledTimes(1);

    fn.mockClear();
    expect(await fetchQuotesLive([])).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('展示缓存：getCachedQuotes', () => {
  it('缓存为空且拉不到时返回 ok:false —— 绝不编一个价出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('挂了'); }));
    const r = await getCachedQuotes();
    expect(r.ok).toBe(false);
    expect(r.quotes).toEqual([]);
  });

  it('缓存为空时会现拉一次（页面首次渲染的路径）', async () => {
    const fn = stubFetch([{ symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '2.5' }]);
    const r = await getCachedQuotes();
    expect(r.ok).toBe(true);
    expect(r.quotes[0].changePercent).toBe(2.5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('超过保鲜期标记 stale；未超过不标', async () => {
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '0' }]);
    await getCachedQuotes();

    // 龄 = 真实 UTC 毫秒相减（不是库内时间戳），所以这里用假时钟推 Date.now()
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + QUOTE_STALE_MS - 1000);
    const fresh = await getCachedQuotes();
    expect(fresh.quotes[0].stale).toBe(false);

    vi.setSystemTime(Date.now() + 5000);
    const old = await getCachedQuotes();
    expect(old.quotes[0].stale).toBe(true);
    expect(old.quotes[0].ageMs).toBeGreaterThanOrEqual(QUOTE_STALE_MS);
    vi.useRealTimers();
  });

  it('刷新失败时沿用上次成功的缓存（展示可以旧，成交不行）', async () => {
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '0' }]);
    await getCachedQuotes();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('挂了'); }));
    const again = await getCachedQuotes();
    expect(again.ok).toBe(true);
    expect(again.quotes[0].price).toBe(80000);
  });
});

// ── WS 实时价（market-stream 写的那一份）与 REST 轮询的合并 ──────────────────

describe('两个价源怎么合', () => {
  const seedPoll = async (price = '80000') => {
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: price, priceChangePercent: '0' }]);
    await getCachedQuotes(); // 惰性刷出 REST 那份
  };

  it('流里的帧够新就用它，并标出来源是 stream', async () => {
    await seedPoll();
    applyStreamTick('BTCUSDT', 81234.5, Date.now());

    const r = await getCachedQuotes();
    expect(r.quotes[0].price).toBe(81234.5);
    expect(r.quotes[0].source).toBe('stream');
    // 涨跌幅仍然来自 REST 那份（@trade 帧不带 24h 涨跌幅），不是被这一帧带成 null
    expect(r.quotes[0].changePercent).toBe(0);
  });

  it('★ 超过信任窗就回落到轮询那份 —— 流挂了屏幕不能冻住', async () => {
    await seedPoll();
    applyStreamTick('BTCUSDT', 81234.5, Date.now());
    expect((await getCachedQuotes()).quotes[0].source).toBe('stream');

    // 推进到信任窗之外，且**没有新帧**（模拟流挂了/半死）
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + STREAM_TRUST_MS + 1);
    const fallen = await getCachedQuotes();
    expect(fallen.quotes[0].price, '回落到 REST 那份，而不是继续显示最后一帧').toBe(80000);
    expect(fallen.quotes[0].source).toBe('poll');
  });

  it('只对收到帧的标的发生效（另一个仍是轮询价）', async () => {
    stubFetch([
      { symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '0' },
      { symbol: 'ETHUSDT', lastPrice: '3000', priceChangePercent: '0' },
    ]);
    await getCachedQuotes();
    applyStreamTick('BTCUSDT', 81234.5, Date.now());

    const r = await getCachedQuotes();
    expect(r.quotes.find((q) => q.symbol === 'BTCUSDT')).toMatchObject({ source: 'stream' });
    expect(r.quotes.find((q) => q.symbol === 'ETHUSDT')).toMatchObject({
      price: 3000,
      source: 'poll',
    });
  });

  it('白名单之外 / 非法价一律不进缓存', async () => {
    await seedPoll();

    expect(() => {
      applyStreamTick('DOGEUSDT', 1, Date.now()); // 不在白名单
      applyStreamTick('BTCUSDT', 0, Date.now()); // 非正
      applyStreamTick('BTCUSDT', Number.NaN, Date.now()); // 非有限
      applyStreamTick('BTCUSDT', 1, Number.NaN); // 时刻非法
    }).not.toThrow();

    const r = await getCachedQuotes();
    expect(r.quotes[0], '四次都不该写进去，仍然是轮询那份').toMatchObject({
      price: 80000,
      source: 'poll',
    });
  });

  it('★ 流里有价也不许拿来成交：fetchQuote 照样向交易所现取', async () => {
    const fn = stubFetch({ symbol: 'BTCUSDT', price: '80000' });
    applyStreamTick('BTCUSDT', 81234.5, Date.now());

    const q = await fetchQuote('BTCUSDT');
    expect(q.price, '成交价必须来自刚才那次现取，不是流里那一帧').toBe(80000);
    expect(String(fn.mock.calls[0][0])).toContain('/api/v3/ticker/price?symbol=BTCUSDT');
  });
});

describe('缓存跨模块实例共享', () => {
  // ★★★ 这条拦的是「页面上的价永远冻住」，别删 ★★★
  //
  // Next 把 `src/instrumentation.ts` 编进**独立的 webpack compilation**，于是
  // `src/lib/market-price.ts` 在同一份构建产物里存在**两份模块实例**（实测：
  // `.next/server/chunks/7345.js` 的 module 7345 = 轮询器那一份，
  // `chunks/5856.js` 的 module 25198 = 页面与三个接口那一份）。
  //
  // 展示缓存若挂在**模块作用域**，它就会跟着变成两个互不相干的变量：轮询器每 15 秒
  // 勤快地刷自己那一份，请求处理读的是另一份，而 getCachedQuotes() 只在缓存为空时
  // 才去拉一次 —— 页面上那个价从第一次渲染起**永远不再变，且不报任何错**。
  // 2026-09 线上症状：BTC 半小时振幅 $375，页面纹丝不动。
  //
  // vi.resetModules() 之后重新 import，得到的正是「第二个 compilation 手里那份实例」。
  it('★ 第二份实例读得到第一份写进去的价，而不是自己去拉一次', async () => {
    vi.resetModules();
    const a = await import('@/lib/market-price');
    a.__resetPriceCache();
    const first = stubFetch([{ symbol: 'BTCUSDT', lastPrice: '11111', priceChangePercent: '0' }]);
    expect(await a.refreshQuotes()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);

    // 第二份实例登场。缓存若没共享，它会因为「自己是空的」再去拉一次，拿到 22222
    vi.resetModules();
    const b = await import('@/lib/market-price');
    const second = stubFetch([{ symbol: 'BTCUSDT', lastPrice: '22222', priceChangePercent: '0' }]);
    const r = await b.getCachedQuotes();

    expect(r.ok).toBe(true);
    expect(r.quotes[0].price, '读到的必须是第一份实例写进去的那个价').toBe(11111);
    expect(second, '第二份实例自己去拉 = 它那份缓存再也不会被刷新 = 页面上的价又冻住了').not.toHaveBeenCalled();
  });

  it('重置也跨实例生效（beforeEach 拿的是第一份，清理的必须是共享的那一份）', async () => {
    vi.resetModules();
    const other = await import('@/lib/market-price');
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: '11111', priceChangePercent: '0' }]);
    await other.refreshQuotes();

    __resetPriceCache(); // 本文件静态 import 的那一份
    const after = await import('@/lib/market-price');
    const fn = stubFetch([{ symbol: 'BTCUSDT', lastPrice: '33333', priceChangePercent: '0' }]);
    const r = await after.getCachedQuotes();
    expect(r.quotes[0].price).toBe(33333);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('★ WS 那份也一样：写进共享状态才读得到，模块级就是「页面冻住」重演', async () => {
    vi.resetModules();
    const a = await import('@/lib/market-price');
    a.__resetPriceCache();
    stubFetch([{ symbol: 'BTCUSDT', lastPrice: '11111', priceChangePercent: '0' }]);
    await a.refreshQuotes();

    // 第二份实例（＝ instrumentation 图那份）收到一帧
    vi.resetModules();
    const b = await import('@/lib/market-price');
    b.applyStreamTick('BTCUSDT', 22222, Date.now());

    // 本文件静态 import 的那一份（＝ 请求处理那份）必须读得到它
    const r = await getCachedQuotes();
    expect(r.quotes[0].price, 'WS 那份若是模块级变量，这里读到的会是轮询价 11111').toBe(22222);
    expect(r.quotes[0].source).toBe('stream');
  });
});

describe('K 线：getCandles', () => {
  /** 一行币安 kline。前六项是真身与替身都给的：开时间 / 开 / 高 / 低 / 收 / 量。 */
  const kline = (t: number, o: number, h: number, l: number, c: number, v = 1) => [
    t,
    String(o),
    String(h),
    String(l),
    String(c),
    String(v),
    0,
    '0',
    0,
    '0',
    '0',
    '0',
  ];

  it('取完整六元组（开高低收 + 量），不是只取 close —— 蜡烛与成交量柱都要它', async () => {
    stubFetch([kline(1000, 1, 2, 0.5, 1.5, 7), kline(2000, 1.5, 3, 1.4, 2.5, 9)]);
    expect(await getCandles('BTCUSDT', '1h', 2)).toEqual([
      [1000, 1, 2, 0.5, 1.5, 7],
      [2000, 1.5, 3, 1.4, 2.5, 9],
    ]);
  });

  it('URL 带上周期与根数', async () => {
    const fn = stubFetch([kline(1000, 1, 2, 0.5, 1.5)]);
    await getCandles('ETHUSDT', '4h', 300);
    expect(String(fn.mock.calls[0][0])).toBe(
      'https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=300'
    );
  });

  it('★ 周期进缓存键：1h 与 4h 各打一次、各拿各的（键漏了 interval 就是静默串档）', async () => {
    const fn = vi.fn(
      async (url: string) =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            const close = new URL(String(url)).searchParams.get('interval') === '4h' ? 400 : 100;
            return [kline(1000, close, close, close, close)];
          },
        }) as unknown as Response
    );
    vi.stubGlobal('fetch', fn);

    const h1 = await getCandles('BTCUSDT', '1h', 2);
    const h4 = await getCandles('BTCUSDT', '4h', 2);
    // 再各来一次：两份都该命中各自的缓存，不该再打上游
    await getCandles('BTCUSDT', '1h', 2);
    await getCandles('BTCUSDT', '4h', 2);

    expect(fn, '两个周期各一次，重读走缓存').toHaveBeenCalledTimes(2);
    expect(h1[0][4]).toBe(100);
    expect(h4[0][4], '4h 若读回 1h 那一格缓存，这里会是 100').toBe(400);
  });

  it('limit 超过币安上限时夹到 1000（超了它直接报错，别指望调用方）', async () => {
    const fn = stubFetch([kline(1000, 1, 2, 0.5, 1.5)]);
    await getCandles('BTCUSDT', '1h', 99999);
    expect(String(fn.mock.calls[0][0])).toContain('limit=1000');
  });

  it('坏行只丢那一行 —— 一行脏数据不该让整张图消失', async () => {
    stubFetch([
      kline(1000, 1, 2, 0.5, 1.5),
      kline(2000, 0, 2, 0.5, 1.5), // 开盘价 ≤ 0
      [3000, '1'], // 字段不够
      kline(4000, 1, 2, 0.5, 1.5),
      'not-a-row',
    ]);
    const out = await getCandles('BTCUSDT', '1h', 5);
    expect(out.map((c) => c[0])).toEqual([1000, 4000]);
  });

  it('量的 0 是合法的（那一根没人成交），不该被当成坏行丢掉', async () => {
    stubFetch([kline(1000, 1, 2, 0.5, 1.5, 0)]);
    expect(await getCandles('BTCUSDT', '1h', 1)).toHaveLength(1);
  });

  it('乱序与重复 openTime 出门前被理平（图表数学假定严格递增）', async () => {
    stubFetch([
      kline(2000, 1, 2, 0.5, 20),
      kline(1000, 1, 2, 0.5, 10),
      kline(2000, 1, 2, 0.5, 22), // 同一时刻重发的那根更新，留它
    ]);
    const out = await getCandles('BTCUSDT', '1h', 3);
    expect(out.map((c) => c[0])).toEqual([1000, 2000]);
    expect(out[1][4]).toBe(22);
  });

  it('失败返回空数组 —— 图是装饰，不该让整页 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('挂了'); }));
    expect(await getCandles('BTCUSDT')).toEqual([]);
  });

  it('缓存过期后上游挂了 → 退回上次成功那份，而不是空白', async () => {
    stubFetch([kline(1000, 1, 2, 0.5, 1.5)]);
    await getCandles('BTCUSDT', '1h', 1);

    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000); // 越过 CANDLE_CACHE_MS
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('挂了'); }));
    expect(await getCandles('BTCUSDT', '1h', 1)).toEqual([[1000, 1, 2, 0.5, 1.5, 1]]);
    vi.useRealTimers();
  });

  it('缓存期内不重复打行情源', async () => {
    const fn = stubFetch([kline(1000, 1, 2, 0.5, 1.5)]);
    await getCandles('BTCUSDT', '1h', 1);
    await getCandles('BTCUSDT', '1h', 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
