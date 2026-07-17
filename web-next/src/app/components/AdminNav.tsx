'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AdminNavItem {
  href: string;
  label: string;
  /** 侧栏 emoji 图标（对齐 admin_base.html 的 admin-sidebar__icon）。 */
  icon: string;
  /** true = 精确匹配才高亮；缺省为前缀匹配。 */
  exact?: boolean;
}

// 管理侧边栏导航（对齐 Flask admin_base.html 的 admin-sidebar__nav）。
// 仅负责 active 高亮，需要 usePathname，故拆为客户端组件；
// 条目与角色门控由 AdminShell 决定（见那里的注释）。
export default function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();

  // 对齐原站：管理概览是 `request.path == '/blog/admin'`（精确匹配），
  // 其余是 `request.path.startswith(...)`（前缀匹配）。
  const isActive = (item: AdminNavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <nav className="admin-sidebar__nav">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`admin-sidebar__item${isActive(item) ? ' admin-sidebar__item--active' : ''}`}
        >
          <span className="admin-sidebar__icon">{item.icon}</span> {item.label}
        </Link>
      ))}
      <div className="admin-sidebar__divider"></div>
      <Link href="/" className="admin-sidebar__item">
        <span className="admin-sidebar__icon">←</span> 返回网站
      </Link>
    </nav>
  );
}
