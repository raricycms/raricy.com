'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// 分类侧栏 — Flask BEM（与 blog/menu.html 一一对应）
// 服务端注入 props；客户端仅做折叠交互（≤820px 自动收拢）。
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
  const [mainCollapsed, setMainCollapsed] = useState(false);
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(new Set());
  const [collapsedLinks, setCollapsedLinks] = useState<Set<number>>(new Set());

  useEffect(() => {
    const parentIds = categories.filter((c) => c.children.length > 0).map((c) => c.id);

    function initializeCollapse() {
      const isMobile = window.innerWidth <= 820;
      if (isMobile) {
        setMainCollapsed(true);
        setCollapsedSubs(new Set(parentIds));
        setCollapsedLinks(new Set(parentIds));
      } else {
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
      <h3
        className={`sidebar-title${mainCollapsed ? ' collapsed' : ''}`}
        onClick={toggleMainCategories}
      >
        <span>分类</span>
        <span className="toggle-icon">▼</span>
      </h3>
      <ul
        className={`category-list${mainCollapsed ? ' collapsed' : ''}`}
        id="mainCategoryList"
      >
        <li className="category-item">
          <Link
            href="/blog"
            className={`category-link${!currentSlug && !featured ? ' active' : ''}`}
          >
            <div className="category-content">
              <span className="icon">🏠</span>
              <span>全部文章</span>
            </div>
          </Link>
        </li>
        <li className="category-item">
          <Link
            href="/blog?featured=1"
            className={`category-link${featured ? ' active' : ''}`}
          >
            <div className="category-content">
              <span className="icon">🌟</span>
              <span>精选</span>
            </div>
          </Link>
        </li>
        {categories.map((category) =>
          category.children.length > 0 ? (
            <li key={category.id} className={`category-item has-children`}>
              <div
                className={`category-link collapsible${collapsedLinks.has(category.id) ? ' collapsed' : ''}`}
                onClick={() => toggleCategory(category.id)}
                role="button"
                aria-expanded={!collapsedLinks.has(category.id)}
              >
                <div className="category-content">
                  {category.icon && <span className="icon" aria-hidden="true">{category.icon}</span>}
                  <span>{category.name}</span>
                </div>
                <span className="category-toggle">▼</span>
              </div>
              <ul
                className={`sub-category-list${collapsedSubs.has(category.id) ? ' collapsed' : ''}`}
                id={`category-${category.id}`}
              >
                <li className="category-item">
                  <Link
                    href={`/blog?category=${category.slug}`}
                    className={`sub-category-link${currentSlug === category.slug ? ' active' : ''}`}
                  >
                    {category.icon && <span className="icon" aria-hidden="true">{category.icon}</span>}
                    <span>全部</span>
                  </Link>
                </li>
                {category.children.map((child) => (
                  <li key={child.id} className="category-item">
                    <Link
                      href={`/blog?category=${child.slug}`}
                      className={`sub-category-link${currentSlug === child.slug ? ' active' : ''}`}
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
                className={`category-link${currentSlug === category.slug ? ' active' : ''}`}
              >
                <div className="category-content">
                  {category.icon && <span className="icon" aria-hidden="true">{category.icon}</span>}
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