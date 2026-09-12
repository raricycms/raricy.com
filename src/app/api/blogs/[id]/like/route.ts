import { toggleLike } from '@/lib/blog-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// POST /api/blogs/:id/like — 点赞切换（需登录，内存限频）
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const res = await toggleLike(id, user.id);

  if ('rateLimited' in res) return apiErr(429, '操作过于频繁，请稍后再试');
  if ('notFound' in res) return apiErr(404, '文章不存在');

  return Response.json({ code: 200, message: 'ok', liked: res.liked, likes_count: res.likesCount });
}
