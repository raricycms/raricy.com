'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

interface Category {
  id: number;
  name: string;
  slug: string;
  children: { id: number; name: string; slug: string }[];
}

export default function BlogCategorySelect({ categories, currentSlug, featured }: {
  categories: Category[];
  currentSlug: string | null;
  featured?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(
    categories.filter((c) => c.slug === currentSlug || c.children.some((child) => child.slug === currentSlug)).map((c) => c.id)
  ));
  const host = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const params = useSearchParams();
  const selected = categories.flatMap((c) => [c, ...c.children]).find((c) => c.slug === currentSlug);
  const label = selected?.name ?? (currentSlug ? '所选栏目' : featured === '1' ? '精选文章' : featured === '0' ? '非精选文章' : '全部栏目');

  useLayoutEffect(() => {
    const element = host.current!;
    const options = element.querySelector<HTMLDivElement>('.blog-category-select__options')!;
    let active = true;
    function textWidth(span: Element) {
      const text = span as HTMLElement;
      const saved = text.style.cssText;
      text.style.whiteSpace = 'nowrap';
      text.style.width = 'max-content';
      text.style.maxWidth = 'none';
      const range = document.createRange();
      range.selectNodeContents(span);
      const width = range.getBoundingClientRect().width;
      text.style.cssText = saved;
      return width;
    }
    function measure() {
      if (!active) return;
      const button = toggle.current!;
      const buttonStyle = getComputedStyle(button);
      // scrollWidth 会取整，临界宽度会差不到 1px 却触发省略号；按文字的实际小数宽度留余量。
      const closedWidth = Math.ceil(textWidth(button.querySelector('span')!) + parseFloat(buttonStyle.paddingLeft) + parseFloat(buttonStyle.paddingRight) + parseFloat(buttonStyle.columnGap) + 16) + 2;
      const optionsStyle = getComputedStyle(options);
      const outerWidth = parseFloat(optionsStyle.paddingLeft) + parseFloat(optionsStyle.paddingRight) + options.offsetWidth - options.clientWidth;
      let width = closedWidth;
      element.querySelectorAll<HTMLButtonElement>('.blog-category-select__option').forEach((option) => {
        const children = option.closest('.blog-category-select__children');
        if (children && !children.classList.contains('is-expanded')) return;
        const style = getComputedStyle(option);
        const parent = option.parentElement!;
        const arrowWidth = parent.classList.contains('blog-category-select__parent')
          ? (parent.querySelector('.blog-category-select__expand')?.getBoundingClientRect().width ?? 0) + parseFloat(getComputedStyle(parent).paddingRight)
          : 0;
        width = Math.max(width, textWidth(option.querySelector('span')!) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + arrowWidth + outerWidth + 2);
      });
      const narrow = window.matchMedia('(max-width: 992px)').matches;
      const rect = element.getBoundingClientRect();
      // 桌面菜单始终固定右端，向左生长；窄屏则从左端向右展开。
      const available = narrow ? document.documentElement.clientWidth - rect.left - 16 : rect.right - 16;
      element.style.setProperty('--category-closed-width', `${closedWidth}px`);
      element.style.setProperty('--category-open-width', `${Math.ceil(Math.min(width, available))}px`);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(options);
    observer.observe(toggle.current!.querySelector('span')!);
    window.addEventListener('resize', measure);
    void document.fonts.ready.then(measure);
    measure();
    return () => { active = false; observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [categories, expanded, label]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function choose(slug: string | null, nextFeatured?: string) {
    const p = new URLSearchParams(params.toString());
    p.delete('page');
    p.delete('category');
    p.delete('featured');
    if (slug) p.set('category', slug);
    if (nextFeatured) p.set('featured', nextFeatured);
    setOpen(false);
    toggle.current?.focus();
    router.push(p.size ? `/blog?${p}` : '/blog', { scroll: false });
  }

  return (
    <div
      ref={host}
      className={`blog-category-select${open ? ' is-open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="blog-category-select__shell">
        <button
          ref={toggle}
          type="button"
          className="blog-category-select__toggle"
          aria-label={`栏目：${label}`}
          aria-expanded={open}
          aria-controls="blog-category-options"
          onClick={() => setOpen((value) => !value)}
        >
          <span>{label}</span><ChevronDown aria-hidden="true" />
        </button>
        <div className="blog-category-select__panel" id="blog-category-options" inert={!open}>
          <div className="blog-category-select__clip">
            <div className="blog-category-select__options" aria-label="栏目选择">
              <button type="button" className={`blog-category-select__option${!currentSlug && !featured ? ' is-active' : ''}`} onClick={() => choose(null)}><span>全部栏目</span></button>
              <button type="button" className={`blog-category-select__option${featured === '1' && !currentSlug ? ' is-active' : ''}`} onClick={() => choose(null, '1')}><span>精选文章</span></button>
              {categories.map((category) => (
                <div key={category.id}>
                  <div className={`blog-category-select__parent${currentSlug === category.slug ? ' is-active' : ''}`}>
                    <button type="button" className="blog-category-select__option" onClick={() => choose(category.slug)}><span>{category.name}</span></button>
                    {category.children.length > 0 && (
                      <button
                        type="button"
                        className="blog-category-select__expand"
                        aria-label={`${expanded.has(category.id) ? '收起' : '展开'}${category.name}的二级栏目`}
                        aria-expanded={expanded.has(category.id)}
                        aria-controls={`blog-category-children-${category.id}`}
                        onClick={() => setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(category.id)) next.delete(category.id);
                          else next.add(category.id);
                          return next;
                        })}
                      ><ChevronDown aria-hidden="true" /></button>
                    )}
                  </div>
                  {category.children.length > 0 && (
                    <div className={`blog-category-select__children${expanded.has(category.id) ? ' is-expanded' : ''}`} id={`blog-category-children-${category.id}`} inert={!open || !expanded.has(category.id)}>
                      <div className="blog-category-select__clip">
                        {category.children.map((child) => (
                          <button key={child.id} type="button" className={`blog-category-select__option blog-category-select__option--child${currentSlug === child.slug ? ' is-active' : ''}`} onClick={() => choose(child.slug)}><span>{child.name}</span></button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
