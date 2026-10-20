'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminArticlesManager — 文章栏目管理页的交互层：
//   • 行首的圆形勾选点 + 全选本页 / 清空
//   • 选中后从底部浮出批量操作胶囊（更新栏目 / 设为精选）
//   • 每行动作簇委托给 <AdminBlogActions>（栏目下拉 + 查看 / 编辑 / 精选）
// 没有批量更新端点，这里对所选文章逐条 PATCH，可见结果等价（toast + 列表刷新）。
// 筛选 / 搜索仍用原生 GET 表单交给服务端重渲染。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCheck,
  FileText,
  Heart,
  Search,
  Star,
  X,
} from 'lucide-react';
import AdminBlogActions, { type CategoryGroup } from './AdminBlogActions';
import AdminEmpty from './AdminEmpty';
import AdminPager from './AdminPager';
import AdminPick from './AdminPick';
import ExpandSelect, { type ExpandSelectGroup } from './ExpandSelect';

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
  const [batchCategory, setBatchCategory] = useState('none');
  const [busy, setBusy] = useState(false);

  // 栏目筛选是「选中即提交」的 GET 筛选：本地值先落下来（面板立刻显示新值），
  // 再 requestSubmit。服务端那一份变化时（比如点「重置」）同步回来。
  const [categoryFilter, setCategoryFilter] = useState(currentCategoryId);
  const filterFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => setCategoryFilter(currentCategoryId), [currentCategoryId]);

  const categoryFilterGroups = useMemo<ExpandSelectGroup[]>(
    () => [
      {
        options: [
          { value: '', label: '全部栏目' },
          { value: '-1', label: '未分类' },
        ],
      },
      ...categoryGroups.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({
          value: String(option.id),
          label: option.label,
        })),
      })),
    ],
    [categoryGroups]
  );

  const pageIds = articles.map((a) => a.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  const allSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const hasFilter = Boolean(currentCategoryId || search);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelected(next);
  };

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
    if (selectedOnPage.length === 0 || busy) return;
    setBusy(true);
    try {
      const categoryId = batchCategory === 'none' ? null : Number(batchCategory);
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
    if (selectedOnPage.length === 0 || busy) return;
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
      {/* 筛选和搜索栏 —— 胶囊底座，吸在顶栏下方 */}
      <form ref={filterFormRef} method="GET" className="admin-toolbar" id="filterForm">
        <label className="admin-search">
          <span className="admin-search__icon" aria-hidden="true">
            <Search />
          </span>
          <input
            type="search"
            className="admin-search__input"
            name="search"
            defaultValue={search}
            placeholder="搜索文章标题…"
            aria-label="搜索文章标题"
          />
        </label>

        <ExpandSelect
          id="article-category-filter"
          name="category"
          className="admin-toolbar__select"
          value={categoryFilter}
          onChange={(value) => {
            setCategoryFilter(value);
            filterFormRef.current?.requestSubmit();
          }}
          groups={categoryFilterGroups}
          ariaLabel="按栏目筛选"
        />

        <button type="submit" className="btn btn-primary admin-toolbar__button">
          筛选
        </button>
        {hasFilter && (
          <Link href="/admin/blogs" className="btn btn-secondary admin-toolbar__button">
            重置
          </Link>
        )}

        <span className="admin-toolbar__hint numeric">共 {total} 篇</span>
      </form>

      <div className="admin-list-head">
        <span>
          本页 <span className="numeric">{articles.length}</span> 篇
          {selectedOnPage.length > 0 ? (
            <>
              {' '}
              · 已选 <span className="numeric">{selectedOnPage.length}</span> 篇
            </>
          ) : null}
        </span>
        {articles.length > 0 && (
          <div className="admin-list-head__actions">
            <button type="button" className="admin-list-head__btn" disabled={busy} onClick={toggleAll}>
              {allSelected ? <X aria-hidden="true" /> : <CheckCheck aria-hidden="true" />}
              {allSelected ? '取消全选' : '全选本页'}
            </button>
          </div>
        )}
      </div>

      {/* 文章列表 */}
      <div id="articlesList">
        {articles.map((a, i) => (
          <article
            key={a.id}
            className={`admin-row${selected.has(a.id) ? ' is-selected' : ''}`}
            data-article-id={a.id}
            style={{ '--i': i } as CSSProperties}
          >
            <div className="admin-row__pick">
              <AdminPick
                checked={selected.has(a.id)}
                onChange={() => toggle(a.id)}
                label={`选择文章：${a.title}`}
              />
            </div>

            <div className="admin-row__main">
              <div className="admin-row__title">
                <span>{a.title}</span>
                {a.isFeatured && (
                  <span className="admin-chip admin-chip--featured">
                    <Star aria-hidden="true" />
                    精选
                  </span>
                )}
              </div>

              <div className="admin-row__meta">
                <span>{a.author}</span>
                <span className="numeric">{a.date}</span>
                <span className="admin-row__stat" title="点赞数">
                  <Heart aria-hidden="true" />
                  <span className="numeric">{a.likesCount}</span>
                </span>
                <span className="admin-row__id">#{a.id.slice(0, 8)}</span>
              </div>

              {a.description ? <p className="admin-row__desc">{a.description}</p> : null}
            </div>

            <div className="admin-row__side">
              <div className="admin-row__side-chips">
                <span
                  className={`admin-chip ${
                    a.categoryPath ? 'admin-chip--blue' : 'admin-chip--amber'
                  }`}
                >
                  {a.categoryPath ?? '未分类'}
                </span>
              </div>
              <div className="admin-row__actions">
                <AdminBlogActions
                  blogId={a.id}
                  initialFeatured={a.isFeatured}
                  initialCategoryId={a.categoryId}
                  categoryGroups={categoryGroups}
                />
              </div>
            </div>
          </article>
        ))}

        {articles.length === 0 && (
          <AdminEmpty
            icon={FileText}
            title="没有找到文章"
            description="试试调整栏目筛选或换一个搜索关键词。"
          >
            {hasFilter ? (
              <Link href="/admin/blogs" className="btn btn-primary">
                清掉筛选
              </Link>
            ) : null}
          </AdminEmpty>
        )}
      </div>

      <AdminPager page={pagination.page} pages={pagination.pages} href={qs} />

      {/* 批量操作：选中后从底部浮出。底座固定在视口底部，故补一段占位空白。 */}
      {selectedOnPage.length > 0 && (
        <>
          <div className="admin-dock" role="region" aria-label="批量操作">
            <span className="admin-dock__count">
              已选 <span className="numeric">{selectedOnPage.length}</span> 篇
            </span>
            <select
              className="form-select admin-dock__select"
              value={batchCategory}
              onChange={(e) => setBatchCategory(e.target.value)}
              disabled={busy}
              aria-label="批量更新的目标栏目"
            >
              <option value="none">设为未分类</option>
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
            <button
              type="button"
              className="btn btn-primary admin-dock__btn"
              disabled={busy}
              onClick={batchUpdate}
            >
              更新栏目
            </button>
            <button
              type="button"
              className="btn btn-secondary admin-dock__btn"
              disabled={busy}
              onClick={batchFeatured}
            >
              设为精选
            </button>
            <button
              type="button"
              className="btn btn-secondary admin-dock__btn"
              onClick={clearSelection}
              disabled={busy}
            >
              取消
            </button>
          </div>
          <div className="admin-dock-spacer" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
