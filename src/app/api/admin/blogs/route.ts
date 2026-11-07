import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr, categoryFullPath, ymd } from '@/lib/format';
import { listAdminBlogs } from '@/lib/admin-blog-service';

// GET /api/admin/blogs?page=&category=&search=&status= — 列出所有文章（含软删除）
//
// ⚠️ **内部非契约接口**（2026-11 登记，用户已批准保留）：仓内**没有任何页面消费者** ——
// `/admin/blogs` 页面直接调 `listAdminBlogs`（server component），不从这条 GET 取数；
// 持有它的价值只是「运维/脚本临时排查」。因此：
//   · 不承诺响应形状（snake_case + has_prev 是旧式对外风格，但站外是否有人调无法从仓内证明）；
//   · 已知字段级缺陷：`category_path` 把 `parentId: null, parent: null` 写死再调
//     `categoryFullPath`，而 format.ts 在 parentId 为 null 时只返回自身名称 —— 子栏目的
//     `category_path` 恒等于平铺名。改它需要一个真实 parent 查询，收益仅对内排查可见，
//     故暂不动（真要用这条接口看层级时看 `category_id` 再查栏目页）。
// 想删它之前先确认站外无调用；文档登记（docs/architecture.md 或 API 索引）由 S7 统一做。
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
