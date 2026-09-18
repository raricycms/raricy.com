import { getRecentComments } from '@/lib/spider-service';

// GET /api/spider/comments — 爬虫最近评论列表（扁平数组），无认证
// 无认证是刻意的：这条给搜索引擎 / 站外爬虫抓公开内容，读公开数据不该先要账号。
//   · 最近 100 条，status='approved'（按 created_at 倒序）
//   · 裸数组，不套 { code, message } 信封
export async function GET() {
  const comments = await getRecentComments();
  return Response.json(comments);
}
