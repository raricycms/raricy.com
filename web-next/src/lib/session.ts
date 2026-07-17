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
import { headers } from 'next/headers';

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

/**
 * 会话 cookie 选项。
 *
 * 【Secure 标记的判定】顺序：COOKIE_SECURE（显式） → X-Forwarded-Proto（反代透传的真实协议）
 * → NODE_ENV 兜底。
 *
 * 为什么不能简单写 `secure: NODE_ENV === 'production'`：
 * 站点若走纯 HTTP（未上 TLS），带 Secure 的 cookie 会被浏览器直接丢弃 ——
 * 表现为「登录接口返回 200 登录成功，但会话不粘、刷新仍未登录」，且无任何报错。
 * 原 Flask 未设置 SESSION_COOKIE_SECURE（默认 False），HTTP 下可用；此处对齐该行为。
 *
 * ⚠️ 安全提醒：HTTP 下会话 cookie 以明文传输，链路上任何人都可窃取并冒用会话。
 * 生产站点应上 TLS；COOKIE_SECURE=false 仅作为过渡期的显式选择。
 */
export async function sessionCookieOptions() {
  const secure = await shouldUseSecureCookie();
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

async function shouldUseSecureCookie(): Promise<boolean> {
  // 1) 显式配置优先
  const cfg = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (cfg === 'true' || cfg === '1') return true;
  if (cfg === 'false' || cfg === '0') return false;

  // 2) 反代透传的真实协议（nginx: proxy_set_header X-Forwarded-Proto $scheme）
  try {
    const h = await headers();
    const proto = h.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (proto) return proto === 'https';
  } catch {
    // 非请求上下文（理论上不会走到）→ 落到兜底
  }

  // 3) 兜底：生产默认开启（直连 HTTPS 的常规部署）
  return process.env.NODE_ENV === 'production';
}
