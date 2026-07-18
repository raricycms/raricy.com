import { listCommentsForBlog, createComment } from '@/lib/comment-service';
import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/blogs/:id/comments — 评论嵌套树（公开）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const comments = await listCommentsForBlog(id);
  return apiOk({ comments });
}

// POST /api/blogs/:id/comments — 创建评论（需登录，禁言禁止，每日限额）
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '您已被禁言，无法发表评论');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { content?: unknown; parent_id?: unknown };
  const content = typeof body.content === 'string' ? body.content : '';
  const parentId = typeof body.parent_id === 'string' ? body.parent_id : null;

  const res = await createComment({ blogId: id, authorId: user.id, content, parentId });
  if (res.ok) return apiOk({ comment: res.comment }, '评论成功');

  const code =
    res.error === 'rateLimited' ? 429 : res.error === 'notFound' ? 404 : 400;
  return apiErr(code, res.message);
}
