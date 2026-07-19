import { apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { hasScope, oauthErr, siteOrigin, validateAccessToken } from '@/lib/oauth';

// GET /api/oauth/userinfo
// Authorization: Bearer <token> → { sub, username, avatar_url }
//
// v1 仅 profile scope：返回 id（OIDC 风格的 sub）/ username / avatar_url。
// avatar_url 走 ${siteOrigin()}/api/avatar/<id>；无头像时 null，调用方走兜底。

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return oauthErr('invalid_token', '缺少或非法的 Authorization 头');
  const raw = m[1].trim();

  const v = await validateAccessToken(raw);
  if (!v) return oauthErr('invalid_token', 'token 无效或已过期');

  // 限频：每 token 每分钟 600 次
  const rl = rateLimit(`oauth:userinfo:${v.userId}`, {
    limit: 600,
    windowMs: 60 * 1000,
  });
  if (!rl.allowed) return oauthErr('invalid_request', '请求过于频繁，请稍后再试');

  if (!hasScope(v.scopes, 'profile')) return oauthErr('insufficient_scope', '需要 profile scope');

  // 二次校验：被封号用户的 token 自动失效（吊销旁路最多延迟一次）
  const user = await prisma.user.findUnique({
    where: { id: v.userId },
    select: { id: true, username: true, avatarPath: true, isBanned: true },
  });
  if (!user || user.isBanned) return oauthErr('invalid_token', '用户已不可用');

  // fire-and-forget: 记录最后使用时间
  void import('@/lib/oauth').then((m) => m.touchAccessTokenUsage(raw));

  const origin = siteOrigin();
  const avatarUrl = origin ? `${origin}/api/avatar/${user.id}` : `/api/avatar/${user.id}`;

  return Response.json(
    {
      sub: user.id,
      username: user.username,
      avatar_url: user.avatarPath ? avatarUrl : null,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}