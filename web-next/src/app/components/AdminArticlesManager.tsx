'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminArticlesManager — 文章栏目管理页的交互层（对齐 Flask manage_articles.html）：
//   • 复选框选择 + 已选择计数 + 全选当前页 / 清空选择
//   • 批量操作栏：批量更新栏目 / 批量设为精选
//   • 每行动作簇委托给 <AdminBlogActions>（栏目下拉 + 查看 + 设为精选）
// Flask 用独立 batch API；Next 没有批量端点，这里对所选文章逐条 PATCH，
// 可见结果等价（toast + 列表刷新）。筛选/搜索用原生 GET 表单交给服务端重渲染。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AdminBlogActions, { type CategoryGroup } from './AdminBlogActions';

export interface ArticleRow {
  id: string;
  title: string;
  description: string;
  author: string;
  date: string;
  likesCount: number;
  isFeatured: boolean;
  categoryId: number | null;
  categoryPath: string | null;
}

interface Pagination {
  page: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
}

interface Props {
  articles: ArticleRow[];
  total: number;
  categoryGroups: CategoryGroup[];
  currentCategoryId: string; // 原样回填筛选下拉（'' / '-1' / 数字）
  search: string;
  pagination: Pagination;
}

const toast = (msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
};

// 分页页码窗口（window-of-3），对齐 Flask _macros.html / management.html：
// 始终显示首尾页，当前页 ±3 的范围显示页码，其余折叠为 …（null 表示省略号）。
function pageWindow(page: number, pages: number, window = 3): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || (p >= page - window && p <= page + window)) {
      out.push(p);
    } else if (p === page - window - 1 || p === page + window + 1) {
      out.push(null);
    }
  }
  return out;
}

