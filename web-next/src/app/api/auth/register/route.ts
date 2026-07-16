import { registerUser } from '@/lib/user-service';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { apiErr } from '@/lib/format';
import { verifyTurnstile } from '@/lib/turnstile';
import { cookies } from 'next/headers';

// POST /api/auth/register  { username, email, password, invite_code?, turnstileToken? }
// 复刻 Flask 注册：Turnstile 校验 → 校验 → 建号（有效邀请码升级 core）→ 立即登录（下发会话 cookie）。
//
// Turnstile：对齐 Flask sign_up.py —— 启用时校验 token，未启用时放行（见 verifyTurnstile）。
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

  // 人机验证（禁用时 verifyTurnstile 直接返回 true）。
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    undefined;
  const passed = await verifyTurnstile(body.turnstileToken ?? '', ip);
  if (!passed) {
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
  store.set(SESSION_COOKIE, token, sessionCookieOptions());

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
