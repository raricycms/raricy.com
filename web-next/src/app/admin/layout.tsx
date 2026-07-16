import { redirect } from 'next/navigation';
import { getCurrentUser, hasAdminRights, isOwner } from '@/lib/auth';
import AdminNav from '@/app/components/AdminNav';

// 管理端母版：固定左侧栏 + 内容区（逐字对齐 Flask admin_base.html）。
// 统一鉴权：非管理员一律跳登录（避免每个 admin 页面各写一遍）。
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) redirect('/login');
  const owner = isOwner(user);

  // 侧栏项与 Flask admin_base.html 一致：可见文案 / 顺序 / 角色可见性。
  //   管理概览·文章管理（has_admin_rights）→ 用户管理（core）→ 通知发送（owner）→ 操作日志（core）
  //   url_for 映射到可用的 Next 路由：blog.admin→/admin  blog.manage_articles→/admin/blogs
  //   auth.user_management→/admin/users  auth.admin_notifications→/admin/broadcast  audit.public_logs→/audit
  const items: Array<[string, string]> = [
    ['/admin', '管理概览'],
    ['/admin/blogs', '文章管理'],
    ['/admin/users', '用户管理'],
    ...(owner ? ([['/admin/broadcast', '通知发送']] as Array<[string, string]>) : []),
    ['/audit', '操作日志'],
  ];

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar__brand">管理面板</div>
        <AdminNav items={items} />
      </aside>
      <main className="admin-content">{children}</main>
    </div>
  );
}
