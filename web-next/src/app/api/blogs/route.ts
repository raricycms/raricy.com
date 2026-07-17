import {
  listBlogs,
  validateBlogData,
  countBlogsToday,
  getCategoryPostingMeta,
  banActionMessage,
  createBlog,
  BLOG_DAILY_LIMIT,
} from '@/lib/blog-service';
import { categoryFullPath, ymd, apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { sendNotification } from '@/lib/notification-service';
import { prisma } from '@/lib/db';

// GET /api/blogs?page=&category=&featured=&search=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const result = await listBlogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    categorySlug: url.searchParams.get('category'),
    featured: url.searchParams.get('featured') === '1',
    search: url.searchParams.get('search'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    blogs: result.blogs.map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      author_id: b.authorId,
      author: b.author?.username ?? null,
      date: ymd(b.createdAt),
      likes_count: b.likesCount ?? 0,
      comments_count: b.commentsCount ?? 0,
      fish_count: b.fishCount ?? 0,
      is_featured: b.isFeatured ?? false,
      category: b.category?.name ?? null,
      category_path: b.category ? categoryFullPath(b.category) : null,
    })),
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}

// POST /api/blogs — 发布新文章（对齐 Flask blog.upload 的 POST 分支）
// 顺序严格对齐：登录 → 禁言 → 核心用户 → 校验 → 日限额 → 栏目管理员专属 → 建文 → 通知。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录'); // Flask @login_required（API 返回 JSON 401）

  // 禁言检查（upload 对所有用户生效，含管理员）
  if (isCurrentlyBanned(user)) return apiErr(403, banActionMessage(user));

  // 仅核心用户可发布
  if (!isCoreUser(user)) return apiErr(403, '只有核心用户才能发布文章');

  const body = await req.json().catch(() => null);
  const v = await validateBlogData(body);
  if (!v.ok) return apiErr(400, v.message);

  // 每日发文上限（20 篇）
  const todayCount = await countBlogsToday(user.id);
  if (todayCount >= BLOG_DAILY_LIMIT) {
    return apiErr(429, '今日发布数量已达上限（20篇）');
  }

  // 栏目“仅管理员可发”校验（含父栏目）
  let notifyEffective = false;
  let fullPath = '';
  if (v.data.categoryId != null) {
    const meta = await getCategoryPostingMeta(v.data.categoryId);
    if (meta.adminOnlyEffective && !hasAdminRights(user)) {
      return apiErr(403, '该栏目仅允许管理员发布文章');
    }
    notifyEffective = meta.notifyEffective;
    fullPath = meta.fullPath;
  }

  const blogId = await createBlog(user.id, v.data);

  // 栏目发文提醒：通知所有管理员/站长（跳过自己），失败忽略（对齐 Flask try/except pass）
  if (v.data.categoryId != null && notifyEffective) {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['admin', 'owner'] } },
      select: { id: true },
    });
    for (const admin of admins) {
      if (admin.id === user.id) continue;
      try {
        await sendNotification({
          recipientId: admin.id,
          action: '栏目发文提醒',
          actorId: user.id,
          objectType: 'blog',
          objectId: blogId,
          detail: `用户 ${user.username} 在栏目 "${fullPath}" 发布了新文章：${v.data.title}`,
        });
      } catch {
        // 忽略单条通知失败
      }
    }
  }

  return apiOk({ blog_id: blogId, redirect: `/blog/${blogId}` }, '上传成功');
}
