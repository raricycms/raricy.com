import { prisma } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { isCurrentlyBanned } from '@/lib/auth';
import { hasScope, oauthErr, validateAccessToken } from '@/lib/oauth';
import { siteOrigin } from '@/lib/site-url';
import { avatarUrl } from '@/lib/avatar-refs';

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

  // 二次校验：禁言中的用户 token 自动失效（吊销旁路最多延迟一次）。
  // 必须用 isCurrentlyBanned 而不是裸 isBanned —— 禁言到期没有定时任务清标志，
  // 只读 isBanned 会让到期用户的 token 从此永久 401。
  const user = await prisma.user.findUnique({
    where: { id: v.userId },
    select: {
      id: true, username: true, avatarPath: true,
      isBanned: true, banUntil: true,
    },
  });
  if (!user || isCurrentlyBanned(user)) {
    return oauthErr('invalid_token', '用户已不可用');
  }

  // fire-and-forget: 记录最后使用时间
  void import('@/lib/oauth').then((m) => m.touchAccessTokenUsage(raw));

  const origin = siteOrigin();
  // 走唯一的 URL 口径（src/lib/avatar-refs.ts）。输出与手拼完全一致 ——
  // 改这里只是为了让「全仓只有一处拼 /api/avatar/」这条静态守卫成立。
  const absoluteAvatarUrl = origin ? `${origin}${avatarUrl(user.id)}` : avatarUrl(user.id);

  return Response.json(
    {
      sub: user.id,
      username: user.username,
      avatar_url: user.avatarPath ? absoluteAvatarUrl : null,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}