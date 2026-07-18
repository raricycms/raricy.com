'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

// 搜索表单（对齐 menu.html 的 .search-form + extra_js 空搜索处理）。
// 非空搜索走原生 GET 提交；空搜索则拦截并去掉空的 search 参数，仅保留 category/featured。
export default function SearchForm({
  currentSlug,
  featured,
  search,
  clearHref,
}: {
  currentSlug: string | null;
  featured: boolean;
  search: string;
  clearHref: string;
}) {
  const router = useRouter();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const input = e.currentTarget.querySelector<HTMLInputElement>('.search-input');
    if (input && input.value.trim() === '') {
      e.preventDefault();
      const params = new URLSearchParams();
      if (currentSlug) params.set('category', currentSlug);
      if (featured) params.set('featured', '1');
      const s = params.toString();
      router.push(s ? `/blog?${s}` : '/blog');
    }
  }

  return (
    <form method="GET" action="/blog" className="search-form" onSubmit={onSubmit}>
      {currentSlug && <input type="hidden" name="category" value={currentSlug} />}
      {featured && <input type="hidden" name="featured" value="1" />}
      <input
        type="search"
        name="search"
        defaultValue={search}
        placeholder="搜索标题、作者、简介…"
        className="search-input"
      />
      <button type="submit" className="search-btn">
        搜索
      </button>
      {search && (
        <Link href={clearHref} className="search-clear-btn">
          清除
        </Link>
      )}
    </form>
  );
}
