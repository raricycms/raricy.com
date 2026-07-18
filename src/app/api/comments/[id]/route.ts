import { softDeleteComment } from '@/lib/comment-service';
import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// DELETE /api/comments/:id — 软删除评论（作者本人或管理员）
// body（可选）: { reason?: string }
//   对齐 Flask CommentService.delete_comment：管理员删「他人」评论时必须给出原因（1..500），
//   并据此写 AdminActionLog —— 那条日志是 /audit 公示与用户申诉的数据来源。
//   作者删自己的评论不需要原因。
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;

  // DELETE 请求通常没有 body，解析失败按「未提供原因」处理
  let reason: string | undefined;
  try {
    const body = (await req.json()) as { reason?: unknown } | null;
    if (body && typeof body.reason === 'string') reason = body.reason;
  } catch {
    /* 无 body 或非 JSON —— 作者删自己评论的常规情况 */
  }

  const res = await softDeleteComment(id, { id: user.id, role: user.role }, reason);
  if (res.ok) return apiOk({}, '删除成功');

  // reasonRequired / reasonTooLong 属参数问题 → 400；无权 → 403；其余 → 404
  const code =
    res.error === 'forbidden'
      ? 403
      : res.error === 'reasonRequired' || res.error === 'reasonTooLong'
        ? 400
        : 404;
  return apiErr(code, res.message);
}
