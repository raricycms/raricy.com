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
  focus_hidden: boolean;
  level: number;
  blog_count: number;
  child_count: number;
  children?: CategoryRow[];
};

// 栏目管理。
//
// 抬头（AdminPageHeader）与「+ 新建栏目」按钮都住在 AdminCategoryEditor 里 ——
// 那颗按钮要打开同一个组件持有的编辑弹窗，所以抬头只能是客户端组件的一部分；
// 页面本身只负责取数并给出唯一的外层容器（`.admin-container` 的宽度/檐沟已由
// AdminShell 的 `.admin-layout` 统一给，这里不能再套一层）。
// 组件根节点**不许**再挂 `admin-container`：那会双份内缩（同 /admin/oauth 的
// ApplicationRow 卡中卡，见 docs/frontend-styles.md §12）。
export default async function AdminCategoriesPage() {
  const categories = (await listCategoriesTree()) as CategoryRow[];
  const parents = categories.map((c: CategoryRow) => ({
    id: c.id,
    name: c.name,
    icon: c.icon ?? null,
  }));

  return (
    <div className="admin-container">
      <AdminCategoryEditor initialCategories={categories} initialParents={parents} />
    </div>
  );
}
