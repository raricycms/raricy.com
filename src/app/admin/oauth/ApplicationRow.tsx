'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface App {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  redirectUris: string[];
  createdAt: string | null;
  disabledAt: string | null;
}

interface Props {
  app: App;
}

export default function ApplicationRow({ app }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* fallback */
    }
  };

  const toggle = async () => {
    const will = !app.disabledAt;
    if (!window.confirm(`${will ? '禁用' : '启用'}「${app.name}」？${
      will ? '\n禁用后该应用的所有现有 token 也会被拒绝。' : ''
    }`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/oauth/applications/${encodeURIComponent(app.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: will }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || '操作失败');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="management-card">
      <div className="management-card__head">
        <div className="management-card__title-row">
          <h3 className="management-card__title">{app.name}</h3>
          {app.disabledAt ? (
            <span className="oauth-badge oauth-badge--danger">已禁用</span>
          ) : (
            <span className="oauth-badge oauth-badge--ok">启用中</span>
          )}
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={toggle}
          disabled={busy}
        >
          {busy ? '处理中…' : app.disabledAt ? '启用' : '禁用'}
        </button>
      </div>
      <div className="management-card__body">
        {app.description && <p className="management-card__desc">{app.description}</p>}
        {app.homepageUrl && (
          <p style={{ fontSize: '.85rem' }}>
            主页：<a href={app.homepageUrl} target="_blank" rel="noopener noreferrer">{app.homepageUrl}</a>
          </p>
        )}
        <div className="management-card__row">
          <span className="management-card__label">client_id</span>
          <code style={{ wordBreak: 'break-all', fontSize: '.85rem' }}>{app.clientId}</code>
          <button
            type="button"
            className="settings-btn"
            style={{ padding: '4px 10px', fontSize: '.8rem' }}
            onClick={() => copy(app.clientId)}
          >
            复制
          </button>
        </div>
        <div className="management-card__row" style={{ alignItems: 'flex-start' }}>
          <span className="management-card__label">回调 URI</span>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.85rem', flex: 1 }}>
            {app.redirectUris.map((u) => (
              <li key={u}><code style={{ wordBreak: 'break-all' }}>{u}</code></li>
            ))}
          </ul>
        </div>
        {error && <div className="settings-alert settings-alert--danger" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}