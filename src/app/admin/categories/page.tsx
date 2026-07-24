import { listCategoriesTree } from '@/lib/admin-category-service';
import AdminCategoryEditor from '@/app/components/AdminCategoryEditor';

export const dynamic = 'force-dynamic';

type CategoryRow = {
  id: number;
  name: string;
  slug: string;
  description: string;
  parent_id: number | null;
  sort_order: number;
  is_active: boolean;
  icon: string;
  exclude_from_all: boolean;
  admin_only_posting: boolean;
  notify_admin_on_post: boolean;
  level: number;
  blog_count: number;
  child_count: number;
  children?: CategoryRow[];
};

// 栏目管理 — Fluent Design
export default async function AdminCategoriesPage() {
  const categories = (await listCategoriesTree()) as CategoryRow[];
  const parents = categories.map((c: CategoryRow) => ({
    id: c.id,
    name: c.name,
    icon: c.icon ?? null,
  }));

  return (
    <>
      <section className="admin-hero">
        <h1>栏目管理</h1>
        <p>
          管理二级分类层级、启用状态与发文规则。删除前需清空该栏目下的文章与子栏目。
        </p>
      </section>

      <div className="admin-container">
        <AdminCategoryEditor initialCategories={categories} initialParents={parents} />
      </div>
    </>
  );
}
