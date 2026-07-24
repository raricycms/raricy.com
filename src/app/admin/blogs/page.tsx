import { listAdminBlogs } from '@/lib/admin-blog-service';
import { listCategoriesTree } from '@/lib/admin-category-service';
import { categoryFullPath, ymd } from '@/lib/format';
import AdminArticlesManager, { type ArticleRow } from '@/app/components/AdminArticlesManager';
import type { CategoryGroup } from '@/app/components/AdminBlogActions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  category?: string;
  search?: string;
}

type CategoryTreeNode = {
  id: number;
  name: string;
  icon: string | null;
  children?: CategoryTreeNode[];
};

type BlogRow = {
  id: number | string;
  title: string;
  description: string | null;
  author?: { username: string | null } | null;
  createdAt: Date | string | null;
  likesCount: number | null;
  isFeatured: boolean | null;
  categoryId: number | null;
  category?: Parameters<typeof categoryFullPath>[0] | null;
};

// 文章栏目管理 — Fluent Design
export default async function AdminBlogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const currentCategoryId = sp.category ?? '';
  const parsed = parseInt(currentCategoryId, 10);
  const categoryId =
    currentCategoryId === '' || Number.isNaN(parsed) ? null : parsed;

  const [result, tree] = await Promise.all([
    listAdminBlogs({
      page: parseInt(sp.page || '1', 10),
      categoryId,
      search: sp.search ?? null,
      status: 'active',
    }),
    listCategoriesTree(),
  ]);

  const withIcon = (icon: string | null, name: string): string =>
    icon ? `${icon} ${name}` : name;

  const categoryGroups: CategoryGroup[] = (tree as CategoryTreeNode[]).map((root) => ({
    label: withIcon(root.icon, root.name),
    options: [
      { id: root.id, label: withIcon(root.icon, root.name) },
      ...(root.children ?? []).map((ch) => ({
        id: ch.id,
        label: `　└ ${withIcon(ch.icon, ch.name)}`,
      })),
    ],
  }));

  const articles: ArticleRow[] = (result.blogs as BlogRow[]).map((b) => {
    const created = b.createdAt instanceof Date ? b.createdAt : null;
    return {
      id: String(b.id),
      title: b.title,
      description: b.description ?? '',
      author: b.author?.username ?? '未知作者',
      date: created ? ymd(created) ?? '' : '',
      likesCount: b.likesCount ?? 0,
      isFeatured: b.isFeatured ?? false,
      categoryId: b.categoryId,
      categoryPath: b.category ? categoryFullPath(b.category) : null,
    };
  });

  return (
    <>
      <section className="admin-hero">
        <h1>文章栏目管理</h1>
        <p>批量管理文章的栏目分配</p>
      </section>

      <AdminArticlesManager
        articles={articles}
        total={result.total}
        categoryGroups={categoryGroups}
        currentCategoryId={currentCategoryId}
        search={sp.search ?? ''}
        pagination={{
          page: result.page,
          pages: result.pages,
          hasPrev: result.hasPrev,
          hasNext: result.hasNext,
        }}
      />
    </>
  );
}
