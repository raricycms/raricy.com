import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { listAdminBlogs } from '@/lib/admin-blog-service';
import { categoryFullPath, ymd } from '@/lib/format';

// GET /api/admin/blogs?page=&category=&search=&status= — 列出所有文章（含软删除）
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '需要管理员权限');

  const url = new URL(req.url);
  const catRaw = url.searchParams.get('category');
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'active' || statusRaw === 'deleted' || statusRaw === 'all' ? statusRaw : 'all';

  const result = await listAdminBlogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    categoryId: catRaw == null || catRaw === '' ? null : parseInt(catRaw, 10),
    search: url.searchParams.get('search'),
    status,
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
      ignore: b.ignore ?? false,
      is_featured: b.isFeatured ?? false,
      likes_count: b.likesCount ?? 0,
      comments_count: b.commentsCount ?? 0,
      fish_count: b.fishCount ?? 0,
      category_id: b.categoryId,
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
