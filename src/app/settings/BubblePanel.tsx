'use client';

import { useCallback, useEffect, useState } from 'react';
import ChatBubble from '@/app/components/ChatBubble';
import type { listMyBubbles } from '@/lib/bubble-service';

type View = Awaited<ReturnType<typeof listMyBubbles>>;
export default function BubblePanel() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ ok: boolean; message: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/users/me/bubble', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? '加载失败');
      setView(data);
      setAlert((previous) => previous?.ok === false ? null : previous);
    } catch { setAlert({ ok: false, message: '聊天气泡加载失败，请重试' }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function equip(key: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/users/me/bubble', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bubble_key: key }),
      });
      const data = await res.json();
      if (!res.ok) { setAlert({ ok: false, message: data.message }); return; }
      setAlert({ ok: true, message: key ? '已切换聊天气泡' : '已恢复默认气泡' });
      await load();
    } catch { setAlert({ ok: false, message: '网络错误，请稍后重试' }); }
    finally { setBusy(false); }
  }
  return (
    <div className="bubble-panel">
      {alert && <div role="status" className={`settings-alert settings-alert--${alert.ok ? 'success' : 'danger'}`}>{alert.message}</div>}
      {!view ? alert ? <button className="settings-btn" onClick={() => void load()}>重新加载</button> : <p className="settings-card__desc" role="status">加载中…</p> : (
        <>
          <div className="bubble-panel__item">
            <ChatBubble bubbleKey={null}>默认气泡，一直可用。</ChatBubble>
            <button className="settings-btn" disabled={busy || view.equippedKey === null} onClick={() => void equip(null)}>
              {view.equippedKey === null ? '使用中' : '恢复默认'}
            </button>
          </div>
          {view.bubbles.map((b) => (
            <div className="bubble-panel__item" key={b.key} data-bubble-item={b.key}>
              <ChatBubble bubbleKey={b.key}>{b.label}，这是你的聊天气泡预览。</ChatBubble>
              <span className="bubble-panel__state"><span className="numeric">{b.expiresAt ? `${b.expiresAt} 到期` : '永久持有'}</span>{b.expired ? ' · 已过期' : b.disabled ? ' · 已停用' : ''}</span>
              <button className="settings-btn settings-btn--primary" disabled={busy || !b.available || view.activeKey === b.key} onClick={() => void equip(b.key)}>
                {view.activeKey === b.key ? '使用中' : '使用'}
              </button>
            </div>
          ))}
          {view.bubbles.length === 0 && <p className="settings-card__desc">你还没有付费气泡，可以到鱼干商城租用。</p>}
        </>
      )}
    </div>
  );
}
