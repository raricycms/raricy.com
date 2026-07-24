'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AdminNavItem {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
}

// 管理侧边栏导航 — Flask `admin_base.html` 样式
// active 高亮：精确 vs 前缀匹配由 item.exact 决定。
export default function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();

  const isActive = (item: AdminNavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <nav className="admin-sidebar__nav">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`admin-sidebar__item${
            isActive(item) ? ' admin-sidebar__item--active' : ''
          }`}
        >
          <span className="admin-sidebar__icon" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </Link>
      ))}
      <div className="admin-sidebar__divider"></div>
      <Link href="/" className="admin-sidebar__item">
        <span className="admin-sidebar__icon" aria-hidden="true">←</span>
        <span>返回网站</span>
      </Link>
    </nav>
  );
}