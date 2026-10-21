'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DailyQuoteView } from '@/lib/daily-quote';
import DailyQuoteCard from '@/app/components/DailyQuoteCard';

export default function SavedQuotes({ rows }: { rows: { id: string; quote: DailyQuoteView | null }[] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  async function remove(id: string) {
    setBusy(id); setError('');
    try {
      const response = await fetch(`/api/daily-quotes/${encodeURIComponent(id)}/favorite`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).message || '移出失败');
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '移出失败'); }
    finally { setBusy(null); }
  }
  return <div className="daily-quote-list">
    {error && <p className="daily-quote-error" role="alert">{error}</p>}
    {rows.map((row) => <div className="daily-quote-panel" key={row.id}>
      {row.quote ? <DailyQuoteCard initialQuote={row.quote} onRemoved={() => router.refresh()} /> : <>
        <p>这句一言已下架。</p><button type="button" className="daily-quote-primary" disabled={busy === row.id} onClick={() => void remove(row.id)}>移出一言集</button>
      </>}
    </div>)}
  </div>;
}
