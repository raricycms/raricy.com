import { getFeeders } from '@/lib/feed-service';
import { prisma } from '@/lib/db';
import { getCurrentUser, isCoreUser, hasAdminRights } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/blogs/:id/feeders — 投喂者列表
//
// 权限：core+ **且**（作者本人或管理员），口径同 likers。
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;

  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');
  if (blog.authorId !== user.id && !hasAdminRights(user)) return apiErr(403, '无权查看');

  const sp = new URL(req.url).searchParams;
  const offset = Number.parseInt(sp.get('offset') ?? '', 10);
  const limit = Number.parseInt(sp.get('limit') ?? '', 10);

  const data = await getFeeders(
    id,
    Number.isFinite(offset) ? offset : 0,
    Number.isFinite(limit) ? limit : 50
  );

  return Response.json({ code: 200, message: 'ok', ...data });
}
