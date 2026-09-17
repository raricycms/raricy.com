import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { batchDelete } from '@/lib/notification-service';

// DELETE /api/notifications/:id/delete — 删除单条通知（需登录，限本人）
// 对齐 Flask notifications.delete_notification：硬删除，按 recipient 校验归属。
//
// 走 batchDelete([id]) 而不是自己 deleteMany：删掉的可能是**未读**的（未读数会降，
// 顶栏铃铛要跟着变），而推送挂在 service 层。单条删除的意义只是「长度为 1 的批量删除」，
// 没必要为它留第二条写路径 —— 留了就是下一个「改了 service 忘了这里」的坑。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const removed = await batchDelete([id], user.id);
  if (removed === 0) return apiErr(404, '删除失败，通知不存在或无权限');

  return Response.json({ code: 200, message: '通知已删除' });
}
