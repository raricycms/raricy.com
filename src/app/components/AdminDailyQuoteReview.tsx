'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminDailyQuoteReview({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function review(action: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/daily-quotes/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reason }),
      });
      if (!response.ok) throw new Error((await response.json()).message || '审核失败');
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '审核失败'); }
    finally { setBusy(false); }
  }
  if (status !== 'pending' && status !== 'approved') return null;
  return <div className="daily-quote-form">
    <label>审核说明{status === 'pending' ? '（拒绝时必填）' : '（下架时必填）'}
      <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} />
    </label>
    <div className="daily-quote-card__actions">
      {status === 'pending' && <button type="button" className="daily-quote-primary" onClick={() => void review('approve')} disabled={busy}>通过</button>}
      <button type="button" className="daily-quote-primary" onClick={() => void review(status === 'pending' ? 'reject' : 'retire')} disabled={busy || !reason.trim()}>
        {status === 'pending' ? '永久拒绝' : '下架'}
      </button>
    </div>
    {error && <p className="daily-quote-error" role="alert">{error}</p>}
  </div>;
}
