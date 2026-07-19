import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { apiErr } from '@/lib/format';
import { rateLimit } from '@/lib/rate-limit';
import {
  createAuthorizationCode,
  normalizeScopes,
  parseRedirectUris,
} from '@/lib/oauth';

// POST /api/oauth/authorize
// 用户在同意页点击「授权」后调用：mint 一个授权码并 302 重定向到 redirect_uri。
// CSRF 中间件保护：必须同源 POST。
//
// 关键安全约束：
//   • 必须已登录（getCurrentUser）。
//   • redirect_uri 必须与注册列表完全一致（防 open redirect）。
//   • scope 必须在 SUPPORTED_SCOPES 内（白名单）。
//   • 限频：每用户每分钟 30 次。

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let body: Record<string, string> = {};
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      params.forEach((v, k) => {
        body[k] = v;
      });
    } else {
      body = (await req.json()) as Record<string, string>;
    }
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const clientId = (body.client_id || '').trim();
  const redirectUri = (body.redirect_uri || '').trim();
  const state = (body.state || '').slice(0, 512);
  const scopeRaw = body.scope;

  if (!clientId) return apiErr(400, '缺少 client_id');
  if (!redirectUri) return apiErr(400, '缺少 redirect_uri');

  // 限频
  const rl = rateLimit(`oauth:authorize:${user.id}`, { limit: 30, windowMs: 60 * 1000 });
  if (!rl.allowed) return apiErr(429, '操作过于频繁，请稍后再试');

  // 查应用
  const app = await prisma.oAuthApplication.findUnique({
    where: { clientId },
    select: { id: true, name: true, redirectUris: true, disabledAt: true },
  });
  if (!app) return apiErr(404, '未知应用');
  if (app.disabledAt) return apiErr(403, '应用已被禁用');

  // redirect_uri 白名单校验
  let allowed: string[];
  try {
    allowed = parseRedirectUris(app.redirectUris);
  } catch {
    return apiErr(500, '应用 redirect_uris 配置损坏');
  }
  if (!allowed.includes(redirectUri)) return apiErr(422, 'redirect_uri 未注册');

  // scope 规范化（白名单内才接受）
  const scopes = normalizeScopes(scopeRaw || 'profile');
  if (scopes.length === 0) return apiErr(400, '未提供有效 scope');

  // 签发授权码
  const minted = await createAuthorizationCode(app.id, user.id, redirectUri, scopes);

  const sep = redirectUri.includes('?') ? '&' : '?';
  const target = `${redirectUri}${sep}code=${encodeURIComponent(minted.code)}${
    state ? `&state=${encodeURIComponent(state)}` : ''
  }`;
  return Response.redirect(target, 302);
}