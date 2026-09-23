// 行情源的最小替身（仅供 E2E）。
//
// 【为什么非有不可】练手盘的成交价是**下单那一刻现取**的（见 src/lib/market-price.ts
// 的文件头），所以 e2e 里每开一次仓、每平一次仓都会真去访问行情源。若不拦住：
//   · 用例的成败取决于币安当时通不通 —— 而这台机器/CI 可能在墙内、可能被限流；
//   · 更致命的是**价格不可控**：断言「涨了确实 mint 鱼干、跌了确实 burn」需要一个
//     确定的涨跌，而真实行情每一毫秒都在动。
// 于是这里按客户端实际契约造个替身，由 __e2e__ 端点让用例**自己定价**。
//
// 契约来源：src/lib/market-price.ts（三个端点与字段名）。
//
// 【它不是什么】不做真实撮合、不模拟滑点、不校验配额。它只做两件事：
// 按用例设定的价应答，以及让用例能改那个价。

import http from 'node:http';
// 周期白名单与真身共用同一份（零依赖模块，tsx 直接能跑）—— 各抄一份的话，
// 哪天给练手盘加了周期，这里会把那个周期判成 400，而症状看着像产品坏了。
import { INTERVAL_MS, MARKET_INTERVALS } from '../../src/lib/market-candles';

const PORT = Number(process.env.E2E_MARKET_PORT || 3102);

/** 标的 → 现价。用例通过 /__e2e__/set-price 改它。 */
const prices = new Map<string, number>([
  ['BTCUSDT', 80000],
  ['ETHUSDT', 3000],
]);

/** 标的 → 24h 涨跌幅（展示用，不影响成交）。 */
const changes = new Map<string, number>([
  ['BTCUSDT', 1.5],
  ['ETHUSDT', -0.75],
]);

/**
 * 标的 → **K 线最后一根的收盘价**（只影响 /api/v3/klines，不影响 ticker）。
 *
 * 【为什么需要它】真身上，页面上那个展示价会被并进最后一根 K 线（见 market-chart.ts
 * 的 mergeLivePrice）。而默认情况下这里 ticker 与 K 线末根**取的是同一个数**，
 * 那段并线代码在 e2e 里等于没测。用例用 /__e2e__/set-candle-close 把两者拆开，
 * 「图例上的收 == 展示价」才成为可观察的事实。
 */
const candleCloses = new Map<string, number>();

