import { getSpiderBlog } from '@/lib/spider-service';
import { apiErr } from '@/lib/format';

// GET /api/spider/blogs/:id — 爬虫单篇博客（含正文 Markdown），无认证
// 对齐 Flask: GET /blog/spider/blogs/<blog_id>
//   blog_dict, content = BlogService.get_blog_detail(blog_id)
//   if blog_dict is None: abort(404)
//   return jsonify({'meta': blog_dict, 'content': content})
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await getSpiderBlog(id);
  if (!result) return apiErr(404, '文章不存在'); // Flask abort(404)

  return Response.json({ meta: result.meta, content: result.content });
}
