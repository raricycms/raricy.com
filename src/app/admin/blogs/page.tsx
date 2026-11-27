import { requireAdmin } from '@/lib/guard';
import { listAdminBlogs } from '@/lib/admin-blog-service';
import { listCategoriesTree } from '@/lib/admin-category-service';
import { categoryFullPath, ymd } from '@/lib/format';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminArticlesManager, { type ArticleRow } from '@/app/components/AdminArticlesManager';
import type { CategoryGroup } from '@/app/components/AdminBlogActions';
import type { BlogCategoryOption } from '@/app/blog/BlogCategorySelect';
import { FilePen } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  category?: string;
  search?: string;
  featured?: string;
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

// 文章栏目管理
//
// 改栏目 / 精选 / 删文章都是管理动作，core 用户看不了 —— 父 layout 已放宽到 core+
// （用户管理要用），这一档由页面自己把住。
export default async function AdminBlogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const currentCategoryId = sp.category ?? '';
  const parsed = parseInt(currentCategoryId, 10);
  const categoryId =
    currentCategoryId === '' || Number.isNaN(parsed) ? null : parsed;
  const featured = sp.featured === '1';

  const [result, tree] = await Promise.all([
    listAdminBlogs({
      page: parseInt(sp.page || '1', 10),
      categoryId,
      search: sp.search ?? null,
      status: 'active',
      // 搜索口径与 /blog 目录一致：标题、简介、作者名与正文（外加精确 id，
      // 方便粘贴完整 id 找回）。管理端要求管理员会话，不走目录页的正文限频。
      searchScope: 'all',
      featured: featured ? true : undefined,
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

  // 筛选下拉与 /blog 目录共用同一个组件；管理端按栏目 id 筛选，所以选项值取 id
  // （目录页取 slug）。图标前缀留在名字里 —— 组件本身不为某个页面渲染图标。
  const categoryOptions: BlogCategoryOption[] = (tree as CategoryTreeNode[]).map((root) => ({
    value: String(root.id),
    name: withIcon(root.icon, root.name),
    children: (root.children ?? []).map((child) => ({
      value: String(child.id),
      name: withIcon(child.icon, child.name),
    })),
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
      <AdminPageHeader
        eyebrow={
          <>
            <FilePen aria-hidden="true" />
            内容管理
          </>
        }
        title="文章栏目管理"
        subtitle="批量调整栏目、设为精选，或单篇查看与编辑"
      />

      <AdminArticlesManager
        articles={articles}
        total={result.total}
        categoryGroups={categoryGroups}
        categoryOptions={categoryOptions}
        currentCategoryId={currentCategoryId}
        search={sp.search ?? ''}
        featured={featured}
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
