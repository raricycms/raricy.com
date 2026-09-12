import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';

// DELETE /api/notifications/delete-read — 删除当前用户所有已读通知（需登录）
// 对齐 Flask notifications.delete_read_notifications：硬删除，返回删除数量。
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const res = await prisma.notification.deleteMany({
    where: { recipientId: user.id, read: true },
  });
  return Response.json({ code: 200, message: `已删除 ${res.count} 个已读通知`, count: res.count });
}
