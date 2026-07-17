import { getFeeders } from '@/lib/feed-service';
import { prisma } from '@/lib/db';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/blogs/:id/feeders — 投喂者列表（对齐 Flask blog_bp /<blog_id>/feeders）
//
// 权限：登录 + 仅作者本人或管理员可见 —— 与 Flask 一致。
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

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
