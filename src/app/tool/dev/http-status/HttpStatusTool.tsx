'use client';

// HTTP 状态码速查：静态数据 + 关键字搜索 + 分类筛选，不联网、不查库。
// 数据与查询在 `src/lib/dev-tools/http-status.ts`（零依赖，可单测）。
import { useMemo, useState } from 'react';
import {
  HTTP_STATUS_CATEGORIES,
  HTTP_STATUSES,
  httpStatusCounts,
  searchHttpStatuses,
  type HttpStatusCategory,
} from '@/lib/dev-tools/http-status';

type CategoryFilter = HttpStatusCategory | 'all';

const FILTERS: ReadonlyArray<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  ...HTTP_STATUS_CATEGORIES.map((category) => ({ key: category.key, label: category.label })),
];

export default function HttpStatusTool() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CategoryFilter>('all');

  const rows = useMemo(
    () => searchHttpStatuses(query, filter === 'all' ? undefined : filter),
    [query, filter]
  );
  const counts = httpStatusCounts();

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="http-status-query">
          搜索
        </label>
        <input
          id="http-status-query"
          className="form-control devtool-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="状态码、英文名或中文含义，例如 404 / 限流 / 未找到"
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
        共 {HTTP_STATUSES.length} 条；当前显示 {rows.length} 条
        {filter === 'all' ? '' : `（${HTTP_STATUS_CATEGORIES.find((c) => c.key === filter)?.summary ?? ''}）`}
        {filter === 'all' ? '' : `，其中 ${counts[filter]} 条`}
      </p>

      <div className="devtool-table-wrap">
        <table className="devtool-table">
          <thead>
            <tr>
              <th>状态码</th>
              <th>名称</th>
              <th>含义</th>
              <th>常见原因 / 处理建议</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.code}>
                <td>
                  <span className="devtool-badge mono">{entry.code}</span>
                </td>
                <td>{entry.name}</td>
                <td>{entry.meaning}</td>
                <td>{entry.advice}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? <p className="devtool-hint">没有匹配的状态码，换个关键词或切回「全部」。</p> : null}
    </div>
  );
}
