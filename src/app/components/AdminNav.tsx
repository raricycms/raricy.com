'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  BarChart3,
  ClipboardList,
  FilePen,
  FolderOpen,
  Megaphone,
  Scale,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface AdminNavItem {
  href: string;
  label: string;
  /** 图标 token（服务端数据 → 本地映射渲染，避免跨 RSC 边界传组件） */
  icon: string;
  exact?: boolean;
}

// 图标 token → lucide 组件映射（AdminShell.tsx 中的 icon 字段用同名 token）
const NAV_ICONS: Record<string, LucideIcon> = {
  chart: BarChart3,
  doc: FilePen,
  users: Users,
  megaphone: Megaphone,
  folder: FolderOpen,
  scale: Scale,
  list: ClipboardList,
};

// 管理侧边栏导航 — Flask `admin_base.html` 样式
// active 高亮：精确 vs 前缀匹配由 item.exact 决定。
export default function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();

  const isActive = (item: AdminNavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <nav className="admin-sidebar__nav">
      {items.map((item) => {
        const Icon = NAV_ICONS[item.icon];
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`admin-sidebar__item${
              isActive(item) ? ' admin-sidebar__item--active' : ''
            }`}
          >
            <span className="admin-sidebar__icon" aria-hidden="true">
              {Icon ? <Icon /> : null}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
      <div className="admin-sidebar__divider"></div>
      <Link href="/" className="admin-sidebar__item">
        <span className="admin-sidebar__icon" aria-hidden="true">
          <ArrowLeft />
        </span>
        <span>返回网站</span>
      </Link>
    </nav>
  );
}