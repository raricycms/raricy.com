// ─────────────────────────────────────────────────────────────────────────────
// middleware.test.ts —— 中间件的两件事：CSRF 同源校验 + 协议闸（练手盘 / 玩具区）
//
// Round4 合并：原 middleware-csrf.test.ts 与 middleware-https.test.ts。两文件都是
// 同一个 `middleware()` 的接线测试，各带一份等价的 NextRequest 构造器与环境还原；
// 合并后共用一份 req()/isNext/isBlocked 与 beforeEach，判据本身仍在 https-guard.test.ts。
//
// 【CSRF 回归】2026-07-16 线上事故：反代（nginx）未透传原始 Host 时，中间件只看 `Host`，
// 拿到上游地址 127.0.0.1:3000，与浏览器 Origin 必然不符 → 正常登录请求被判跨源 403。
// 修复：对外 Host 判定改为 ALLOWED_ORIGINS → X-Forwarded-Host → Host。两侧边界都要守：
// 既不误杀正常请求，也不放过真跨站。
//
// 【协议闸回归】明文 http 下页面 308 / 接口 403；回环 Host 放行是 dev 与全部 e2e 的命门；
// 拿不到对外 Host 时宁 403 也不拼 308（308 会被浏览器永久缓存）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const ORIGINAL_ALLOWED = process.env.ALLOWED_ORIGINS;

/** 统一的请求构造器（两个域共用）：默认 POST + 协议闸路径；需要什么就传什么。 */
function req(opts: {
  method?: string;
  path?: string;
  host?: string;
  origin?: string;
  referer?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
}) {
  const headers = new Headers();
  if (opts.host) headers.set('host', opts.host);
  if (opts.origin) headers.set('origin', opts.origin);
  if (opts.referer) headers.set('referer', opts.referer);
  if (opts.xForwardedHost) headers.set('x-forwarded-host', opts.xForwardedHost);
  if (opts.xForwardedProto) headers.set('x-forwarded-proto', opts.xForwardedProto);
  return new NextRequest(`http://localhost${opts.path ?? '/fish/trade'}`, {
    method: opts.method ?? 'POST',
    headers,
  });
}

/** 中间件放行（NextResponse.next() / 安全方法早退）——Next 用这个头标记「交给下一页」。 */
function isNext(res: Response) {
  return res.headers.get('x-middleware-next') === '1';
}

/** 中间件拦截时返回 403 JSON。 */
function isBlocked(res: Response) {
  return res.status === 403;
}

