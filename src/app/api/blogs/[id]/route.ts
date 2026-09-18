import {
  getBlogDetail,
  validateBlogData,
  getCategoryPostingMeta,
  banActionMessage,
  updateBlog,
} from '@/lib/blog-service';
import { setBlogIgnore } from '@/lib/admin-blog-service';
import { categoryFullPath, apiOk, apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';
import { getCurrentUser, isCoreUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { sendNotification } from '@/lib/notification-service';

// GET /api/blogs/:id — 文章详情（含 Markdown 正文）
//
// 【鉴权】需 core+ 登录，与 `/blog/:id` 页面同档（见 `docs/architecture.md` §8
// 「档位阶梯：页面与接口必须同档，每层都自己判」）。
// 这条此前完全免认证 —— 页面那道 `requireCoreUser()` 于是只挡住浏览器，挡不住任何拿到
// id 的调用方：匿名 curl 一下就是全文 Markdown。未登录 → 401；已登录但非 core → 403，
// 错误走 { code, message } 信封。**成功路径的形状一字不动**（加鉴权不该顺带改对外契约）。
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const blog = await getBlogDetail(id);
  if (!blog) return apiErr(404, '文章不存在');

  return Response.json({
    code: 200,
    message: 'ok',
    blog: {
      id: blog.id,
      title: blog.title,
      description: blog.description,
      author: blog.author?.username ?? null,
      author_id: blog.authorId,
      created_at: blog.createdAt?.toISOString() ?? null,
      likes_count: blog.likesCount ?? 0,
      comments_count: blog.commentsCount ?? 0,
      fish_count: blog.fishCount ?? 0,
      category: blog.category?.name ?? null,
      category_path: blog.category ? categoryFullPath(blog.category) : null,
      content: blog.content?.content ?? '',
    },
  });
}

// PUT /api/blogs/:id — 编辑文章
// 权限：core+ **且** 作者本人（非作者一律 403 '无权编辑该文章'；FeedButton 也仅对作者
// 显示编辑入口）。两层别混：档位管「你有没有资格写文章」，归属管「这篇是不是你的」。
// 顺序：登录 → core+ → 文章存在(未软删) → 作者本人 → 禁言(管理员除外) → 校验 → 栏目管理员专属 → 更新 → （管理员编辑他人时）通知。
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录'); // 需登录
  // 编辑页是 `requireCoreUser()` + 作者（src/app/blog/[id]/edit/page.tsx:24,30），
  // 接口必须同档。少了这一层，被降权（core→user）的作者仍能 curl 改自己的文章。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  // 文章存在且未软删（软删等同不存在 → 404）
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { id: true, authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');

  // 权限：仅作者本人
  if (blog.authorId !== user.id) return apiErr(403, '无权编辑该文章');

  // 禁言检查（管理员除外）
  if (!hasAdminRights(user) && isCurrentlyBanned(user)) {
    return apiErr(403, banActionMessage(user));
  }

  const body = await req.json().catch(() => null);
  const v = await validateBlogData(body);
  if (!v.ok) return apiErr(400, v.message);

  // 栏目“仅管理员可发”校验（含父栏目）
  if (v.data.categoryId != null) {
    const meta = await getCategoryPostingMeta(v.data.categoryId);
    if (meta.adminOnlyEffective && !hasAdminRights(user)) {
      return apiErr(403, '该栏目仅允许管理员发布文章');
    }
  }

  const { hasChanges, changesDetail } = await updateBlog(id, v.data);

  // 管理员编辑他人文章时通知作者（因本路由仅作者可入，此分支实际不会触发）。
  if (hasChanges && hasAdminRights(user) && blog.authorId !== user.id) {
    try {
      const changesText = changesDetail.length ? changesDetail.join('、') : '文章内容已更新';
      await sendNotification({
        recipientId: blog.authorId,
        action: '文章编辑',
        actorId: user.id,
        objectType: 'blog',
        objectId: id,
        detail: `你的文章《${v.data.title}》已被管理员编辑。修改内容：${changesText}`,
      });
    } catch {
      // 忽略通知失败
    }
  }

  return apiOk({ blog_id: id, redirect: `/blog/${id}` }, '更新成功');
}

// DELETE /api/blogs/:id — 作者本人删自己的文章
// 权限：core+ **且** 作者本人（同 PUT，两层别混）。
// 管理员删他人请走 /api/admin/blogs/:id（要求 reason + 写日志 + 通知作者）。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { id: true, authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');
  if (blog.authorId !== user.id) return apiErr(403, '无权删除该文章');

  const result = await setBlogIgnore(id, true);
  if (!result.ok) return apiErr(404, result.message);
  return apiOk({ blog: result.data }, '文章已删除');
}
