import { listCategoriesTree } from '@/lib/admin-category-service';
import AdminCategoryEditor from '@/app/components/AdminCategoryEditor';

export const dynamic = 'force-dynamic';

export default async function AdminCategoriesPage() {
  const categories = await listCategoriesTree();

  // 一级栏目供“父栏目”下拉使用（带图标，对齐 Flask render_category_options 样式）
  const parents = categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon }));

  return (
    <>
      <section className="admin-hero">
        <h1>栏目管理</h1>
        <p>管理二级分类层级、启用状态与发文规则。删除前需清空该栏目下的文章与子栏目。</p>
      </section>

      <div className="admin-container">
        <AdminCategoryEditor initialCategories={categories} initialParents={parents} />
      </div>
    </>
  );
}
