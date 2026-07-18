// middleware.ts —— CSRF 同源校验。
//
// 【回归测试】2026-07-16 线上事故：反代（nginx）未透传原始 Host 时，中间件只看
// `Host` 头，拿到的是上游地址 127.0.0.1:3000，与浏览器 Origin(https://zk.raricy.com)
// 必然不符 → 正常用户的登录请求被判为跨源 403。
// 修复：对外 Host 判定改为 ALLOWED_ORIGINS → X-Forwarded-Host → Host。
//
// 本文件同时守住两侧边界：既不能误杀正常请求，也不能放过真正的跨站攻击。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const ORIGINAL_ALLOWED = process.env.ALLOWED_ORIGINS;

function req(opts: {
  method?: string;
  host?: string;
  origin?: string;
  referer?: string;
  xForwardedHost?: string;
  path?: string;
}) {
  const headers = new Headers();
  if (opts.host) headers.set('host', opts.host);
  if (opts.origin) headers.set('origin', opts.origin);
  if (opts.referer) headers.set('referer', opts.referer);
  if (opts.xForwardedHost) headers.set('x-forwarded-host', opts.xForwardedHost);
  return new NextRequest(`http://localhost${opts.path ?? '/api/auth/login'}`, {
    method: opts.method ?? 'POST',
    headers,
  });
}

/** 中间件放行时返回 next()（无 403 body）；拦截时返回 403 JSON。 */
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
