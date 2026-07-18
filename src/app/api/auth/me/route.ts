import { getCurrentUser } from '@/lib/auth';

// GET /api/auth/me — 当前登录用户（未登录返回 user: null）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ code: 200, message: 'ok', user: null });
  return Response.json({
    code: 200,
    message: 'ok',
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      avatarPath: user.avatarPath,
      driedFish: user.driedFish,
    },
  });
}
