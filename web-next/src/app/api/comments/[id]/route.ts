import { softDeleteComment } from '@/lib/comment-service';
import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// DELETE /api/comments/:id — 软删除评论（作者本人或管理员）
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const res = await softDeleteComment(id, { id: user.id, role: user.role });
  if (res.ok) return apiOk({}, '删除成功');

  const code = res.error === 'forbidden' ? 403 : 404;
  return apiErr(code, res.message);
}
