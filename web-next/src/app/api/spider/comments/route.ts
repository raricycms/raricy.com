import { getRecentComments } from '@/lib/spider-service';

// GET /api/spider/comments — 爬虫最近评论列表（扁平数组），无认证
// 对齐 Flask: GET /blog/spider/comments
//   comments_lst = CommentService.get_recent_comments()  # 最近 100 条，status='approved'
//   return jsonify(comments_lst)                          # 裸数组，不包 {code,message}
export async function GET() {
  const comments = await getRecentComments();
  return Response.json(comments);
}