function send(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // ── 测试自省端点：不属于真实契约，用 __e2e__ 前缀与真实路由隔开 ──────────────

  if (path === '/__e2e__/set-price') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    const price = Number(url.searchParams.get('price'));
    if (!Number.isFinite(price) || price <= 0) {
      return send(res, 400, { ok: false, message: 'price 必须是正数' });
    }
    prices.set(symbol, price);
    return send(res, 200, { ok: true, symbol, price });
  }

  if (path === '/__e2e__/set-candle-close') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    const price = Number(url.searchParams.get('price'));
    if (!Number.isFinite(price) || price <= 0) {
      return send(res, 400, { ok: false, message: 'price 必须是正数' });
    }
    candleCloses.set(symbol, price);
    return send(res, 200, { ok: true, symbol, price });
  }

  if (path === '/__e2e__/prices') {
    return send(res, 200, {
      prices: Object.fromEntries(prices),
      candle_closes: Object.fromEntries(candleCloses),
    });
  }

  if (path === '/__e2e__/reset') {
    prices.set('BTCUSDT', 80000);
    prices.set('ETHUSDT', 3000);
    changes.set('BTCUSDT', 1.5);
    changes.set('ETHUSDT', -0.75);
    candleCloses.clear();
    return send(res, 200, { ok: true });
  }

  // ── 真实契约 ────────────────────────────────────────────────────────────────

  // GET /api/v3/ticker/price —— 单币（成交用）与多币（批量）两种形状
  if (path === '/api/v3/ticker/price') {
    const single = url.searchParams.get('symbol');
    if (single) {
      const price = prices.get(single);
      if (price === undefined) {
        return send(res, 400, { code: -1121, msg: `Invalid symbol: ${single}` });
      }
      return send(res, 200, { symbol: single, price: String(price) });
    }
    const many = url.searchParams.get('symbols');
    if (many) {
      let list: string[] = [];
      try {
        const parsed = JSON.parse(many);
        if (Array.isArray(parsed)) list = parsed.map(String);
      } catch {
        return send(res, 400, { code: -1100, msg: 'bad symbols param' });
      }
      return send(
        res,
        200,
        list
          .filter((s) => prices.has(s))
          .map((s) => ({ symbol: s, price: String(prices.get(s)) }))
      );
    }
    return send(res, 400, { code: -1102, msg: 'symbol or symbols required' });
  }

  // GET /api/v3/ticker/24hr —— 展示用，带涨跌幅
  if (path === '/api/v3/ticker/24hr') {
    const many = url.searchParams.get('symbols');
    const list: string[] = many ? (JSON.parse(many) as string[]) : ['BTCUSDT', 'ETHUSDT'];
    return send(
      res,
      200,
      list
        .filter((s) => prices.has(s))
        .map((s) => ({
          symbol: s,
          lastPrice: String(prices.get(s)),
          priceChangePercent: String(changes.get(s) ?? 0),
        }))
    );
  }

  // GET /api/v3/klines —— 画蜡烛图用。造一条**确定**的曲线。
  //
  // 【方向必须跟着 priceChangePercent 走】否则截图里会出现「涨跌幅 -0.75% 而曲线
  // 朝上」这种自相矛盾的画面 —— 那是替身造的假象，不是产品的 bug，但会让人
  // 以为走势线画反了。真身那边两者本来就是同一段行情的两种呈现。
  //
  // 【openTime 必须是真的】改版前这里是恒 0（客户端只读 close，用不着时间）。
  // 图表要画时间轴、要判断「展示价跨没跨过这一根的桶」，恒 0 会让这些路径
  // 在 e2e 里**全部走不了**：所有 K 线挤在同一个时刻上。
  if (path === '/api/v3/klines') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    // interval 与 limit 都按真身的规矩来：缺参数、白名单外、超上限一律拒 ——
    // 这样「我们的调用方忘了传周期」会当场红，而不是画出一张安静的错图。
    const interval = url.searchParams.get('interval');
    if (!interval || !(MARKET_INTERVALS as readonly string[]).includes(interval)) {
      return send(res, 400, { code: -1120, msg: `Invalid interval: ${interval}` });
    }
    const limit = Math.max(1, Number(url.searchParams.get('limit')) || 1000);
    if (limit > 1000) {
      return send(res, 400, { code: -1130, msg: `Limit ${limit} is too large` });
    }

    const ivMs = INTERVAL_MS[interval as keyof typeof INTERVAL_MS];
    const last = candleCloses.get(symbol) ?? prices.get(symbol) ?? 1;
    const pct = changes.get(symbol) ?? 0;
    // 整条曲线累计走完 change%，于是末点 - 首点的方向与涨跌幅一致
    const first = last / (1 + pct / 100);
    // 最后一根的开桶时刻是「现在所在的这一桶」（与真身对齐：末根是还在走的那一根）
    const lastOpen = Math.floor(Date.now() / ivMs) * ivMs;
    const W = 0.0015; // 影线宽度：写死才有确定性

    const out = [];
    let prevClose = first;
    const step = (last - first) / (limit - 1 || 1);
    for (let i = 0; i < limit; i++) {
      const base = first + step * i;
      // 逐根交替的小摆动：真实的 K 线是一阴一阳的，一条笔直上升的梯子不像行情，
      // 而且**一根阴线都造不出来**（`--down` 那支样式在 e2e 里就永远验不到）。
      // 两端不摆：首末两根的收盘价必须精确落在整条线的两端，方向才与
      // priceChangePercent 严格一致（同上面那条理由）。
      const wobble = i === 0 || i === limit - 1 ? 0 : step * 0.75 * (i % 2 === 0 ? 1 : -1);
      const close = base + wobble;
      const open = i === 0 ? first : prevClose;
      const hi = Math.max(open, close) * (1 + W);
      const lo = Math.min(open, close) * (1 - W);
      const vol = 500 + ((i * 37) % 400); // 有变化但确定，成交量柱据此有高有低
      prevClose = close;
      out.push([
        lastOpen - (limit - 1 - i) * ivMs, // openTime：真实 UTC 毫秒，逐根递增
        String(open),
        String(hi),
        String(lo),
        String(close),
        String(vol),
        lastOpen - (limit - i) * ivMs, // closeTime（真身会给，我们不用）
        '0',
        0,
        '0',
        '0',
        '0',
      ]);
    }
    return send(res, 200, out);
  }

  send(res, 404, { code: -1121, msg: `mock market price: no route ${req.method} ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-market-price] listening on http://127.0.0.1:${PORT}`);
});
