import { getSpiderComment } from '@/lib/spider-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/spider/comments/:id — 单条评论（裸对象）
//
// 【鉴权】需 core+ 登录，理由同 spider/blogs/:id（本站机器人模型 = core+ 账号 + cookie）。
// 对外口径见 docs/bot/comment-bot.md §6。
//   · 未登录 → 401；已登录但非 core → 403（错误一律走 { code, message } 信封）
//   · 按 id 查且 is_deleted=false —— 已软删的评论当不存在
//   · 查不到 → 404 { code, message }
//   · 命中 → 裸 JSON（评论对象本身，**成功路径**不套信封）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const comment = await getSpiderComment(id);
  if (!comment) return apiErr(404, '评论不存在');

  return Response.json(comment);
}
