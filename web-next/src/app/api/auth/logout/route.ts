import { SESSION_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

// POST /api/auth/logout — 清除会话 cookie
export async function POST() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ code: 200, message: '已退出登录' });
}
