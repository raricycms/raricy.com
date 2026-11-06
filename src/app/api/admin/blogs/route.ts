import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr, categoryFullPath, ymd } from '@/lib/format';
import { listAdminBlogs } from '@/lib/admin-blog-service';

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

  // 走 apiOk 而不是裸 Response.json：统一带 Cache-Control: no-store（含软删文章）。
  return apiOk({
    blogs: result.blogs.map((b: {
      id: string;
      title: string;
      description: string | null;
      authorId: string;
      author?: { username: string | null } | null;
      createdAt: Date | null;
      ignore?: boolean | null;
      isFeatured?: boolean | null;
      likesCount?: number | null;
      commentsCount?: number | null;
      fishCount?: number | null;
      categoryId: number | null;
      category?: { name: string } | null;
    }) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      author_id: b.authorId,
      author: b.author?.username ?? null,
      date: b.createdAt ? ymd(b.createdAt) : null,
      ignore: b.ignore ?? false,
      is_featured: b.isFeatured ?? false,
      likes_count: b.likesCount ?? 0,
      comments_count: b.commentsCount ?? 0,
      fish_count: b.fishCount ?? 0,
      category_id: b.categoryId,
      category: b.category?.name ?? null,
      category_path: b.category
        ? categoryFullPath({
            name: b.category.name,
            parentId: null,
            parent: null,
          })
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
