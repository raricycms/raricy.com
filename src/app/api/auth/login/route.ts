import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { verifyPassword } from '@/lib/password';
import { isRateLimited, recordRateLimitHit, RULES } from '@/lib/rate-limit';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { apiErr } from '@/lib/format';
import { cookies } from 'next/headers';

/** 反代后的真实客户端 IP（与 register 路由同一取法）。取不到就跳过 IP 维度。 */
function clientIp(req: Request): string | undefined {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    undefined
  );
}

// POST /api/auth/login  { username, password }
// 复刻 Flask 登录：校验密码（werkzeug 兼容）→ 签发会话（携带 session_version 快照）。
export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) return apiErr(400, '用户名和密码不能为空');

  // 限频：IP 与用户名双维度（见 RULES.loginPerIp / loginPerUser 的注释）。
  // **只统计失败** —— 成功登录不消耗配额，否则正常用户（以及反复登录的自动化）
  // 会被自己的成功记录挡在门外。检查放在查库与 verifyPassword 之前，
  // 被挡的请求不消耗 scrypt。用户名小写归一，否则改个大小写就换了个计数桶。
  const ip = clientIp(req);
  const ipKey = ip ? `login:ip:${ip}` : null;
  const userKey = `login:user:${username.toLowerCase()}`;
  if ((ipKey && isRateLimited(ipKey, RULES.loginPerIp)) || isRateLimited(userKey, RULES.loginPerUser)) {
    return apiErr(429, '尝试过于频繁，请 15 分钟后再试');
  }

  // 支持用户名或邮箱登录
  const user = await prisma.user.findFirst({
    where: { OR: [{ username }, { email: username }] },
    select: { id: true, username: true, passwordHash: true, sessionVersion: true, role: true },
  });

  // 统一错误，避免用户名枚举
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    if (ipKey) recordRateLimitHit(ipKey);
    recordRateLimitHit(userKey);
    return apiErr(401, '用户名或密码错误');
  }

  const token = await createSessionToken({ uid: user.id, sv: user.sessionVersion ?? 0 });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, await sessionCookieOptions());

  // 只回读 id：update 默认返回整行，会反序列化 createdAt 等时间戳字段；
  // 若库中时间戳仍是 SQLAlchemy 的空格格式（未跑 normalize-datetimes），
  // Prisma 解析该行会抛错 → 登录 500。这里显式 select 收窄返回，去掉这个失败面。
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: nowForDb() },
    select: { id: true },
  });

  return Response.json({
    code: 200,
    message: '登录成功',
    user: { id: user.id, username: user.username, role: user.role },
  });
}
