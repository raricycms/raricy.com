// ─────────────────────────────────────────────────────────────────────────────
// session.ts — 基于 JWT 的会话（替代 Flask-Login 的签名 cookie）
//
// 设计对齐 Flask 侧的 session_version 失效机制：cookie 里存 { uid, sv }，
// 每次取用户时用 DB 里的 user.sessionVersion 比对，不一致即视为登出
// （改密码 / 强制下线时后端自增 sessionVersion 即可让所有旧 cookie 失效）。
//
// 说明：Flask 用的是 itsdangerous 签名的 session cookie，格式与 JWT 不同，
// 二者不互通——这意味着切换到 Next 时用户需要重新登录一次（可接受，已在迁移
// 文档中说明）。密码哈希互通，因此重新登录不需要改密码。
// ─────────────────────────────────────────────────────────────────────────────

import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'raricy_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 天

function secretKey(): Uint8Array {
  const s = process.env.SECRET_KEY;
  if (!s) throw new Error('SECRET_KEY 未配置');
  return new TextEncoder().encode(s);
}

export interface SessionPayload {
  uid: string;
  sv: number; // session_version 快照
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ uid: payload.uid, sv: payload.sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.uid !== 'string' || typeof payload.sv !== 'number') return null;
    return { uid: payload.uid, sv: payload.sv };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}
