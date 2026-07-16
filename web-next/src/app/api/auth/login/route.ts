import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { apiErr } from '@/lib/format';
import { cookies } from 'next/headers';

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

  // 支持用户名或邮箱登录
  const user = await prisma.user.findFirst({
    where: { OR: [{ username }, { email: username }] },
    select: { id: true, username: true, passwordHash: true, sessionVersion: true, role: true },
  });

  // 统一错误，避免用户名枚举
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return apiErr(401, '用户名或密码错误');
  }

  const token = await createSessionToken({ uid: user.id, sv: user.sessionVersion ?? 0 });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());

  // 只回读 id：update 默认返回整行，会反序列化 createdAt 等时间戳字段；
  // 若库中时间戳仍是 SQLAlchemy 的空格格式（未跑 normalize-datetimes），
  // Prisma 解析该行会抛错 → 登录 500。这里显式 select 收窄返回，去掉这个失败面。
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() },
    select: { id: true },
  });

  return Response.json({
    code: 200,
    message: '登录成功',
    user: { id: user.id, username: user.username, role: user.role },
  });
}
