import { registerUser } from '@/lib/user-service';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { apiErr } from '@/lib/format';
import { verifyTurnstile } from '@/lib/turnstile';
import { cookies } from 'next/headers';

// POST /api/auth/register  { username, email, password, invite_code?, turnstileToken? }
// 注册流程：Turnstile 校验 → 校验 → 建号（有效邀请码升级 core）→ 立即登录（下发会话 cookie）。
//
// Turnstile：启用时校验 token，未启用时放行（见 verifyTurnstile）。
export async function POST(req: Request) {
  let body: {
    username?: string;
    email?: string;
    password?: string;
    invite_code?: string;
    turnstileToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  // 人机验证（禁用时 verifyTurnstile 直接放行）。
  //
  // ⚠️ 两类失败必须分开报：token 不合格是 400（用户重试有用）；校验服务不可用
  // （网络 / 超时 / 密钥没配）是 503 —— 后者若也报「人机验证失败」，用户会去反复
  // 折腾一个他无能为力的验证码，排查方向也被带偏（线上实际发生过：生产机连不上
  // challenges.cloudflare.com，全员注册失败却显示人机验证失败）。
  //
  // 这里是 **fail-closed**：校验服务不可用时注册被拒。若要改成可用性优先的降级放行
  // （代价是那段时间没有人机校验），把 unavailable 分支改成不 return 即可。
  const check = await verifyTurnstile(body.turnstileToken ?? '');
  if (!check.ok) {
    if (check.kind === 'unavailable') {
      return apiErr(503, '人机验证服务暂时不可用，请稍后再试');
    }
    return apiErr(400, '人机验证失败，请重试');
  }

  const result = await registerUser({
    username: body.username ?? '',
    email: body.email ?? '',
    password: body.password ?? '',
    inviteCode: body.invite_code ?? null,
  });

  if (!result.ok || !result.user) {
    return apiErr(result.code, result.message);
  }

  // 注册成功后立即登录（与 login route 一致：签发携带 session_version 快照的会话）
  const token = await createSessionToken({
    uid: result.user.id,
    sv: result.user.sessionVersion,
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, await sessionCookieOptions());

  return Response.json({
    code: 200,
    message: result.message,
    user: {
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
    },
  });
}
