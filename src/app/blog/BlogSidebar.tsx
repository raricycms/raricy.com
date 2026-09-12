'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronDown, Home, Star } from 'lucide-react';

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
  sort,
}: {
  categories: SidebarCategory[];
  currentSlug: string | null;
  featured: boolean;
  /** URL 里显式合法的 sort（created|updated），非空时回显到侧栏链接，保住已选的排序 */
  sort: string | null;
}) {
  const [mainCollapsed, setMainCollapsed] = useState(false);
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(new Set());
  const [collapsedLinks, setCollapsedLinks] = useState<Set<number>>(new Set());
  /**
   * JS 是否已接管折叠态。
   *
   * 自动折叠发生在下面的 useEffect（水合之后），而 SSR 直出的是展开态 —— 不接管的话
   * 小屏会先画一帧展开的目录，再播放一段折叠动画（用户看到的「一进去是展开的，然后
   * 收起来」）。`_menu.scss` 末尾用 `.js .sidebar:not(.sidebar--ready)` 让水合前就按
   * 折叠渲染，这里挂载时补上 `--ready`：此时折叠态已经算好，两种渲染结果一致，那一帧
   * 没有任何视觉变化。
   */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const parentIds = categories.filter((c) => c.children.length > 0).map((c) => c.id);

    function initializeCollapse() {
      // 与 _menu.scss 的 ≤992px 单列断点对齐：平板（821–992）目录也不再默认展开，
      // 否则「分类 → 第一篇博客」之间横着几百像素的展开列表，纵向利用率太差。
      const isMobile = window.innerWidth <= 992;
      if (isMobile) {
        setMainCollapsed(true);
        setCollapsedSubs(new Set(parentIds));
        setCollapsedLinks(new Set(parentIds));
      } else {
        setCollapsedSubs(new Set());
      }
    }

    initializeCollapse();
    // 与上面同一次提交：折叠态与 --ready 一起落到 DOM，中间不存在「已接管但还没折叠」的帧
    setReady(true);

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

  /** 侧栏链接回显当前排序：追加 sort 参数（首个参数用 ?，已有参数用 &）。 */
  const withSort = (href: string) =>
    sort ? `${href}${href.includes('?') ? '&' : '?'}sort=${sort}` : href;

  return (
    <aside className={`sidebar${ready ? ' sidebar--ready' : ''}`}>
      <h3
        className={`sidebar-title${mainCollapsed ? ' collapsed' : ''}`}
        onClick={toggleMainCategories}
      >
        <span>分类</span>
        <span className="toggle-icon" aria-hidden="true">
          <ChevronDown />
        </span>
      </h3>
      <ul
        className={`category-list${mainCollapsed ? ' collapsed' : ''}`}
        id="mainCategoryList"
      >
        <li className="category-item">
          <Link
            href={withSort('/blog')}
            className={`category-link${!currentSlug && !featured ? ' active' : ''}`}
          >
            <div className="category-content">
              <span className="icon" aria-hidden="true">
                <Home />
              </span>
              <span>全部文章</span>
            </div>
          </Link>
        </li>
        <li className="category-item">
          <Link
            href={withSort('/blog?featured=1')}
            className={`category-link${featured ? ' active' : ''}`}
          >
            <div className="category-content">
              <span className="icon" aria-hidden="true">
                <Star />
              </span>
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
                <span className="category-toggle" aria-hidden="true">
                  <ChevronDown />
                </span>
              </div>
              <ul
                className={`sub-category-list${collapsedSubs.has(category.id) ? ' collapsed' : ''}`}
                id={`category-${category.id}`}
              >
                <li className="category-item">
                  <Link
                    href={withSort(`/blog?category=${category.slug}`)}
                    className={`sub-category-link${currentSlug === category.slug ? ' active' : ''}`}
                  >
                    {category.icon && <span className="icon" aria-hidden="true">{category.icon}</span>}
                    <span>全部</span>
                  </Link>
                </li>
                {category.children.map((child) => (
                  <li key={child.id} className="category-item">
                    <Link
                      href={withSort(`/blog?category=${child.slug}`)}
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
                href={withSort(`/blog?category=${category.slug}`)}
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