import { toggleLike } from '@/lib/blog-service';
import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// POST /api/blogs/:id/like — 点赞切换（需登录，内存限频）
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const res = await toggleLike(id, user.id);

  if ('rateLimited' in res) return apiErr(429, '操作过于频繁，请稍后再试');
  if ('notFound' in res) return apiErr(404, '文章不存在');

  return Response.json({ code: 200, message: 'ok', liked: res.liked, likes_count: res.likesCount });
}
