import { getSpiderComment } from '@/lib/spider-service';
import { apiErr } from '@/lib/format';

// GET /api/spider/comments/:id — 爬虫单条评论（裸对象），无认证
// 对齐 Flask: GET /blog/spider/comments/<comment_id>
//   comment = CommentService.get_comment(comment_id=comment_id)  # id + is_deleted=False
//   if not comment: return not_found_response('评论不存在')       # {code:404, message} @404
//   return jsonify(comment)                                      # 裸对象，不包 {code,message}
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const comment = await getSpiderComment(id);
  if (!comment) return apiErr(404, '评论不存在');

  return Response.json(comment);
}
