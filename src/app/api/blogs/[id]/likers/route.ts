import { getLikers } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import { getCurrentUser, isCoreUser, hasAdminRights } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/blogs/:id/likers — 点赞者列表
//
// 权限：core+ **且**（作者本人或管理员）。两层别混：档位管「你有没有资格用博客区」，
// 归属管「这份名单你配不配看」。
// 谁给你点了赞属于作者的信息，不对所有人公开。
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

  // 解析失败一律回落默认值，不因脏参数报错
  const sp = new URL(req.url).searchParams;
  const offset = Number.parseInt(sp.get('offset') ?? '', 10);
  const limit = Number.parseInt(sp.get('limit') ?? '', 10);

  const data = await getLikers(
    id,
    Number.isFinite(offset) ? offset : 0,
    Number.isFinite(limit) ? limit : 50
  );
  if (!data) return apiErr(404, '文章不存在');

  return Response.json({ code: 200, message: '获取成功', ...data });
}
