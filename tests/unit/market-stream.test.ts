// market-stream 的单元测试。
//
// 【测的不是「能不能连上币安」】那是 scripts/probe-binance-ws.mjs 的事（它在生产机上
// 真连了 10 分钟）。这里测的是**状态机**：帧有没有写进展示缓存、断了会不会重连、
// 「既没 close 也没 error」的挂死会不会被看门狗收掉、半死判据盯的是不是**合计**静默、
// 以及三道闸门（NODE_ENV / MARKET_STREAM_SILENCE_MS / 没有 WebSocket 实现时优雅退化）。
//
// 【为什么自己造一个假 WebSocket，而不是 mock 掉模块】这条状态机的全部价值都在
// **事件顺序**上（先 error 后 close、两个都不来、close 之后重连）—— 只有能按需驱动
// 这些事件才测得出来。假实现照的是探针在生产上实测到的真实失效模式，见
// src/lib/market-stream.ts 的文件头。
//
// 【为什么这里要改 NODE_ENV】那条 `NODE_ENV === 'test'` 的保险本来就是「vitest 里别跑」
// 的意思，而这里正是要测它自己 —— 所以放行它、再靠 afterEach 还回去。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetPriceCache, getCachedQuotes } from '@/lib/market-price';
import {
  DEFAULT_STREAM_SILENCE_MS,
  __setWebSocketImpl,
  startMarketStream,
  stopMarketStream,
  streamSilenceMs,
  streamUrl,
} from '@/lib/market-stream';

/**
 * 能按需驱动事件的假 WebSocket。
 * `close()` **刻意不发 onclose** —— 真实实现的 close 会走 onclose，而用例需要单独驱动
 * 「断开」与「只报错不 close」这两种情形。
 */
class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWS.all.push(this);
  }

  close(): void {
    /* 见类注释 */
  }

  // ── 用例侧的驱动手柄 ──
  open() {
    this.onopen?.();
  }
  /** 一条正常的 @trade 帧（组合流的外层形状）。 */
  trade(symbol: string, price: string) {
    this.raw({ stream: `${symbol.toLowerCase()}@trade`, data: { s: symbol, p: price } });
  }
  /** 任意载荷（心跳、缺字段的帧……）。 */
  raw(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  /** 服务端把连接断了 —— 最常见的下线方式。 */
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  /** 握手失败只报 error、**不**发 close（node 内置实现实测如此，见文件头）。 */
  failHandshake() {
    this.onerror?.();
  }
}

const latest = () => FakeWS.all[FakeWS.all.length - 1];

/** 让 REST 那条腿有价 —— 合并要有得可挑，才谈得上「用哪个源」。 */
function stubPoll() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            { symbol: 'BTCUSDT', lastPrice: '80000', priceChangePercent: '0' },
            { symbol: 'ETHUSDT', lastPrice: '3000', priceChangePercent: '0' },
          ],
        }) as unknown as Response
    )
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetPriceCache();
  FakeWS.all = [];
  __setWebSocketImpl(FakeWS);
  // 放行第一道保险（见文件头）。用 vi.stubEnv 而不是直接赋值：NODE_ENV 在 @types/node
  // 里是只读的，赋值过不了 tsc。
  vi.stubEnv('NODE_ENV', 'production');
  delete process.env.MARKET_STREAM_SILENCE_MS;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stopMarketStream();
  __setWebSocketImpl(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs(); // NODE_ENV 由 stubEnv 还回去（它只读，不能直接赋值）
  vi.restoreAllMocks();
  delete process.env.MARKET_STREAM_SILENCE_MS;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('订阅地址与阈值读法', () => {
  it('白名单标的拼成一条组合流（与成交同口径：最新成交价）', () => {
    expect(streamUrl()).toBe(
      'wss://data-stream.binance.vision/stream?streams=btcusdt@trade/ethusdt@trade'
    );
  });

  it('阈值：留空用默认，正数照用，0 / 负数 / 非数字 = 关闭', () => {
    expect(streamSilenceMs()).toBe(DEFAULT_STREAM_SILENCE_MS);
    process.env.MARKET_STREAM_SILENCE_MS = '5000';
    expect(streamSilenceMs()).toBe(5000);
    for (const v of ['0', '-1', 'abc']) {
      process.env.MARKET_STREAM_SILENCE_MS = v;
      expect(streamSilenceMs(), `MARKET_STREAM_SILENCE_MS=${v} 应当关闭`).toBe(0);
    }
  });
});

describe('三道闸门', () => {
  it('NODE_ENV=test → 不启动（第一道保险）', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(startMarketStream()).toBe(false);
    expect(FakeWS.all).toHaveLength(0);
  });

  it('MARKET_STREAM_SILENCE_MS=0 → 不启动（运维开关：回退纯轮询）', () => {
    process.env.MARKET_STREAM_SILENCE_MS = '0';
    expect(startMarketStream()).toBe(false);
    expect(FakeWS.all).toHaveLength(0);
  });

  it('★ 本进程没有 WebSocket 实现（Node 20）→ 返回 false、不抛、不连', () => {
    __setWebSocketImpl(null);
    vi.stubGlobal('WebSocket', undefined);

    expect(() => startMarketStream(), 'instrumentation 里抛异常会拖垮整个启动').not.toThrow();
    expect(startMarketStream()).toBe(false);
    expect(FakeWS.all).toHaveLength(0);
  });
});

