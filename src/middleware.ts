import { NextRequest, NextResponse } from 'next/server';
import { guardedKind, plaintextVerdict } from '@/lib/https-guard';

// ─────────────────────────────────────────────────────────────────────────────
// 中间件两件事
//
//   1. 练手盘协议闸（/fish/trade 与它下面的页面 + 四个接口）—— 见下 §A
//   2. CSRF 防护（对写请求做 Origin/Referer 同源校验）—— 见下 §B
//
// 顺序上 §A 必须排在 §B 的「安全方法早退」之前，理由写在 §A 那里。
// ─────────────────────────────────────────────────────────────────────────────
//
// ── §A 练手盘协议闸 ─────────────────────────────────────────────────────────
// 确证是明文 http 时：页面 308 跳到 https，四个接口回 403。
// 判据、**本机地址为什么豁免**、以及「为什么只在中间件判一处」见
// `src/lib/https-guard.ts` 文件头 —— 那里是这套规则的唯一说明处。
//
// ⚠️ 与 §B 不同，这道闸看的是**路径**不是方法，所以它必须在 SAFE_METHODS 早退
//    **之前**：两个页面都是 GET，排到后面等于永远走不到。
//
// ── §B CSRF 防护（对写请求做 Origin/Referer 同源校验）
//
// 会话走 httpOnly cookie，因此状态变更请求(POST/PUT/PATCH/DELETE)存在 CSRF 面。
// 这里做 Origin/Referer 同源校验：跨站发起的写请求会带上攻击者的 Origin，
// 与本站对外 Host 不符即拒绝。配合 SameSite=lax cookie，覆盖绝大多数 CSRF 向量。
//
// 【反向代理】对外 Host 的判定顺序（三条来源取并集）：
//   1. ALLOWED_ORIGINS（显式配置，最可靠；反代/多域名部署建议直接配这个）
//   2. X-Forwarded-Host（nginx 等反代透传的原始 Host）
//   3. Host（直连时的兜底）
// 若只看 Host，nginx 未配 `proxy_set_header Host $host` 时 Next 收到的是上游地址
// （如 127.0.0.1:3000），与浏览器 Origin(https://example.com) 必然不符 → 正常请求被误判为 CSRF。
//
// 安全说明：X-Forwarded-Host 由反代覆写才可信（nginx 应配 proxy_set_header X-Forwarded-Host $host）。
// 浏览器发起的跨站请求无法附加该自定义头（会触发 CORS 预检且本站不放行），故不构成绕过面；
// 但若把 Next 直接裸暴露到公网，请务必配置 ALLOWED_ORIGINS 作为权威来源。
//
// 说明：GET/HEAD/OPTIONS 视为安全方法，不校验。
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** §A 协议闸的拒绝文案（页面走 308，用不到它）。 */
const HTTPS_ONLY_MESSAGE = '练手盘仅支持 HTTPS 访问';

/**
 * §A 的拒绝响应。接口一律 403 JSON —— 别改成跳转：POST 不能跟 301/302（方法与 body
 * 都会丢），而 308 虽保方法，让 fetch/XHR 跟到 https 去拿一坨 HTML 也只会让调用方更看不懂。
 * 页面在**拿不到对外 Host** 时也用它（拼不出 Location 就别拼，见调用点）。
 */
function httpsOnlyRefusal() {
  return NextResponse.json({ code: 403, message: HTTPS_ONLY_MESSAGE }, { status: 403 });
}

/**
 * OAuth 服务器对服务器端点：客户端鉴权走 HTTP Basic（或 body 内 client_secret），
 * 不需要会话浏览器上下文，CSRF 同源校验会让外部服务（在 ALLOWED_ORIGINS 之外）
 * 的调用被误杀。consent 屏（/api/oauth/authorize）保留 CSRF 校验。
 *
 * 增删前请确认：新增到豁免列表的端点必须由 client_secret / token 自身承担鉴权，
 * 否则留下攻击面。/api/oauth/authorize 永远**不要**加入。
 */
