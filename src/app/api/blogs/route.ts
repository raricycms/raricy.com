import {
  listBlogs,
  parseSortParam,
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

// GET /api/blogs?page=&per_page=&category=&featured=&search=&sort=
// per_page：可选（缺省走服务默认 200，行为不变）；传了则 clamp 1..50
// （聊天「引用博客」弹窗用 20 条一页）。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const perPageRaw = url.searchParams.get('per_page');
  const parsedPerPage = Number.parseInt(perPageRaw ?? '', 10);
  // 精选筛选三态，同 /blog 页：'1' → 只看精选，'0' → 只看非精选，缺省 → 不筛。
  // 不能把「没传」算成 false —— 那是生效的筛选，会让精选文章从调用方的列表里
  // 整体消失（QuoteBlogModal 就不传 featured，引用弹窗曾因此搜不到精选文）。
  const featuredRaw = url.searchParams.get('featured');
  const result = await listBlogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    perPage:
      perPageRaw != null && Number.isFinite(parsedPerPage)
        ? Math.min(50, Math.max(1, parsedPerPage))
        : undefined,
    categorySlug: url.searchParams.get('category'),
    featured: featuredRaw === '1' ? true : featuredRaw === '0' ? false : undefined,
    search: url.searchParams.get('search'),
    sort: parseSortParam(url.searchParams.get('sort')),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    blogs: result.blogs.map((b: {
      id: string;
      title: string;
      description: string | null;
      authorId: string;
      author?: { username: string | null } | null;
      createdAt: Date | null;
      likesCount?: number | null;
      commentsCount?: number | null;
      fishCount?: number | null;
      isFeatured?: boolean | null;
      category?: { name: string } | null;
      content?: { updatedAt: Date | null } | null;
    }) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      author_id: b.authorId,
      author: b.author?.username ?? null,
      date: b.createdAt ? ymd(b.createdAt) : null,
      updated_at: b.content?.updatedAt ? ymd(b.content.updatedAt) : null,
      likes_count: b.likesCount ?? 0,
      comments_count: b.commentsCount ?? 0,
      fish_count: b.fishCount ?? 0,
      is_featured: b.isFeatured ?? false,
      category: b.category?.name ?? null,
      category_path: b.category
        ? categoryFullPath({ name: b.category.name, parentId: null, parent: null })
        : null,
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
