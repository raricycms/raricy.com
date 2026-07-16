'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// 管理侧边栏导航（对齐 Flask admin_base.html 的 admin-sidebar__nav）。
// 仅负责 active 高亮，需要 usePathname，故拆为客户端组件；数据仍由 layout 提供。
export default function AdminNav({ items }: { items: Array<[string, string]> }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);

  return (
    <nav className="admin-sidebar__nav">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={`admin-sidebar__item${isActive(href) ? ' admin-sidebar__item--active' : ''}`}
        >
          {label}
        </Link>
      ))}
      <div className="admin-sidebar__divider"></div>
      <Link href="/" className="admin-sidebar__item">
        返回网站
      </Link>
    </nav>
  );
}