export default function AdminArticlesManager({
  articles,
  total,
  categoryGroups,
  currentCategoryId,
  search,
  pagination,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchCategory, setBatchCategory] = useState('');
  const [busy, setBusy] = useState(false);

  const pageIds = articles.map((a) => a.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set([...selected, ...pageIds]));
  const clearSelection = () => setSelected(new Set());

  async function patchOne(id: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/admin/blogs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.code === 200;
  }

  async function batchUpdate() {
    if (selectedOnPage.length === 0) {
      toast('请选择要更新的文章', 'warning');
      return;
    }
    setBusy(true);
    try {
      const categoryId = batchCategory === '' ? null : Number(batchCategory);
      let ok = 0;
      for (const id of selectedOnPage) {
        if (await patchOne(id, { categoryId })) ok += 1;
      }
      toast(`已更新 ${ok} 篇文章的栏目`, 'success');
      clearSelection();
      router.refresh();
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function batchFeatured() {
    if (selectedOnPage.length === 0) {
      toast('请选择要更新的文章', 'warning');
      return;
    }
    setBusy(true);
    try {
      let ok = 0;
      for (const id of selectedOnPage) {
        if (await patchOne(id, { isFeatured: true })) ok += 1;
      }
      toast(`已将 ${ok} 篇文章设为精选`, 'success');
      clearSelection();
      router.refresh();
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (currentCategoryId) p.set('category', currentCategoryId);
    if (search) p.set('search', search);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  return (
    <div className="admin-container">
      <div className="admin-message-container" id="message-container"></div>

      {/* 统计信息 */}
      <div className="admin-stats-bar">
        <div className="admin-stat-item">
          <div className="admin-stat-item__number">{total}</div>
          <div className="admin-stat-item__label">总文章数</div>
        </div>
        <div className="admin-stat-item">
          <div className="admin-stat-item__number">{selectedOnPage.length}</div>
          <div className="admin-stat-item__label">已选择</div>
        </div>
      </div>

      {/* 筛选和搜索栏 */}
      <div className="admin-filter-bar">
        <form method="GET" id="filterForm">
          <div className="row align-items-end">
            <div className="col-md-4">
              <label className="form-label">栏目筛选</label>
              <select
                className="form-select"
                name="category"
                defaultValue={currentCategoryId}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
              >
                <option value="">全部栏目</option>
                <option value="-1">未分类</option>
                {categoryGroups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">搜索标题</label>
              <input
                type="text"
                className="form-control"
                name="search"
                defaultValue={search}
                placeholder="输入文章标题关键词..."
              />
            </div>
            <div className="col-md-2">
              <button type="submit" className="btn btn-primary w-100">
                搜索
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* 批量操作栏 */}
      <div className="admin-batch-actions" id="batchActions">
        <div className="row align-items-center">
          <div className="col-md-6">
            <strong>批量操作</strong> - 已选择 <span>{selectedOnPage.length}</span> 篇文章
          </div>
          <div className="col-md-4">
            <select
              className="form-select"
              value={batchCategory}
              onChange={(e) => setBatchCategory(e.target.value)}
              disabled={busy}
            >
              <option value="">选择目标栏目</option>
              <option value="">设为未分类</option>
              {categoryGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="col-md-2 d-flex gap-2">
            <button className="btn btn-primary w-100" disabled={busy} onClick={batchUpdate}>
              批量更新
            </button>
            <button
              className="btn btn-outline-secondary w-100"
              disabled={busy}
              onClick={batchFeatured}
            >
              批量设为精选
            </button>
          </div>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <button className="btn btn-outline-primary" disabled={busy} onClick={selectAll}>
            全选当前页
          </button>
          <button className="btn btn-outline-secondary" disabled={busy} onClick={clearSelection}>
            清空选择
          </button>
        </div>
      </div>

      {/* 文章列表 */}
      <div id="articlesList">
        {articles.map((a) => (
          <div key={a.id} className="article-card" data-article-id={a.id}>
            <div className="article-card__header">
              <div className="article-card__info">
                <div className="d-flex align-items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    className="form-check-input article-checkbox"
                    value={a.id}
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />
                  <div className="article-card__title">{a.title}</div>
                </div>
                <div className="article-card__meta">
                  <span>{a.author}</span>
                  <span>{a.date}</span>
                  <span>
                    <span className="icon icon-heart-fill"></span>
                    {a.likesCount}
                  </span>
                  <span className="mono">ID {a.id.slice(0, 8)}…</span>
                </div>
                <div className="article-card__desc">{a.description}</div>
              </div>
              <div className="article-card__actions">
                <div
                  className={`current-category ${a.categoryPath ? 'is-categorized' : 'is-uncategorized'}`}
                >
                  {a.categoryPath ?? '未分类'}
                </div>
                <div>
                  <span
                    className="featured-flag"
                    style={{ display: a.isFeatured ? 'inline-block' : 'none' }}
                  >
                    精选
                  </span>
                </div>
                <AdminBlogActions
                  blogId={a.id}
                  initialFeatured={a.isFeatured}
                  initialCategoryId={a.categoryId}
                  categoryGroups={categoryGroups}
                />
              </div>
            </div>
          </div>
        ))}

        {articles.length === 0 && (
          <div className="text-center py-5">
            <div className="text-muted">
              <h5 className="mt-3">没有找到文章</h5>
              <p>尝试调整筛选条件或搜索关键词</p>
            </div>
          </div>
        )}
      </div>

      {pagination.pages > 1 && (
        <div className="admin-pagination">
          <nav>
            <ul className="pagination">
              {pagination.hasPrev && (
                <li className="page-item">
                  <Link className="page-link" href={qs(pagination.page - 1)}>
                    上一页
                  </Link>
                </li>
              )}
              {pageWindow(pagination.page, pagination.pages).map((p, i) =>
                p === null ? (
                  <li key={`gap-${i}`} className="page-item disabled">
                    <span className="page-link">…</span>
                  </li>
                ) : (
                  <li key={p} className={`page-item ${p === pagination.page ? 'active' : ''}`}>
                    {p === pagination.page ? (
                      <span className="page-link">{p}</span>
                    ) : (
                      <Link className="page-link" href={qs(p)}>
                        {p}
                      </Link>
                    )}
                  </li>
                )
              )}
              {pagination.hasNext && (
                <li className="page-item">
                  <Link className="page-link" href={qs(pagination.page + 1)}>
                    下一页
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}
