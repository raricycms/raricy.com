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

// 文章栏目管理：逐字对齐 Flask blog/manage_articles.html（批量管理文章的栏目分配）。
export default async function AdminBlogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const currentCategoryId = sp.category ?? '';
  const categoryId =
    currentCategoryId === '' ? null : Number.isNaN(parseInt(currentCategoryId, 10)) ? null : parseInt(currentCategoryId, 10);

  const [result, tree] = await Promise.all([
    listAdminBlogs({
      page: parseInt(sp.page || '1', 10),
      categoryId,
      search: sp.search ?? null,
      status: 'active', // 与 Flask 一致：文章栏目管理只列未删除文章
    }),
    listCategoriesTree(),
  ]);

  // 层级下拉分组，逐字对齐 Flask render_category_options：
  //   每个一级栏目 → 一个 <optgroup label="图标 名称">，
  //   组内首项为父栏目自身「图标 名称」，其后子栏目「　└ 图标 名称」。
  const withIcon = (icon: string, name: string) => (icon ? `${icon} ${name}` : name);
  const categoryGroups: CategoryGroup[] = tree.map((root) => ({
    label: withIcon(root.icon, root.name),
    options: [
      { id: root.id, label: withIcon(root.icon, root.name) },
      ...(root.children ?? []).map((ch) => ({
        id: ch.id,
        label: `　└ ${withIcon(ch.icon, ch.name)}`,
      })),
    ],
  }));

  const articles: ArticleRow[] = result.blogs.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description ?? '',
    author: b.author?.username ?? '未知作者',
    date: ymd(b.createdAt) ?? '',
    likesCount: b.likesCount ?? 0,
    isFeatured: b.isFeatured ?? false,
    categoryId: b.categoryId,
    categoryPath: b.category ? categoryFullPath(b.category) : null,
  }));

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
