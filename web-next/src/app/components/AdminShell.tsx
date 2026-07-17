import { isOwner, hasAdminRights, isCoreUser, type SafeUser } from '@/lib/auth';
import AdminNav, { type AdminNavItem } from '@/app/components/AdminNav';

// 管理端母版（逐字对齐 Flask admin_base.html：固定左侧栏 + 内容区）。
//
// 【为什么抽成组件而不是只用 app/admin/layout.tsx】
// Flask 侧 `auth/admin_action_logs.html`（操作日志 /audit）也是 `{% extends "admin_base.html" %}`
// —— 它带管理侧边栏。而 Next 的 /audit 不在 /admin 路由段下，套不到那个 layout。
// 曾经因此丢了侧边栏：进「操作日志」后管理面板整个消失，且从日志页回不到管理面板。
//
// 【角色门控逐项对齐 admin_base.html】侧栏是**按项**判角色的，不是整体门控：
//   管理概览 / 文章管理  → current_user.has_admin_rights
//   用户管理            → current_user.is_core_user
//   通知发送            → current_user.is_owner
//   操作日志            → current_user.is_core_user
//   返回网站            → 无条件
// 因此 core 用户进 /audit 时**看得到侧边栏**，只是里面只有「用户管理 / 操作日志 / 返回网站」。
// 这也是为什么 /audit 不能直接塞进 hasAdminRights 门控的 admin layout。
export default function AdminShell({
  user,
  children,
}: {
  user: SafeUser;
  children: React.ReactNode;
}) {
  const items: AdminNavItem[] = [
    ...(hasAdminRights(user)
      ? ([
          { href: '/admin', label: '管理概览', icon: '📊', exact: true },
          { href: '/admin/blogs', label: '文章管理', icon: '📝' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user) ? ([{ href: '/admin/users', label: '用户管理', icon: '👥' }] as AdminNavItem[]) : []),
    ...(isOwner(user) ? ([{ href: '/admin/broadcast', label: '通知发送', icon: '📢' }] as AdminNavItem[]) : []),
    ...(isCoreUser(user) ? ([{ href: '/audit', label: '操作日志', icon: '📋' }] as AdminNavItem[]) : []),
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