describe('收到帧', () => {
  it('写进展示缓存，来源标成 stream（另一边仍走轮询）', async () => {
    stubPoll();
    await getCachedQuotes(); // 先让 REST 那份有价
    startMarketStream();
    const ws = latest();
    ws.open();
    ws.trade('BTCUSDT', '81234.5');

    const r = await getCachedQuotes();
    const btc = r.quotes.find((q) => q.symbol === 'BTCUSDT');
    const eth = r.quotes.find((q) => q.symbol === 'ETHUSDT');
    expect(btc).toMatchObject({ price: 81234.5, source: 'stream' });
    expect(eth, '没收到帧的标的不该被带偏').toMatchObject({ price: 3000, source: 'poll' });
  });

  it('启动即连，且幂等（重复 start 不会连出第二条）', () => {
    expect(startMarketStream()).toBe(true);
    expect(FakeWS.all).toHaveLength(1);
    expect(latest().url).toContain('streams=btcusdt@trade/ethusdt@trade');

    expect(startMarketStream(), '第二次 start 应当被已启动的状态挡下').toBe(false);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('非 JSON 帧（心跳）与缺字段的帧都不炸、也不动缓存', async () => {
    stubPoll();
    await getCachedQuotes();
    startMarketStream();
    const ws = latest();
    ws.open();

    expect(() => {
      ws.onmessage?.({ data: 'ping' }); // 不是 JSON
      ws.raw({ stream: 'btcusdt@trade', data: { s: 'BTCUSDT' } }); // 没有 p
      ws.trade('DOGEUSDT', '1'); // 白名单之外
      ws.trade('BTCUSDT', '0'); // 非法价
    }).not.toThrow();

    const r = await getCachedQuotes();
    expect(r.quotes[0], '一次都不该写进去').toMatchObject({ price: 80000, source: 'poll' });
  });
});

describe('断了怎么办', () => {
  it('断开 → 退避 1 秒后重连', () => {
    startMarketStream();
    latest().open();
    latest().drop(1006);
    expect(FakeWS.all, '退避期内不该立刻重连').toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('★ 握手挂死（既没 close 也没 error）→ 看门狗 10 秒收尾，然后重连', () => {
    startMarketStream(); // 不调 open()：连接永远停在 connecting
    expect(FakeWS.all).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all, '10 秒没到就判死 = 冤枉一次正常的慢握手').toHaveLength(1);

    vi.advanceTimersByTime(1_000); // 第 11 秒看门狗收尾
    vi.advanceTimersByTime(1_000); // 退避 1 秒后重连
    expect(FakeWS.all).toHaveLength(2);
  });

  it('只报 error 不发 close（真实实现如此）→ 一样被看门狗收掉', () => {
    startMarketStream();
    latest().failHandshake();
    vi.advanceTimersByTime(12_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('★ 半死判据盯的是**合计**静默，不是单标的', () => {
    startMarketStream();
    const ws = latest();
    ws.open();
    ws.trade('BTCUSDT', '80000');

    // 20 秒里只有 ETH 在动 —— BTC 自己冷清了 20 秒，但合计没有
    vi.advanceTimersByTime(20_000);
    ws.trade('ETHUSDT', '3000');
    expect(FakeWS.all, '按单标的判的话，这里就已经冤枉重连一次了').toHaveLength(1);

    // 合计静默超过 30 秒 → 强制重连
    vi.advanceTimersByTime(31_000);
    vi.advanceTimersByTime(1_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('帧一直来就永不重连（10 分钟不误判）', () => {
    startMarketStream();
    const ws = latest();
    ws.open();
    for (let i = 0; i < 600; i++) {
      vi.advanceTimersByTime(1_000);
      ws.trade('BTCUSDT', '80000');
    }
    expect(FakeWS.all).toHaveLength(1);
  });
});

describe('停掉', () => {
  it('stop 之后不再重连（定时器全清掉）', () => {
    startMarketStream();
    latest().open();
    stopMarketStream();

    vi.advanceTimersByTime(300_000);
    expect(FakeWS.all, '停掉之后不该再有任何新连接').toHaveLength(1);
  });

  it('停掉再起是一次干净的重来（注入的实现照旧生效）', () => {
    expect(startMarketStream()).toBe(true);
    stopMarketStream();
    expect(startMarketStream()).toBe(true);
    expect(FakeWS.all).toHaveLength(2);
  });
});