const CSRF_EXEMPT_PATHS = new Set<string>([
  '/api/oauth/token',
  '/api/oauth/userinfo',
  '/api/oauth/revoke',
]);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** 规范化成 host（接受 "example.com" 或 "https://example.com" 两种写法）。 */
function normalizeHost(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  return hostOf(s.startsWith('http') ? s : `https://${s}`);
}

export function middleware(req: NextRequest) {
  const { pathname, search } = new URL(req.url);

  // ── §A 练手盘协议闸 ────────────────────────────────────────────────────────
  // ⚠️ 必须排在下面那次 SAFE_METHODS 早退**之前**：那道早退是给 §B 的 CSRF 写校验
  //    写的，而练手盘的两个页面都是 GET —— 排到它后面就永远走不到。
  const guarded = guardedKind(pathname);
  if (guarded) {
    const verdict = plaintextVerdict(req.headers);
    if (verdict.block) {
      // 接口一律 403：POST 不能跳转（301/302 丢方法，308 虽保方法但让 fetch 跟到
      // https 去拿一坨 HTML 只会让调用方更看不懂）。
      if (guarded === 'api' || !verdict.redirectTo) return httpsOnlyRefusal();
      // 拼串只用 verdict 给的 Host（就是判据那一份），别在这里再读一遍头 ——
      // 两边各读一次就会出现「判据放行、这里却跳转」的缝，而症状是跳错域且
      // 308 被浏览器长期缓存。也不用 req.nextUrl 改 protocol：反代下它的 host
      // 很可能就是上游地址（同 §B 注释里 2026-07-16 那次事故的形状）。
      return NextResponse.redirect(
        `https://${verdict.redirectTo}${pathname}${search}`,
        308
      );
    }
  }

  if (SAFE_METHODS.has(req.method)) return NextResponse.next();

  // OAuth 服务端对服务端端点豁免（鉴权由 client_secret / bearer token 承担）
  if (CSRF_EXEMPT_PATHS.has(pathname)) return NextResponse.next();

  const originHost = hostOf(req.headers.get('origin'));
  const refererHost = hostOf(req.headers.get('referer'));

  // 显式可信来源（逗号分隔），反代/多域名部署的权威配置
  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(normalizeHost)
      .filter(Boolean) as string[]
  );

  // 反代透传的对外 Host（可能是 "a.com, b.com" 形式，取第一个）
  const xfHost = req.headers.get('x-forwarded-host');
  if (xfHost) {
    const first = normalizeHost(xfHost.split(',')[0]);
    if (first) allowed.add(first);
  }

  // 直连兜底
  const host = req.headers.get('host');
  if (host) allowed.add(host);

  const claimed = originHost ?? refererHost;
  // 有 Origin/Referer 且与本站不符 → 拒绝。两者都缺失时保守放行（部分原生客户端不带），
  // 依赖 SameSite=lax 兜底；如需更严格可改为一律要求 Origin。
  if (claimed && !allowed.has(claimed)) {
    return NextResponse.json({ code: 403, message: '跨源请求被拒绝 (CSRF)' }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // /api/:path*        —— §B 只校验会产生副作用的 API 写请求
  // /fish/trade/:path* —— §A 练手盘的协议闸（两个页面；四个接口已被上一行覆盖）
  // 注：`:path*` 是**零或多段**，所以裸 `/fish/trade` 也匹配，不必再单列一条。
  // ⚠️ 改这里要同时想清楚 src/lib/https-guard.ts 的 guardedKind 覆盖不覆盖 ——
  //    两处没有编译期关系（matcher 必须是构建期可静态分析的字符串字面量），
  //    tests/unit/https-guard.test.ts 会逐字断言这一行。
  matcher: ['/api/:path*', '/fish/trade/:path*'],
};