beforeEach(() => {
  delete process.env.ALLOWED_ORIGINS;
});
afterEach(() => {
  if (ORIGINAL_ALLOWED === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED;
});

describe('页面：确证 http → 308 跳到 https', () => {
  it('两个区域的页面都跳，且 Location 用 x-forwarded-host 的域名', () => {
    for (const path of [
      '/fish/trade',
      '/fish/trade/stats',
      '/game',
      '/game/atamas',
      '/game/collections/test',
      '/game/collections/test/craft',
      '/game/quandi',
      // iframe 文档路由：GET，按页面 308 跟过去即可（见 https-guard.ts 文件头）。
      '/game/quandi/play',
    ]) {
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
  for (const [name, path, method, label] of [
    ['quote', '/api/fish/trade/quote', 'GET', '练手盘'],
    ['buy', '/api/fish/trade/buy', 'POST', '练手盘'],
    ['sell', '/api/fish/trade/sell', 'POST', '练手盘'],
    ['candles', '/api/fish/trade/candles', 'GET', '练手盘'],
    ['wand launch', '/api/game/wand/launch', 'POST', '玩具'],
    ['wand2 launch', '/api/game/wand2/launch', 'POST', '玩具'],
    ['quandi launch', '/api/game/quandi/launch', 'POST', '玩具'],
    ['public-space launch', '/api/game/public-space/launch', 'POST', '玩具'],
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
      // 文案要点对区域：玩具区的接口不能报「练手盘仅支持 HTTPS 访问」——
      // 拦是拦对了，但运维会照着文案去查错功能。
      expect(String(body.message)).toContain(label);
    });
  }
});

describe('★ 放行的那几路（本地开发与 e2e 全靠这里活着）', () => {
  it('★ 明文 + 回环 Host → 放行 —— **这才是 dev 与 e2e 的真实形态**', () => {
    // 实测：Next 会自己按 socket 把 x-forwarded-proto 填成 http（直连明文时），
    // 所以「没有那个头」在真实服务器上几乎不会发生，光靠「无头就放行」救不了本地。
    // 练手盘与玩具区在本机与整个 e2e 里能不能打开，全看这一条（e2e 里就有一堆
    // /game 页面与游戏）。
    for (const [name, host] of [
      ['dev', 'localhost:3000'],
      ['e2e', '127.0.0.1:3100'],
    ] as const) {
      for (const path of ['/fish/trade', '/game', '/game/atamas']) {
        const res = middleware(req({ path, xForwardedProto: 'http', host }));
        expect(isNext(res), `${name} 的 ${path} 必须打得开`).toBe(true);
      }
    }
  });

  it('接口在本机也放行（后面还有 core 档位等各自的判定）', () => {
    for (const path of ['/api/fish/trade/quote', '/api/game/wand/launch']) {
      const res = middleware(req({ path, xForwardedProto: 'http', host: '127.0.0.1:3100' }));
      expect(isNext(res), path).toBe(true);
    }
  });

});

describe('边界：闸只管它那几条路径', () => {
  it('/fish/trades、/games、/gameplay 等不在闸内（前缀不误伤）', () => {
    // `/games` / `/gameplay` 是「前缀写法一不小心就误伤」的那一档：将来它们可能是
    // 真页面，被这道闸顺手 308 走，而页面本身没有任何问题。
    for (const path of ['/fish/trades', '/fish/market', '/fish', '/games', '/gameplay']) {
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
      req({ method: 'GET', path: '/api/blogs', origin: 'https://evil.example', xForwardedProto: 'http' })
    );
    expect(isNext(res)).toBe(true);
  });
});

// ── CSRF 同源校验（原 middleware-csrf.test.ts，Round4 合并）──
describe('安全方法不校验（GET/HEAD/OPTIONS）', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    it(`${method} 即使 Origin 是恶意域也放行（读请求无副作用）`, () => {
      const res = middleware(
        req({ method, host: '127.0.0.1:3000', origin: 'https://evil.example' })
      );
      expect(isBlocked(res)).toBe(false);
    });
  }
});

describe('回归：反代场景（nginx 未透传 Host，只有 X-Forwarded-Host）', () => {
  it('✅ 正常请求必须放行 —— 这是 2026-07-16 事故的核心用例', () => {
    const res = middleware(
      req({
        host: '127.0.0.1:3000', // nginx 转发后 Next 看到的是上游地址
        origin: 'https://zk.raricy.com', // 浏览器带的真实 Origin
        xForwardedHost: 'zk.raricy.com', // nginx 透传的对外 Host
      })
    );
    expect(isBlocked(res), '反代下的正常写请求被误判为 CSRF（线上事故重现）').toBe(false);
  });

  it('❌ 真跨站攻击仍须拦截（修 bug 不能把防护修没）', () => {
    const res = middleware(
      req({
        host: '127.0.0.1:3000',
        origin: 'https://evil.example', // 攻击者的域
        xForwardedHost: 'zk.raricy.com',
      })
    );
    expect(isBlocked(res)).toBe(true);
  });

  it('X-Forwarded-Host 为 "a.com, b.com" 时取第一个', () => {
    const res = middleware(
      req({
        host: '127.0.0.1:3000',
        origin: 'https://first.example',
        xForwardedHost: 'first.example, second.example',
      })
    );
    expect(isBlocked(res)).toBe(false);
  });
});

describe('ALLOWED_ORIGINS 显式配置（反代配置不确定时的兜底）', () => {
  it('只配 ALLOWED_ORIGINS、无 X-Forwarded-Host 时放行', () => {
    process.env.ALLOWED_ORIGINS = 'zk.raricy.com';
    const res = middleware(
      req({ host: '127.0.0.1:3000', origin: 'https://zk.raricy.com' })
    );
    expect(isBlocked(res)).toBe(false);
  });

  it('配了 ALLOWED_ORIGINS 但 Origin 是恶意域 → 仍拦截', () => {
    process.env.ALLOWED_ORIGINS = 'zk.raricy.com';
    const res = middleware(
      req({ host: '127.0.0.1:3000', origin: 'https://evil.example' })
    );
    expect(isBlocked(res)).toBe(true);
  });

  it('接受 "https://x.com" 与 "x.com" 两种写法', () => {
    for (const cfg of ['https://zk.raricy.com', 'zk.raricy.com']) {
      process.env.ALLOWED_ORIGINS = cfg;
      const res = middleware(
        req({ host: '127.0.0.1:3000', origin: 'https://zk.raricy.com' })
      );
      expect(isBlocked(res), `配置写法: ${cfg}`).toBe(false);
    }
  });

  it('支持逗号分隔的多来源', () => {
    process.env.ALLOWED_ORIGINS = 'a.example, https://b.example';
    for (const o of ['https://a.example', 'https://b.example']) {
      expect(isBlocked(middleware(req({ host: 'up:3000', origin: o }))), o).toBe(false);
    }
    expect(isBlocked(middleware(req({ host: 'up:3000', origin: 'https://c.example' })))).toBe(true);
  });
});

describe('直连场景（无反代）', () => {
  it('Origin 与 Host 相符 → 放行', () => {
    const res = middleware(
      req({ host: 'zk.raricy.com', origin: 'https://zk.raricy.com' })
    );
    expect(isBlocked(res)).toBe(false);
  });

  it('Origin 与 Host 不符 → 拦截', () => {
    const res = middleware(
      req({ host: 'zk.raricy.com', origin: 'https://evil.example' })
    );
    expect(isBlocked(res)).toBe(true);
  });
});

describe('Referer 兜底与缺失处理', () => {
  it('无 Origin 时用 Referer 判定：同源放行', () => {
    const res = middleware(
      req({ host: 'zk.raricy.com', referer: 'https://zk.raricy.com/blog' })
    );
    expect(isBlocked(res)).toBe(false);
  });

  it('无 Origin 时用 Referer 判定：跨源拦截', () => {
    const res = middleware(
      req({ host: 'zk.raricy.com', referer: 'https://evil.example/attack' })
    );
    expect(isBlocked(res)).toBe(true);
  });

  it('Origin 与 Referer 都缺失 → 保守放行（部分原生客户端不带，靠 SameSite 兜底）', () => {
    const res = middleware(req({ host: 'zk.raricy.com' }));
    expect(isBlocked(res)).toBe(false);
  });

  it('Origin 优先于 Referer（Origin 恶意即拦，哪怕 Referer 同源）', () => {
    const res = middleware(
      req({
        host: 'zk.raricy.com',
        origin: 'https://evil.example',
        referer: 'https://zk.raricy.com/blog',
      })
    );
    expect(isBlocked(res)).toBe(true);
  });

  it('畸形 Origin 不导致崩溃', () => {
    const res = middleware(req({ host: 'zk.raricy.com', origin: 'not-a-url' }));
    expect(res.status).toBeLessThan(500);
  });
});

describe('拦截响应的形态', () => {
  it('返回 JSON（不是 HTML），含 code/message', async () => {
    const res = middleware(
      req({ host: 'zk.raricy.com', origin: 'https://evil.example' })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(403);
    expect(String(body.message)).toContain('CSRF');
  });
});

describe('端口差异视为不同源', () => {
  it('同域不同端口 → 拦截（host 含端口）', () => {
    const res = middleware(
      req({ host: 'zk.raricy.com:3000', origin: 'https://zk.raricy.com:4000' })
    );
    expect(isBlocked(res)).toBe(true);
  });
});
