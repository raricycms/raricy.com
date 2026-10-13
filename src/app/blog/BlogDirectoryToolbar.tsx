'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { blogDirectoryHref } from '@/lib/blog-directory-links';
import SearchForm from './SearchForm';

interface DirectoryCategory {
  id: number;
  name: string;
  slug: string;
  children: { id: number; name: string; slug: string }[];
}

/** 首屏与吸顶后的面板起点不同，按真实剩余高度限高，分类多时在面板内滚动。 */
function fitCategoryPanel(details: HTMLDetailsElement | null) {
  if (!details?.open) return;
  const panel = details.querySelector<HTMLElement>('.blog-category-panel');
  if (!panel) return;
  const space = Math.max(96, window.innerHeight - panel.getBoundingClientRect().top - 16);
  panel.style.setProperty('--directory-panel-space', `${space}px`);
}

export default function BlogDirectoryToolbar({
  categories,
  currentSlug,
  featured,
  search,
  sort,
  basePath = '/blog',
  canUpload = false,
}: {
  categories: DirectoryCategory[];
  currentSlug: string | null;
  /** 保留三态：'0' 是只看非精选，不能在提交表单时丢掉。 */
  featured: '1' | '0' | null;
  search: string;
  sort: 'created' | 'updated' | null;
  basePath?: '/blog' | '/explore';
  canUpload?: boolean;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [stuck, setStuck] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const searchId = useId();

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    let observer: IntersectionObserver;
    function observe() {
      observer?.disconnect();
      // body 的计算内距与 --navbar-height 同源，含 iOS 安全区；不另猜一个 62px。
      const navbarHeight = parseFloat(getComputedStyle(document.body).paddingTop) || 62;
      observer = new IntersectionObserver(([entry]) => {
        const pinned = !entry.isIntersecting && entry.boundingClientRect.top < navbarHeight;
        // 正在输入时保持同一个字段与焦点，不能因手机收拢而隐藏它。
        if (pinned && document.activeElement === inputRef.current) setSearchOpen(true);
        setStuck(pinned);
      }, { rootMargin: `-${navbarHeight}px 0px 0px 0px`, threshold: 0 });
      observer.observe(sentinel!);
      fitCategoryPanel(detailsRef.current);
    }
    observe();
    setReady(true);
    window.addEventListener('resize', observe);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', observe);
    };
  }, []);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [currentSlug, featured, search]);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    }
    document.addEventListener('pointerdown', closeOutside);
    const fit = () => fitCategoryPanel(detailsRef.current);
    window.addEventListener('scroll', fit, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('scroll', fit);
    };
  }, []);

  const filters = { category: currentSlug, featured, search, sort };
  const href = (updates: Partial<typeof filters>) => blogDirectoryHref(basePath, { ...filters, ...updates });
  let categoryLabel = '当前分类';
  for (const category of categories) {
    if (category.slug === currentSlug) categoryLabel = category.name;
    const child = category.children.find((item) => item.slug === currentSlug);
    if (child) categoryLabel = `${category.name} / ${child.name}`;
  }
  const hasChips = !!currentSlug || !!search || featured === '0';

  function toggleSearch() {
    if (searchOpen) {
      setSearchOpen(false);
      toggleRef.current?.focus();
    } else {
      setSearchOpen(true);
      // 字段一直挂在 DOM 上；只等这一帧的 CSS 展开，再把焦点交给它。
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <>
      <div className="blog-directory-sentinel" ref={sentinelRef} aria-hidden="true" />
      <div
        className={`blog-directory-toolbar${stuck ? ' blog-directory-toolbar--stuck' : ''}${searchOpen ? ' blog-directory-toolbar--search-open' : ''}${hasChips ? ' blog-directory-toolbar--filtered' : ''}`}
        data-ready={ready ? 'true' : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (detailsRef.current?.open) {
            detailsRef.current.open = false;
            detailsRef.current.querySelector('summary')?.focus();
          } else if (stuck && searchOpen && window.matchMedia('(max-width: 767px)').matches) {
            setSearchOpen(false);
            toggleRef.current?.focus();
          }
        }}
      >
        <div className="container">
          <div className="blog-directory-toolbar__surface">
            <div className="blog-directory-toolbar__row">
              <span className="blog-directory-toolbar__title" aria-hidden="true">博客</span>
              <div className="blog-directory-toolbar__search" id={searchId}>
                <SearchForm
                  basePath={basePath}
                  currentSlug={currentSlug}
                  featured={featured}
                  search={search}
                  sort={sort}
                  inputRef={inputRef}
                />
              </div>
              <button
                type="button"
                className="blog-directory-search-toggle"
                ref={toggleRef}
                aria-label={searchOpen ? '收起搜索与筛选' : '展开搜索与筛选'}
                aria-expanded={searchOpen}
                aria-controls={searchId}
                onClick={toggleSearch}
              >
                <Search size={20} aria-hidden="true" />
              </button>
              {canUpload && (
                <Link href="/blog/upload" className="blog-directory-create" aria-label="创建博客">
                  <Plus size={20} aria-hidden="true" />
                  <span>创建</span>
                </Link>
              )}
            </div>
            <div className="blog-directory-toolbar__filters">
              <details className="blog-category-filter" ref={detailsRef} onToggle={(event) => fitCategoryPanel(event.currentTarget)}>
                <summary>
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  分类筛选
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="blog-category-panel">
                  <Link className={`blog-category-all${!currentSlug ? ' is-active' : ''}`} href={href({ category: null })}>所有分类</Link>
                  <div className="blog-category-groups">
                    {categories.map((category) => (
                      <div className="blog-category-group" key={category.id}>
                        <Link className={`blog-category-parent${currentSlug === category.slug ? ' is-active' : ''}`} href={href({ category: category.slug })}>
                          {category.name}
                        </Link>
                        {category.children.map((child) => (
                          <Link className={`blog-category-option${currentSlug === child.slug ? ' is-active' : ''}`} href={href({ category: child.slug })} key={child.id}>
                            {child.name}
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </details>
              {hasChips && (
                <div className="blog-directory-chips" aria-label="当前筛选条件">
                  {currentSlug && <Link href={href({ category: null })} className="blog-directory-chip" aria-label={`移除分类筛选：${categoryLabel}`} title={categoryLabel}><span>{categoryLabel}</span><X size={14} aria-hidden="true" /></Link>}
                  {search && <Link href={href({ search: '' })} className="blog-directory-chip" aria-label={`清除搜索：${search}`} title={search}><span>{search}</span><X size={14} aria-hidden="true" /></Link>}
                  {featured === '0' && <Link href={href({ featured: null })} className="blog-directory-chip" aria-label="移除非精选筛选"><span>非精选</span><X size={14} aria-hidden="true" /></Link>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
