import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { batchMarkRead } from '@/lib/notification-service';
import { parseNotificationIds } from '../batch-params';

// POST /api/notifications/batch-mark-read { notification_ids: string[] }
//   批量标记通知为已读（需登录，限本人）。
//   对齐 Flask notifications.api_batch_mark_read：入参 notification_ids，
//   缺参 / 非数组各自 400，成功返回 count。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const parsed = await parseNotificationIds(req);
  if ('error' in parsed) return apiErr(400, parsed.error);

  // 越权防线在 service 的 recipientId 过滤里：别人的 id 混进来只会匹配不到。
  const count = await batchMarkRead(parsed.ids, user.id);
  return Response.json({ code: 200, message: `已标记 ${count} 个通知为已读`, count });
}
