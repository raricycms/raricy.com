import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { markAllRead } from '@/lib/notification-service';

// POST /api/notifications/read-all — 标记当前用户所有未读通知为已读（需登录）
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const count = await markAllRead(user.id);
  return Response.json({ code: 200, message: `已标记 ${count} 个通知为已读`, count });
}
