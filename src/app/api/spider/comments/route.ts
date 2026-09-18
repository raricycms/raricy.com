import { getRecentComments } from '@/lib/spider-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/spider/comments — 最近评论列表（扁平数组）
//
// 【鉴权】需 core+ 登录，理由同 spider/blogs/:id（本站机器人模型 = core+ 账号 + cookie）。
// 对外口径见 docs/bot/comment-bot.md §6。
//   · 未登录 → 401；已登录但非 core → 403（错误一律走 { code, message } 信封）
//   · 最近 100 条，status='approved'（按 created_at 倒序）
//   · 成功 → 裸数组，不套信封（本命名空间的既有口径）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const comments = await getRecentComments();
  return Response.json(comments);
}
