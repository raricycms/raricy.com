import { listBlogs } from '@/lib/blog-service';
import { categoryFullPath, ymd } from '@/lib/format';

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
