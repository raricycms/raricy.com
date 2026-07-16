'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// 分类侧栏（对齐 menu.html 的 aside.sidebar + extra_js 折叠交互）。
// 服务端把分类数据作为 props 传入，交互（折叠/展开、≤820px 自动折叠）在客户端完成。
interface SidebarChild {
  id: number;
  name: string;
  slug: string;
}

interface SidebarCategory {
  id: number;
  name: string;
  slug: string;
  icon: string | null;
  children: SidebarChild[];
}

export default function BlogSidebar({
  categories,
  currentSlug,
  featured,
}: {
  categories: SidebarCategory[];
  currentSlug: string | null;
  featured: boolean;
}) {
  // 主分类列表是否折叠（点击「分类」标题切换）
  const [mainCollapsed, setMainCollapsed] = useState(false);
  // 已折叠的二级列表（对应 .sub-category-list.collapsed）
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(new Set());
  // 已折叠的可折叠父级链接（对应 .category-link.collapsible.collapsed）
  const [collapsedLinks, setCollapsedLinks] = useState<Set<number>>(new Set());

  // 挂载与窗口尺寸变化时执行折叠初始化，复刻 menu.html 的 initializeCollapse。
  useEffect(() => {
    const parentIds = categories.filter((c) => c.children.length > 0).map((c) => c.id);

    function initializeCollapse() {
      const isMobile = window.innerWidth <= 820;
      if (isMobile) {
        // 移动端：主列表、二级列表、可折叠链接一律折叠
        setMainCollapsed(true);
        setCollapsedSubs(new Set(parentIds));
        setCollapsedLinks(new Set(parentIds));
      } else {
        // 桌面端：仅展开二级列表（与原逻辑一致，不改动主列表/链接状态）
        setCollapsedSubs(new Set());
      }
    }

    initializeCollapse();

    let timer: ReturnType<typeof setTimeout> | undefined;
    function onResize() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(initializeCollapse, 100);
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, [categories]);

  function toggleMainCategories() {
    setMainCollapsed((v) => !v);
  }

  function toggleCategory(id: number) {
    setCollapsedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCollapsedLinks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <h3 className="sidebar-title" onClick={toggleMainCategories}>
        分类
      </h3>
      <ul
        className={`category-list${mainCollapsed ? ' collapsed' : ''}`}
        id="mainCategoryList"
      >
        <li className="category-item">
          <Link href="/blog" className={`category-link ${!currentSlug && !featured ? 'active' : ''}`}>
            <div className="category-content">
              <span>全部文章</span>
            </div>
          </Link>
        </li>
        <li className="category-item">
          <Link href="/blog?featured=1" className={`category-link ${featured ? 'active' : ''}`}>
            <div className="category-content">
              <span>精选</span>
            </div>
          </Link>
        </li>
        {categories.map((category) =>
          category.children.length > 0 ? (
            <li key={category.id} className="category-item has-children">
              <div
                className={`category-link collapsible${collapsedLinks.has(category.id) ? ' collapsed' : ''}`}
                onClick={() => toggleCategory(category.id)}
              >
                <div className="category-content">
                  {category.icon && <span className="category-icon">{category.icon}</span>}
                  <span>{category.name}</span>
                </div>
              </div>
              <ul
                className={`sub-category-list${collapsedSubs.has(category.id) ? ' collapsed' : ''}`}
                id={`category-${category.id}`}
              >
                <li className="category-item">
                  <Link
                    href={`/blog?category=${category.slug}`}
                    className={`sub-category-link ${currentSlug === category.slug ? 'active' : ''}`}
                  >
                    <span>全部</span>
                  </Link>
                </li>
                {category.children.map((child) => (
                  <li key={child.id} className="category-item">
                    <Link
                      href={`/blog?category=${child.slug}`}
                      className={`sub-category-link ${currentSlug === child.slug ? 'active' : ''}`}
                    >
                      <span>{child.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ) : (
            <li key={category.id} className="category-item">
              <Link
                href={`/blog?category=${category.slug}`}
                className={`category-link ${currentSlug === category.slug ? 'active' : ''}`}
              >
                <div className="category-content">
                  {category.icon && <span className="category-icon">{category.icon}</span>}
                  <span>{category.name}</span>
                </div>
              </Link>
            </li>
          )
        )}
      </ul>
    </aside>
  );
}
