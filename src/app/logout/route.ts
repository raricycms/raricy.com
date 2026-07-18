import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/session';

// GET /logout — 清除会话 cookie 并回首页（顶栏"退出登录"链接，无需 JS）
export async function GET(req: Request) {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/', req.url));
}
