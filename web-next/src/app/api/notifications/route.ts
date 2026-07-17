import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { listNotifications, getUnreadCount } from '@/lib/notification-service';

// GET /api/notifications — 当前用户通知列表 + 未读数（需登录）
//   查询参数：page（默认 1）、unread_only（'true' 只看未读）
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const unreadOnly = url.searchParams.get('unread_only') === 'true';

  const [result, unreadCount] = await Promise.all([
    listNotifications(user.id, { page: Number.isNaN(page) ? 1 : page, unreadOnly }),
    getUnreadCount(user.id),
  ]);

  return Response.json({ code: 200, message: 'ok', unreadCount, ...result });
}
