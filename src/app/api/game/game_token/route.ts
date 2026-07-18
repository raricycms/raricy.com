// ─────────────────────────────────────────────────────────────────────────────
// POST /api/game/game_token — 游戏一次性令牌（对齐 Flask app/web/game/game_api.py）
//
// 用途：登录用户请求一枚短时令牌，随后带着它去连接外部实时游戏 WebSocket
// 服务器（魔杖 demo 里是 ws://localhost:3033?token=…）。WS 服务器解开令牌拿到
// user_id，用于把连接绑定到具体用户（成绩上报 / 身份校验 / 反作弊）。
//
// 权限：需登录（Flask 侧为 @login_required）。未登录返回 401。
// 响应：{ token, expires_in: 60 }，与 Flask 的 jsonify 完全一致。
//
// 令牌实现说明：Flask 用 itsdangerous.URLSafeTimedSerializer(GAME_SECRET_KEY)
// 序列化 {'user_id': ...}。这里改用 jose 的 HS256 JWT（与 session.ts 一致的技术栈）
// 承载同一 payload、并硬设 60s 过期。两种格式不互通——外部 WS 服务器若要配合
// Next 版本，需要按 JWT 校验；这与 session.ts 里“itsdangerous ↔ JWT 不互通”的
// 迁移取舍一脉相承。密钥取 GAME_SECRET_KEY，未配置时回退 SECRET_KEY。
// ─────────────────────────────────────────────────────────────────────────────

import { SignJWT } from 'jose';
import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

const TOKEN_TTL_SECONDS = 60;

function gameSecretKey(): Uint8Array {
  const s = process.env.GAME_SECRET_KEY || process.env.SECRET_KEY;
  if (!s) throw new Error('GAME_SECRET_KEY / SECRET_KEY 未配置');
  return new TextEncoder().encode(s);
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const token = await new SignJWT({ user_id: user.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(gameSecretKey());

  return Response.json({ token, expires_in: TOKEN_TTL_SECONDS });
}
