import { getCurrentUser } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notification-service';

// GET /api/notifications/count — base.js 顶栏红点轮询用，返回 { count }
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ code: 200, count: 0 });
  const count = await getUnreadCount(user.id);
  return Response.json({ code: 200, count });
}
