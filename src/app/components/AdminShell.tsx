import { isOwner, hasAdminRights, isCoreUser, type SafeUser } from '@/lib/auth';
import AdminNav, { type AdminNavItem } from '@/app/components/AdminNav';

// 管理端母版 — Flask `admin_base.html` 样式（admin-layout + admin-sidebar + admin-content）
//
// 按角色逐项门控侧栏条目：
//   管理概览 / 文章管理 → hasAdminRights
//   用户管理             → isCoreUser
//   通知发送 + 申诉管理   → isOwner
//   操作日志             → isCoreUser
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
          { href: '/admin', label: '管理概览', icon: 'chart', exact: true },
          { href: '/admin/blogs', label: '文章管理', icon: 'doc' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user)
      ? ([{ href: '/admin/users', label: '用户管理', icon: 'users' }] as AdminNavItem[])
      : []),
    ...(isOwner(user)
      ? ([
          { href: '/admin/broadcast', label: '通知发送', icon: 'megaphone' },
          { href: '/admin/categories', label: '栏目管理', icon: 'folder' },
          { href: '/admin/appeals', label: '申诉管理', icon: 'scale' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user)
      ? ([{ href: '/audit', label: '操作日志', icon: 'list' }] as AdminNavItem[])
      : []),
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