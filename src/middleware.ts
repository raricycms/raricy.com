import { NextRequest, NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// CSRF 防护（原 Flask 无 CSRF token，仅靠同源；新架构补齐这一层）
//
// 会话走 httpOnly cookie，因此状态变更请求(POST/PUT/PATCH/DELETE)存在 CSRF 面。
// 这里做 Origin/Referer 同源校验：跨站发起的写请求会带上攻击者的 Origin，
// 与本站对外 Host 不符即拒绝。配合 SameSite=lax cookie，覆盖绝大多数 CSRF 向量。
//
// 【反向代理】对外 Host 的判定顺序（对齐 Flask 侧 ProxyFix 信任 X-Forwarded-Host 的做法）：
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
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();

  // OAuth 服务端对服务端端点豁免（鉴权由 client_secret / bearer token 承担）
  if (CSRF_EXEMPT_PATHS.has(new URL(req.url).pathname)) return NextResponse.next();

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
  // 只校验会产生副作用的 API 写请求
  matcher: ['/api/:path*'],
};
