import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { batchDelete } from '@/lib/notification-service';
import { parseNotificationIds } from '../batch-params';

// DELETE /api/notifications/batch-delete { notification_ids: string[] }
//   批量删除通知（需登录，限本人）。硬删除，对齐 Flask notifications.api_batch_delete。
export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const parsed = await parseNotificationIds(req);
  if ('error' in parsed) return apiErr(400, parsed.error);

  // 越权防线在 service 的 recipientId 过滤里：别人的 id 混进来只会匹配不到。
  const count = await batchDelete(parsed.ids, user.id);
  return Response.json({ code: 200, message: `已删除 ${count} 个通知`, count });
}
