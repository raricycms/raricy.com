'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DailyQuoteView, SavedQuoteEntry } from '@/lib/daily-quote';
import DailyQuoteCard from '@/app/components/DailyQuoteCard';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';

/**
 * 一言集按收藏时间排序，首次选登日仅作辅助；经典重播不改变收藏日期。
 *
 * 同 quoteId 的互动状态在页内共享（同往期列表）；取消收藏由卡片自己的切换完成，
 * 之后整页 `router.refresh()` 让服务层给出收敛后的有效页（取消末页最后一条时，
 * 页码越界由 `listSavedQuotes` 归一到末页）。
 */
export default function SavedQuotes({ rows }: { rows: SavedQuoteEntry[] }) {
  const router = useRouter();
  const [states, setStates] = useState<Record<string, DailyQuoteView>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [blogRequired, setBlogRequired] = useState(false);

  async function remove(id: string) {
    setBusy(id);
    setError('');
    try {
      const response = await fetch(`/api/daily-quotes/${encodeURIComponent(id)}/favorite`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const data = await response.json();
        if (data.reason === 'BLOG_REQUIRED') setBlogRequired(true);
        throw new Error(data.message || '移出失败');
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移出失败');
    } finally {
      setBusy(null);
    }
  }

  if (blogRequired) return <QuoteBlogRequired embedded />;
  return (
    <div className="daily-quote-list">
      {error && (
        <p className="daily-quote-error" role="alert">
          {error}
        </p>
      )}
      {rows.map((row) => {
        if (row.quote) {
          const quote = states[row.quote.id] ?? row.quote;
          return (
            <DailyQuoteCard
              key={row.id}
              mode="list"
              quote={quote}
              dateLabel={`收藏于 ${row.saved_at.slice(0, 10)}`}
              dateHint={row.first_selected_day ? `${quote.kind === 'builtin' ? '首次选登' : '选登于'} ${row.first_selected_day}` : undefined}
              onChange={(next) => setStates((current) => ({ ...current, [next.id]: next }))}
              onRemoved={() => router.refresh()}
            />
          );
        }
        return (
          <article key={row.id} className="daily-quote-card daily-quote-card--list daily-quote-card--unavailable">
            <div className="daily-quote-card__meta">
              <span className="daily-quote-card__date numeric">
                收藏于 {row.saved_at.slice(0, 10)}
              </span>
            </div>
            <p className="daily-quote-card__unavailable">这句一言已下架。</p>
            {/* 下架条目也要能移出，否则私密收藏里会留下无法清理的一行。 */}
            <div className="daily-quote-card__actions">
              <button
                type="button"
                className="daily-quote-primary"
                disabled={busy === row.id}
                aria-busy={busy === row.id}
                onClick={() => void remove(row.id)}
              >
                移出一言集
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
