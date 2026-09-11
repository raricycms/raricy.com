'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpenText } from 'lucide-react';

type BlogRow = {
  id: string;
  title: string;
  description: string | null;
  author: string | null;
  updated_at: string | null;
};

const PER_PAGE = 20;

// 「引用博客」选择弹窗：按更新时间倒序 + 标题/简介/作者搜索 + 分页。
// 数据源是公开的 GET /api/blogs（sort=updated&search=&per_page=&page=）。
export default function QuoteBlogModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (b: { id: string; title: string; description: string | null; author: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const [blogs, setBlogs] = useState<BlogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function load(q: string, p: number) {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        sort: 'updated',
        per_page: String(PER_PAGE),
        page: String(p),
      });
      const trimmed = q.trim();
      if (trimmed) qs.set('search', trimmed);
      const res = await fetch(`/api/blogs?${qs.toString()}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (data.code === 200 && Array.isArray(data.blogs)) {
        setBlogs(data.blogs as BlogRow[]);
        setPage(p);
        setPages(Math.max(1, Number(data.pagination?.pages) || 1));
      }
    } catch {
      /* 忽略：保留旧列表 */
    } finally {
      setLoading(false);
    }
  }

  // 输入防抖搜索；条件变化回第 1 页
  useEffect(() => {
    const t = setTimeout(() => void load(query, 1), 200);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="modal-overlay show" onClick={() => onClose()}>
      <div className="modal-dialog chat-blog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">引用博客</h3>
            <button type="button" className="chat-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="modal-body">
            <input
              ref={inputRef}
              type="search"
              className="form-control chat-new-search"
              placeholder="搜索标题 / 简介 / 作者…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="chat-blog-list">
              {loading ? (
                <div className="chat-new-empty">加载中…</div>
              ) : blogs.length === 0 ? (
                <div className="chat-new-empty">没有匹配的博客</div>
              ) : (
                blogs.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className="chat-blog-item"
                    onClick={() =>
                      onPick({
                        id: b.id,
                        title: b.title,
                        description: b.description ?? null,
                        author: b.author ?? null,
                      })
                    }
                  >
                    <span className="chat-blog-item__icon" aria-hidden="true">
                      <BookOpenText />
                    </span>
                    <span className="chat-blog-item__main">
                      <span className="chat-blog-item__title">{b.title}</span>
                      <span className="chat-blog-item__meta">
                        {b.author ? `@${b.author}` : '匿名'}
                        {b.updated_at ? ` · 更新于 ${b.updated_at}` : ''}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="chat-pager">
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page <= 1}
                onClick={() => void load(query, page - 1)}
              >
                上一页
              </button>
              <span className="chat-pager__info">
                第 {page} 页 / 共 {pages} 页
              </span>
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page >= pages}
                onClick={() => void load(query, page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
