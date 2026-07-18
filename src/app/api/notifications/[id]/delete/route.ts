import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';

// DELETE /api/notifications/:id/delete — 删除单条通知（需登录，限本人）
// 对齐 Flask notifications.delete_notification：硬删除，按 recipient 校验归属。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const res = await prisma.notification.deleteMany({
    where: { id, recipientId: user.id },
  });
  if (res.count === 0) return apiErr(404, '删除失败，通知不存在或无权限');

  return Response.json({ code: 200, message: '通知已删除' });
}
