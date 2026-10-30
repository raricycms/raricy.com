'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** 取消资格后仍可退出既有持仓；此视图没有开仓入口。成交价由 sell 接口现取。 */
export default function LegacyPositions({ positions }: { positions: { id: string; symbol: string; stake: number; direction: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  async function close(id: string) {
    if (busy) return;
    if (!window.confirm('按当前行情平仓？结算时收取既有手续费，投入可能全部亏损。')) return;
    setBusy(id);
    try {
      const res = await fetch('/api/fish/trade/sell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position_id: id }) });
      const data = await res.json();
      setMessage(data.message || (res.ok ? '已平仓' : '平仓失败，请重试'));
      if (res.ok) router.refresh();
    } catch { setMessage('网络错误，请重试'); }
    finally { setBusy(null); }
  }
  return <>
    {positions.length === 0 ? <p>没有未结持仓。</p> : <ul>{positions.map(p => <li key={p.id}>
      {p.symbol} · {p.direction === 'short' ? '做空' : '做多'} · 投入 {p.stake} 小鱼干{' '}
      <button className="button button-secondary" disabled={busy !== null} onClick={() => close(p.id)}>{busy === p.id ? '平仓中…' : '平仓'}</button>
    </li>)}</ul>}
    <p role="status">{message}</p>
  </>;
}
