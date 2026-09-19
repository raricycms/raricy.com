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
  __resetPriceCache,
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

describe('K 线：getCandles', () => {
  it('取索引 4（close），丢掉其余字段', async () => {
    stubFetch([
      [0, '1', '2', '3', '100.5', '0', 0, '0', 0, '0', '0', '0'],
      [0, '1', '2', '3', '101.5', '0', 0, '0', 0, '0', '0', '0'],
    ]);
    expect(await getCandles('BTCUSDT', 2)).toEqual([100.5, 101.5]);
  });

  it('失败返回空数组 —— 图是装饰，不该让整页 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('挂了'); }));
    expect(await getCandles('BTCUSDT')).toEqual([]);
  });

  it('缓存期内不重复打行情源', async () => {
    const fn = stubFetch([[0, '1', '2', '3', '100', '0', 0, '0', 0, '0', '0', '0']]);
    await getCandles('BTCUSDT', 1);
    await getCandles('BTCUSDT', 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
