import { getSpiderBlog } from '@/lib/spider-service';
import { apiErr } from '@/lib/format';

// GET /api/spider/blogs/:id — 爬虫单篇博客（含正文 Markdown），无认证
// 无认证是刻意的：这条给搜索引擎 / 站外爬虫抓公开内容，读公开数据不该先要账号。
//   · 不存在 / 已软删（ignore=true）→ 404 { code, message }
//   · 命中 → 裸 JSON { meta, content }（不套 { code, message } 信封）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await getSpiderBlog(id);
  if (!result) return apiErr(404, '文章不存在'); // 不存在与已软删，同一个 404

  return Response.json({ meta: result.meta, content: result.content });
}
