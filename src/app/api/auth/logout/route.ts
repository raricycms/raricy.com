import { SESSION_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

async function clearSessionAndRespond() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ code: 200, message: '已退出登录' });
}

// POST /api/auth/logout — 主用法（base.js + LogoutLink 组件）
export async function POST() {
  return clearSessionAndRespond();
}

// GET /api/auth/logout — 向后兼容 Flask 的 GET 行为（也方便用户书签直链登出）
export async function GET() {
  return clearSessionAndRespond();
}