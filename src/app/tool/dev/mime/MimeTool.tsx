'use client';

// MIME 类型查询：扩展名 / MIME 双向查询 + 分类筛选。
//
// 表里刻意保留同一类型的**新旧两种写法**（例如 application/zip 与
// application/x-zip-compressed），并在备注里说明谁新谁旧 —— 只看一条会查不到
// 「服务器实际发的是旧写法」的情况。数据在 `src/lib/dev-tools/mime.ts`。
import { useMemo, useState } from 'react';
import {
  MIME_CATEGORIES,
  MIME_TYPES,
  mimeCategoryCounts,
  searchMimeTypes,
  type MimeCategory,
} from '@/lib/dev-tools/mime';

type CategoryFilter = MimeCategory | 'all';

const FILTERS: ReadonlyArray<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  ...MIME_CATEGORIES.map((category) => ({ key: category.key, label: category.label })),
];

const CATEGORY_LABELS: Record<MimeCategory, string> = Object.fromEntries(
  MIME_CATEGORIES.map((category) => [category.key, category.label])
) as Record<MimeCategory, string>;

export default function MimeTool() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CategoryFilter>('all');

  const rows = useMemo(
    () => searchMimeTypes(query, filter === 'all' ? undefined : filter),
    [query, filter]
  );
  const counts = mimeCategoryCounts();

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="mime-query">
          搜索
        </label>
        <input
          id="mime-query"
          className="form-control devtool-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="扩展名或 MIME，例如 png、.webp、application/json"
        />
      </div>

      <div className="devtool-bar">
        {FILTERS.map((item) => (
          <button
            type="button"
            className={filter === item.key ? 'filter-pill active' : 'filter-pill'}
            key={item.key}
            onClick={() => setFilter(item.key)}
            aria-pressed={filter === item.key}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="devtool-status">
        共 {MIME_TYPES.length} 条；当前显示 {rows.length} 条
        {filter === 'all' ? '' : `，${CATEGORY_LABELS[filter]}分类共 ${counts[filter]} 条`}
      </p>

      <div className="devtool-table-wrap">
        <table className="devtool-table">
          <thead>
            <tr>
              <th>扩展名</th>
              <th>MIME 类型</th>
              <th>大类</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.mime}>
                <td className="mono">
                  {entry.ext.length > 0 ? entry.ext.map((ext) => `.${ext}`).join(' ') : '—'}
                </td>
                <td className="mono">{entry.mime}</td>
                <td>{CATEGORY_LABELS[entry.category]}</td>
                <td>{entry.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className="devtool-hint">没有匹配的类型，换个扩展名 / MIME，或把分类切回「全部」。</p>
      ) : null}
      <p className="devtool-hint">
        带 charset 说明的只出现在文本类上；旧写法（如 application/x-zip-compressed、
        image/x-icon）也单独保留一条，备注里会写明它与注册写法的关系。
      </p>
    </div>
  );
}
