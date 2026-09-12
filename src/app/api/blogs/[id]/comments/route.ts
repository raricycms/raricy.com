import { listCommentsForBlog, createComment } from '@/lib/comment-service';
import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/blogs/:id/comments — 评论嵌套树（公开）
//
// 接口本身不需要登录（评论是公开内容），但登录时要把「谁在看」传下去 —— 每条评论的
// liked 是随人而变的。未登录 → viewerId 为 null，liked 全为 false。
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await getCurrentUser();
  const comments = await listCommentsForBlog(id, viewer?.id ?? null);
  return apiOk({ comments });
}

// POST /api/blogs/:id/comments — 创建评论（需登录，禁言禁止，每日限额）
// body: { content?: string, parent_id?: string, image_id?: string, quote_blog_id?: string }
//
// content 是 Markdown 源；渲染在客户端（src/lib/comment-markdown.ts），服务端只存原文
// 并另存一份转义纯文本（contentHtml，给 spider API 与无 JS 降级）。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '您已被禁言，无法发表评论');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    content?: unknown;
    parent_id?: unknown;
    image_id?: unknown;
    quote_blog_id?: unknown;
  };
  const content = typeof body.content === 'string' ? body.content : '';
  const parentId = typeof body.parent_id === 'string' ? body.parent_id : null;
  const imageId = typeof body.image_id === 'string' && body.image_id ? body.image_id : null;
  const quoteBlogId =
    typeof body.quote_blog_id === 'string' && body.quote_blog_id ? body.quote_blog_id : null;

  const res = await createComment({
    blogId: id,
    authorId: user.id,
    content,
    parentId,
    imageId,
    quoteBlogId,
  });
  if (res.ok) return apiOk({ comment: res.comment }, '评论成功');

  const code =
    res.error === 'rateLimited' ? 429 : res.error === 'notFound' ? 404 : 400;
  return apiErr(code, res.message);
}
