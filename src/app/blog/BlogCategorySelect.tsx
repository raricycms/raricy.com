'use client';

// 博客目录的栏目下拉：站内 /blog、对外 /explore 与文章管理（/admin/blogs）共用。
//
// 组件只负责「展示栏目树 + 把选中的筛选值写进 URL」，值的含义由调用方定：
// 两个目录页用栏目 slug，文章管理用栏目 id（它按 id 筛选）。选中后删掉
// page / category / featured 再写 category，其余查询参数（搜索词、scope……）原样保留。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

export interface BlogCategoryChild {
  /** 筛选值：目录页是 slug，文章管理是 id 的字符串形式。 */
  value: string;
  name: string;
}

export interface BlogCategoryOption extends BlogCategoryChild {
  children: BlogCategoryChild[];
}

/** 栏目树之前追加的固定选项（文章管理用它放「未分类」）。 */
export interface BlogCategoryExtraOption {
  value: string;
  label: string;
}

export default function BlogCategorySelect({ categories, currentValue, featured, basePath = '/blog', showFeatured = true, extraOptions = [] }: {
  categories: BlogCategoryOption[];
  /** 当前筛选值；null 表示「全部栏目」。 */
  currentValue: string | null;
  featured?: string;
  /** 提交到哪个列表页。`/explore`（对外公开列表）与 `/admin/blogs` 复用本组件，传它自己的路径。 */
  basePath?: string;
  /** 是否提供「精选文章」。精选是站内的编辑口径，对外列表与文章管理不提供。 */
  showFeatured?: boolean;
  /** 追加在栏目树之前的固定选项。 */
  extraOptions?: BlogCategoryExtraOption[];
}) {
  const [open, setOpen] = useState(false);
  // 首帧服务端渲染只能给出 `--category-closed-width` 的 120px 兜底值，水合后
  // useLayoutEffect 才量出真实文字宽度。若宽度过渡从首帧就开着，那次「120px → 实际
  // 宽度」会以 420ms 的缩短动画演一遍 —— 页面刚进来时按钮会莫名缩一下。
  // 所以过渡只在用户真正操作过之后开启（`.is-ready`），首次测量是无动画的。
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(
    categories.filter((c) => c.value === currentValue || c.children.some((child) => child.value === currentValue)).map((c) => c.value)
  ));
  const host = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const params = useSearchParams();
  const selectedLabel = categories.flatMap((c) => [c, ...c.children]).find((c) => c.value === currentValue)?.name
    ?? extraOptions.find((option) => option.value === currentValue)?.label;
  const label = selectedLabel
    ?? (currentValue ? '所选栏目' : featured === '1' ? '精选文章' : featured === '0' ? '非精选文章' : '全部栏目');

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

  function choose(value: string | null, nextFeatured?: string) {
    const p = new URLSearchParams(params.toString());
    p.delete('page');
    p.delete('category');
    p.delete('featured');
    if (value) p.set('category', value);
    if (nextFeatured) p.set('featured', nextFeatured);
    setOpen(false);
    toggle.current?.focus();
    router.push(p.size ? `${basePath}?${p}` : basePath, { scroll: false });
  }

  return (
    <div
      ref={host}
      className={`blog-category-select${open ? ' is-open' : ''}${ready ? ' is-ready' : ''}`}
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
          onClick={() => {
            setReady(true);
            setOpen((value) => !value);
          }}
        >
          <span>{label}</span><ChevronDown aria-hidden="true" />
        </button>
        <div className="blog-category-select__panel" id="blog-category-options" inert={!open}>
          <div className="blog-category-select__clip">
            <div className="blog-category-select__options" aria-label="栏目选择">
              <button type="button" className={`blog-category-select__option${!currentValue && !featured ? ' is-active' : ''}`} onClick={() => choose(null)}><span>全部栏目</span></button>
              {showFeatured && (
                <button type="button" className={`blog-category-select__option${featured === '1' && !currentValue ? ' is-active' : ''}`} onClick={() => choose(null, '1')}><span>精选文章</span></button>
              )}
              {extraOptions.map((option) => (
                <button key={option.value} type="button" className={`blog-category-select__option${currentValue === option.value ? ' is-active' : ''}`} onClick={() => choose(option.value)}><span>{option.label}</span></button>
              ))}
              {categories.map((category) => (
                <div key={category.value}>
                  <div className={`blog-category-select__parent${currentValue === category.value ? ' is-active' : ''}`}>
                    <button type="button" className="blog-category-select__option" onClick={() => choose(category.value)}><span>{category.name}</span></button>
                    {category.children.length > 0 && (
                      <button
                        type="button"
                        className="blog-category-select__expand"
                        aria-label={`${expanded.has(category.value) ? '收起' : '展开'}${category.name}的二级栏目`}
                        aria-expanded={expanded.has(category.value)}
                        aria-controls={`blog-category-children-${category.value}`}
                        onClick={() => setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(category.value)) next.delete(category.value);
                          else next.add(category.value);
                          return next;
                        })}
                      ><ChevronDown aria-hidden="true" /></button>
                    )}
                  </div>
                  {category.children.length > 0 && (
                    <div className={`blog-category-select__children${expanded.has(category.value) ? ' is-expanded' : ''}`} id={`blog-category-children-${category.value}`} inert={!open || !expanded.has(category.value)}>
                      <div className="blog-category-select__clip">
                        {category.children.map((child) => (
                          <button key={child.value} type="button" className={`blog-category-select__option blog-category-select__option--child${currentValue === child.value ? ' is-active' : ''}`} onClick={() => choose(child.value)}><span>{child.name}</span></button>
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
