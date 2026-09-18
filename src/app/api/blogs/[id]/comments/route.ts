import { listCommentsForBlog, createComment } from '@/lib/comment-service';
import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/blogs/:id/comments — 评论嵌套树
//
// 【鉴权】需 core+ 登录。评论内容本身是公开的，但这条接口对外只服务机器人，而本站的
// 机器人模型是「一个 core+ 账号 + 会话 cookie」（见 docs/bot/chat-bot.md §2）——
// 与 spider 命名空间同档。对外的唯一口径写在 docs/bot/comment-bot.md §6。
// 未登录 → 401；已登录但非 core → 403。
//
// viewerId 传当前用户 id：每条评论的 liked 是随人而变的。
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await getCurrentUser();
  if (!viewer) return apiErr(401, '请先登录');
  if (!isCoreUser(viewer)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const comments = await listCommentsForBlog(id, viewer.id);
  return apiOk({ comments });
}

// POST /api/blogs/:id/comments — 创建评论（需 core+，禁言禁止，每日限额）
// body: { content?: string, parent_id?: string, image_id?: string, quote_blog_id?: string }
//
// content 是 Markdown 源；渲染在客户端（src/lib/comment-markdown.ts），服务端只存原文
// 并另存一份转义纯文本（contentHtml，给 spider API 与无 JS 降级）。
//
// 【鉴权】需 core+ 登录，与同文件上面的 GET 同档（见 `docs/architecture.md` §8
// 「档位阶梯：页面与接口必须同档」）。此前只判登录，而 blog 详情页给评论框传的是
// `canComment={isCore}` —— 界面不给非核心用户用，接口却放行，于是 curl 就能往
// **自己都读不了的文章**上发评论。对外口径见 `docs/bot/comment-bot.md` §6。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '您已被禁言，无法发表评论');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    content?: unknown;
    parent_id?: unknown;
    image_id?: unknown;
    quote_blog_id?: unknown;
  };
  const content = typeof body.content === 'string' ? body.content : '';
  const parentId = typeof body.parent_id === 'string' ? body.parent_id : null;
  const imageId = typeof body.image_id === 'string' && body.image_id ? body.image_id : null;
  const quoteBlogId =
    typeof body.quote_blog_id === 'string' && body.quote_blog_id ? body.quote_blog_id : null;

  const res = await createComment({
    blogId: id,
    authorId: user.id,
    content,
    parentId,
    imageId,
    quoteBlogId,
  });
  if (res.ok) return apiOk({ comment: res.comment }, '评论成功');

  const code =
    res.error === 'rateLimited' ? 429 : res.error === 'notFound' ? 404 : 400;
  return apiErr(code, res.message);
}
