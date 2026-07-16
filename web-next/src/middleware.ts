import { NextRequest, NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// CSRF 防护（原 Flask 无 CSRF token，仅靠同源；新架构补齐这一层）
//
// 会话走 httpOnly cookie，因此状态变更请求(POST/PUT/PATCH/DELETE)存在 CSRF 面。
// 这里做 Origin/Referer 同源校验：跨站发起的写请求会带上攻击者的 Origin，
// 与本站 Host 不符即拒绝。配合 SameSite=lax cookie，覆盖绝大多数 CSRF 向量。
//
// 说明：GET/HEAD/OPTIONS 视为安全方法，不校验。浏览器 fetch 无法伪造 Origin 头。
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();

  const host = req.headers.get('host');
  const originHost = hostOf(req.headers.get('origin'));
  const refererHost = hostOf(req.headers.get('referer'));

  // 允许额外可信来源（如独立前端域名），逗号分隔
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => hostOf(s.trim().startsWith('http') ? s.trim() : `https://${s.trim()}`))
    .filter(Boolean);
  const allowed = new Set([host, ...extra].filter(Boolean) as string[]);

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
