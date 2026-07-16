import { getBlogDetail } from '@/lib/blog-service';
import { categoryFullPath } from '@/lib/format';
import { apiErr } from '@/lib/format';

// GET /api/blogs/:id — 文章详情（含 Markdown 正文）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const blog = await getBlogDetail(id);
  if (!blog) return apiErr(404, '文章不存在');

  return Response.json({
    code: 200,
    message: 'ok',
    blog: {
      id: blog.id,
      title: blog.title,
      description: blog.description,
      author: blog.author?.username ?? null,
      author_id: blog.authorId,
      created_at: blog.createdAt?.toISOString() ?? null,
      likes_count: blog.likesCount ?? 0,
      comments_count: blog.commentsCount ?? 0,
      fish_count: blog.fishCount ?? 0,
      category: blog.category?.name ?? null,
      category_path: blog.category ? categoryFullPath(blog.category) : null,
      content: blog.content?.content ?? '',
    },
  });
}
