import { getSpiderComment } from '@/lib/spider-service';
import { apiErr } from '@/lib/format';

// GET /api/spider/comments/:id — 爬虫单条评论（裸对象），无认证
// 无认证是刻意的：这条给搜索引擎 / 站外爬虫抓公开内容，读公开数据不该先要账号。
//   · 按 id 查且 is_deleted=false —— 已软删的评论当不存在
//   · 查不到 → 404 { code, message }
//   · 命中 → 裸 JSON（评论对象本身，不套 { code, message } 信封）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const comment = await getSpiderComment(id);
  if (!comment) return apiErr(404, '评论不存在');

  return Response.json(comment);
}
