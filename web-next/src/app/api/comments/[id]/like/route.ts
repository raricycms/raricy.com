import { toggleCommentLike } from '@/lib/comment-service';
import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// POST /api/comments/:id/like — 评论点赞切换（需登录）
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const res = await toggleCommentLike(id, user.id);
  if ('notFound' in res) return apiErr(404, '评论不存在或已删除');

  return apiOk({ liked: res.liked, likes_count: res.likesCount });
}
