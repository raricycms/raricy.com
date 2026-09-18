import { getSpiderBlog } from '@/lib/spider-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/spider/blogs/:id — 单篇博客（含正文 Markdown）
//
// 【鉴权】需 core+ 登录。这几条接口的使用方是**机器人**，而本站的机器人模型一直是
// 「一个 core+ 账号 + 会话 cookie」（提权步骤见 docs/bot/chat-bot.md §2）—— 这里与
// 之一致。对外的唯一口径写在 docs/bot/comment-bot.md §6。
//   · 未登录 → 401；已登录但非 core → 403（错误一律走 { code, message } 信封）
//   · 不存在 / 已软删（ignore=true）→ 404 { code, message }
//   · 命中 → 裸 JSON { meta, content }（**成功路径**不套信封，这是本命名空间的既有口径）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const result = await getSpiderBlog(id);
  if (!result) return apiErr(404, '文章不存在'); // 不存在与已软删，同一个 404

  return Response.json({ meta: result.meta, content: result.content });
}
