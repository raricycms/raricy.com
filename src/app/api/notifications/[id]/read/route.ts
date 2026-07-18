import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { markRead } from '@/lib/notification-service';

// POST /api/notifications/:id/read — 标记单条通知已读（需登录，限本人）
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const ok = await markRead(id, user.id);
  if (!ok) return apiErr(404, '标记失败，通知不存在或无权限');

  return Response.json({ code: 200, message: '通知已标记为已读' });
}
