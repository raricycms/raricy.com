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
          { href: '/admin', label: '管理概览', icon: '📊', exact: true },
          { href: '/admin/blogs', label: '文章管理', icon: '📝' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user)
      ? ([{ href: '/admin/users', label: '用户管理', icon: '👥' }] as AdminNavItem[])
      : []),
    ...(isOwner(user)
      ? ([
          { href: '/admin/broadcast', label: '通知发送', icon: '📢' },
          { href: '/admin/appeals', label: '申诉管理', icon: '⚖️' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user)
      ? ([{ href: '/audit', label: '操作日志', icon: '📋' }] as AdminNavItem[])
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