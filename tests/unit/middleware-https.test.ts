// middleware.ts §A —— 练手盘协议闸的行为。
//
// 判据本身（哪些头算确证 http、哪条路径过闸、跳到哪个域名）在 https-guard.test.ts
// 里逐个钉；这里只管**中间件接线对不对**：闸有没有排在安全方法早退之前、
// 两条分支（页面 308 / 接口 403）是不是各走各的、以及它有没有越界管到别的路径。
//
// ⚠️ 这里最值钱的两条是「明文 + 回环 → 放行」与「CSRF 分支没被影响」：
//    · 前者是 dev 与全部 e2e 能不能打开练手盘的全部依靠 —— 而这两个环境恰恰是
//      本地跑不出症状的地方（拦坏了要真跑起来才发现）；
//    · 后者防的是「加了一道闸，把原来那道闸挤没了」——2026-07-16 的 CSRF 事故
//      就是因为中间件里的判定顺序/来源写错，而那个 bug 在单测里是看不出来的。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const ORIGINAL_ALLOWED = process.env.ALLOWED_ORIGINS;

function req(opts: {
  method?: string;
  path?: string;
  host?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  origin?: string;
}) {
  const headers = new Headers();
  if (opts.host) headers.set('host', opts.host);
  if (opts.xForwardedHost) headers.set('x-forwarded-host', opts.xForwardedHost);
  if (opts.xForwardedProto) headers.set('x-forwarded-proto', opts.xForwardedProto);
  if (opts.origin) headers.set('origin', opts.origin);
  return new NextRequest(`http://localhost${opts.path ?? '/fish/trade'}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

/** 中间件放行（NextResponse.next() / 安全方法早退）——Next 用这个头标记「交给下一页」。 */
function isNext(res: Response) {
  return res.headers.get('x-middleware-next') === '1';
}

beforeEach(() => {
  delete process.env.ALLOWED_ORIGINS;
});
afterEach(() => {
  if (ORIGINAL_ALLOWED === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED;
});

describe('页面：确证 http → 308 跳到 https', () => {
  it('两个页面都跳，且 Location 用 x-forwarded-host 的域名', () => {
    for (const path of ['/fish/trade', '/fish/trade/stats']) {
      const res = middleware(
        req({
          path,
          xForwardedProto: 'http',
          xForwardedHost: 'example.com',
          host: '127.0.0.1:3000',
        })
      );
      expect(res.status, path).toBe(308);
      expect(res.headers.get('location'), path).toBe(`https://example.com${path}`);
    }
  });

  it('查询串要保留（丢掉它等于把筛选 / 分页状态吃了）', () => {
    const res = middleware(
      req({ path: '/fish/trade?a=1&b=2', xForwardedProto: 'http', xForwardedHost: 'example.com' })
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://example.com/fish/trade?a=1&b=2');
  });

  it('★ 拿不到对外 Host → 403（绝不拼一个跳错的 Location：308 会被永久缓存）', () => {
    const res = middleware(req({ xForwardedProto: 'http' })); // 连 Host 都不给
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
  });

  it('★ 私网 Host → 403，且**不给**跳转目标（跳过去会被 308 永久缓存）', () => {
    // 反代漏配 Host 时 Next 看到的就是上游地址。照它拼 308 会把浏览器永久送到
    // 那个地址上，而服务端每次都「正确地」返回 308、不报任何错 —— 只能清缓存。
    const res = middleware(req({ xForwardedProto: 'http', host: '192.168.1.5:3000' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('接口：确证 http → 403 JSON（不跳转）', () => {
  for (const [name, path, method] of [
    ['quote', '/api/fish/trade/quote', 'GET'],
    ['buy', '/api/fish/trade/buy', 'POST'],
    ['sell', '/api/fish/trade/sell', 'POST'],
    ['candles', '/api/fish/trade/candles', 'GET'],
  ] as const) {
    it(`${name} → 403`, async () => {
      const res = middleware(
        req({ path, method, xForwardedProto: 'http', xForwardedHost: 'example.com' })
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      const body = await res.json();
      expect(body.code).toBe(403);
      expect(String(body.message)).toContain('HTTPS');
    });
  }
});

describe('★ 放行的那几路（本地开发与 e2e 全靠这里活着）', () => {
  it('★ 明文 + 回环 Host → 放行 —— **这才是 dev 与 e2e 的真实形态**', () => {
    // 实测：Next 会自己按 socket 把 x-forwarded-proto 填成 http（直连明文时），
    // 所以「没有那个头」在真实服务器上几乎不会发生，光靠「无头就放行」救不了本地。
    // 练手盘在本机与整个 e2e 里能不能打开，全看这一条。
    for (const [name, host] of [
      ['dev', 'localhost:3000'],
      ['e2e', '127.0.0.1:3100'],
    ] as const) {
      const res = middleware(req({ xForwardedProto: 'http', host }));
      expect(isNext(res), `${name} 的练手盘必须打得开`).toBe(true);
    }
  });

  it('接口在本机也放行（后面还有 core 档位等各自的判定）', () => {
    const res = middleware(req({ path: '/api/fish/trade/quote', xForwardedProto: 'http', host: '127.0.0.1:3100' }));
    expect(isNext(res)).toBe(true);
  });

  it('根本没有该头时也放行（不猜）', () => {
    const res = middleware(req({ host: 'raricy.com' }));
    expect(isNext(res)).toBe(true);
  });

  it('x-forwarded-proto: https 放行', () => {
    const res = middleware(req({ xForwardedProto: 'https', xForwardedHost: 'example.com' }));
    expect(isNext(res)).toBe(true);
  });
});

describe('边界：闸只管它那几条路径', () => {
  it('/fish/trades、/fish/market 等不在闸内（前缀不误伤）', () => {
    for (const path of ['/fish/trades', '/fish/market', '/fish']) {
      const res = middleware(req({ path, xForwardedProto: 'http', xForwardedHost: 'example.com' }));
      expect(isNext(res), path).toBe(true);
    }
  });

  it('回归：其它路径的写请求仍走 CSRF 分支（加了一道闸不能把原来那道挤没）', async () => {
    // 带 XFP=http 但打的是 /api/auth/login —— 闸不该认它，应照旧落到 CSRF 判定上。
    const res = middleware(
      req({
        path: '/api/auth/login',
        method: 'POST',
        xForwardedProto: 'http',
        host: 'zk.raricy.com',
        origin: 'https://evil.example',
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(String(body.message)).toContain('CSRF');
  });

  it('回归：安全方法早退对非闸路径仍然生效（GET 不会被 CSRF 拦）', () => {
    const res = middleware(
      req({ path: '/api/blogs', origin: 'https://evil.example', xForwardedProto: 'http' })
    );
    expect(isNext(res)).toBe(true);
  });
});
