import {
  getBlogDetail,
  validateBlogData,
  getCategoryPostingMeta,
  banActionMessage,
  updateBlog,
} from '@/lib/blog-service';
import { categoryFullPath, apiOk, apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';
import { getCurrentUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { sendNotification } from '@/lib/notification-service';

// GET /api/blogs/:id — 文章详情（含 Markdown 正文）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

// PUT /api/blogs/:id — 编辑文章（对齐 Flask blog.edit_blog 的 POST 分支）
// 权限：仅作者本人（对齐 Flask，非作者一律 403 '无权编辑该文章'；FeedButton 也仅对作者显示编辑入口）。
// 顺序：文章存在(未软删) → 作者本人 → 禁言(管理员除外) → 校验 → 栏目管理员专属 → 更新 → （管理员编辑他人时）通知。
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录'); // Flask @login_required

  // 文章存在且未软删（对齐 `if not blog or blog.ignore: abort(404)`）
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { id: true, authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');

  // 权限：仅作者本人
  if (blog.authorId !== user.id) return apiErr(403, '无权编辑该文章');

  // 禁言检查（管理员除外，对齐 check_user_ban_status_for_admin）
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

  // 管理员编辑他人文章时通知作者（对齐 Flask；因本路由仅作者可入，此分支实际不会触发）。
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
