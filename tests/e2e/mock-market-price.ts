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

  if (path === '/__e2e__/prices') {
    return send(res, 200, { prices: Object.fromEntries(prices) });
  }

  if (path === '/__e2e__/reset') {
    prices.set('BTCUSDT', 80000);
    prices.set('ETHUSDT', 3000);
    changes.set('BTCUSDT', 1.5);
    changes.set('ETHUSDT', -0.75);
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

  // GET /api/v3/klines —— 收盘价序列，画曲线用。造一条从当前价出发的确定性曲线。
  if (path === '/api/v3/klines') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 72));
    const last = prices.get(symbol) ?? 1;
    const out = [];
    for (let i = 0; i < limit; i++) {
      // 从 last 往回推一条平缓的曲线（形状固定，便于断言）
      const close = last * (1 - (limit - 1 - i) * 0.0005);
      out.push([
        0, // openTime 占位 —— 客户端只读索引 4（close）
        String(close),
        String(close),
        String(close),
        String(close),
        0,
        0,
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
