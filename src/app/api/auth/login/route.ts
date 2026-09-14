import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { apiErr } from '@/lib/format';
import { cookies } from 'next/headers';

// POST /api/auth/login  { username, password }
// 复刻 Flask 登录：校验密码（werkzeug 兼容）→ 签发会话（携带 session_version 快照）。
//
// 【校验与限频在 credential-auth.ts】那是与鱼干市场无状态接口**共用**的实现：
// 两个门口都是「未认证即可跑一次 scrypt」，防线各写一份必然 drift，
// 而松的那一份就是绕过口。本路由只负责「校验通过之后」的事：签发 cookie + 记 lastLogin。
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

  const cred = await verifyCredentials(username, password, clientIp(req));
  if (!cred.ok) return apiErr(cred.status, cred.message);
  const user = cred.user;

  const token = await createSessionToken({ uid: user.id, sv: user.sessionVersion });
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
