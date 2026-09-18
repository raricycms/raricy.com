import { toggleCommentLike } from '@/lib/comment-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// POST /api/comments/:id/like — 评论点赞切换
//
// 【鉴权】需 core+ 登录，与评论树 GET（`/api/blogs/:id/comments`）同档
// （见 `docs/architecture.md` §8「档位阶梯：页面与接口必须同档」）。
// 点赞按钮只出现在 blog 详情页（core+）的评论楼里，非核心用户看不到那个界面 ——
// 此前接口只判登录，等于「界面不给用，curl 得动」。未登录 → 401；非 core → 403。
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const res = await toggleCommentLike(id, user.id);
  if ('rateLimited' in res) return apiErr(429, '操作过于频繁，请稍后再试');
  if ('notFound' in res) return apiErr(404, '评论不存在或已删除');

  return apiOk({ liked: res.liked, likes_count: res.likesCount });
}
