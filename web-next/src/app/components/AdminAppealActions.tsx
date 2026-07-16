'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface AdminAppealActionsProps {
  appealId: number;
}

// 单条申诉的裁决操作：通过 / 驳回 + 可选批注。操作后 router.refresh()。
export default function AdminAppealActions({ appealId }: AdminAppealActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function decide(decision: 'accept' | 'reject') {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/appeals/${appealId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ decision, note }),
      });
      const data = await res.json();
      const ok = data.code === 200;
      setMsg({ text: data.message ?? (ok ? '成功' : '失败'), ok });
      if (ok) router.refresh();
    } catch {
      setMsg({ text: '网络错误', ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="d-flex mt-2" style={{ flexDirection: 'column', gap: 8 }}>
      <input
        type="text"
        className="form-control form-control-sm"
        placeholder="裁决批注（可选，会随通知发给申诉人）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      <div className="d-flex align-items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-sm btn-success"
          onClick={() => decide('accept')}
          disabled={busy}
        >
          通过
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          onClick={() => decide('reject')}
          disabled={busy}
        >
          驳回
        </button>
        {msg && (
          <span
            className={msg.ok ? 'text-muted' : 'text-danger'}
            style={{ fontSize: '0.78rem' }}
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
