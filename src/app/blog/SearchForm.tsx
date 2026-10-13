'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

// 博客搜索表单 — 搜索组的一套类名（search-form / search-field / search-input）
// 空搜索时拦截，去掉 search 参数并保留其他筛选。
export default function SearchForm({
  currentSlug,
  featured,
  search,
  clearHref,
  sort,
  basePath = '/blog',
}: {
  currentSlug: string | null;
  featured: boolean;
  search: string;
  clearHref: string;
  /** URL 里显式合法的 sort，非空时随搜索请求带回，保住已选的排序 */
  sort: string | null;
  /**
   * 表单提交到哪个列表页（`action` 与空搜索时的回退跳转都用它）。
   * `/explore`（对外公开列表）复用本组件，传它自己的路径；默认 `/blog`。
   *
   * ⚠️ 两处都要用 basePath：只改 `action` 漏改 `router.push` 的后果是
   * 「清空搜索框回车」把站外访客**甩到 core+ 的 /blog 上**（跳登录页），
   * 而带词搜索却正常 —— 一个只在清空时才现形、且看起来像「偶发」的 bug。
   */
  basePath?: string;
}) {
  const router = useRouter();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const input = e.currentTarget.querySelector<HTMLInputElement>('.search-input');
    if (input && input.value.trim() === '') {
      e.preventDefault();
      const params = new URLSearchParams();
      if (currentSlug) params.set('category', currentSlug);
      if (featured) params.set('featured', '1');
      if (sort) params.set('sort', sort);
      const s = params.toString();
      router.push(s ? `${basePath}?${s}` : basePath);
    }
  }

  return (
    <form
      method="GET"
      action={basePath}
      className="search-form"
      onSubmit={onSubmit}
    >
      {currentSlug && <input type="hidden" name="category" value={currentSlug} />}
      {featured && <input type="hidden" name="featured" value="1" />}
      {sort && <input type="hidden" name="sort" value={sort} />}
      {/* 输入框与按钮同一个定位上下文：按钮绝对定位嵌在胶囊内部最右侧 */}
      <div className="search-field">
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="搜索标题、作者、简介、正文..."
          className="search-input"
        />
        <button type="submit" className="search-btn">
          搜索
        </button>
      </div>
      {search && (
        <Link href={clearHref} className="search-clear-btn">
          清除
        </Link>
      )}
    </form>
  );
}