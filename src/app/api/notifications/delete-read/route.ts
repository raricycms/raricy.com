import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';

// DELETE /api/notifications/delete-read — 删除当前用户所有已读通知（需登录）
// 硬删除（通知表没有软删标记，删就是删行），返回删除数量。
//
// 【为什么这里不需要推顶栏】条件里有 `read: true` —— 它删的全是已读的，
// 未读数一个都不会少。别看到「另一个路由收编进 service 了」就来这里补推送。
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const res = await prisma.notification.deleteMany({
    where: { recipientId: user.id, read: true },
  });
  return Response.json({ code: 200, message: `已删除 ${res.count} 个已读通知`, count: res.count });
}
