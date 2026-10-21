import { isOwner, hasAdminRights, isCoreUser, type SafeUser } from '@/lib/auth';
import AdminNav, { type AdminNavItem } from '@/app/components/AdminNav';
import { ShieldCheck } from 'lucide-react';

// 管理端母版 — admin-layout / admin-sidebar / admin-content 三块布局
//
// 按角色逐项门控侧栏条目：
//   管理概览 / 文章管理 / 日志检索 → hasAdminRights
//   用户管理                       → isCoreUser
//   通知发送 + 申诉管理             → isOwner
//   操作日志（公示）                → isCoreUser
//
// ⚠️ 「操作日志」与「日志检索」是两件事，别合并：前者是 core+ 都能看的**公示**页
// （只列近 30 天的公开日志），后者是 admin+ 的**运维检索**（含内部日志、无时间窗）。
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
          { href: '/admin/daily-quotes', label: '一言审核', icon: 'doc' },
          { href: '/admin/logs', label: '日志检索', icon: 'list' },
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
          { href: '/admin/oauth', label: 'OAuth 应用', icon: 'key' },
        ] as AdminNavItem[])
      : []),
    ...(isCoreUser(user)
      ? ([{ href: '/audit', label: '操作日志', icon: 'list' }] as AdminNavItem[])
      : []),
  ];

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar__brand">
          <span className="admin-sidebar__brand-mark" aria-hidden="true">
            <ShieldCheck />
          </span>
          <span className="admin-sidebar__brand-text">
            <span className="admin-sidebar__brand-title">管理面板</span>
            <span className="admin-sidebar__brand-sub">Admin Console</span>
          </span>
        </div>
        <AdminNav items={items} />
      </aside>
      {/* ⚠️ 这里不能再写 <main>：根 layout 已经把整页包在 <main> 里，嵌套两个
          <main> 是无效的文档结构（屏幕阅读器会把地标念两遍）。这个位置只需要
          「内容列」语义，用 <div>；page-gutter 用例取的 `main h1` 仍由根 main 兜住。 */}
      <div className="admin-content">{children}</div>
    </div>
  );
}
