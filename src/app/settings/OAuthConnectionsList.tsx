'use client';

import { useEffect, useState } from 'react';

interface Connection {
  tokenId: string;
  applicationId: string;
  applicationName: string;
  applicationHomepageUrl: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
}

interface Props {
  onAlert: (kind: 'success' | 'danger', msg: string) => void;
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return iso;
  }
}

export default function OAuthConnectionsList({ onAlert }: Props) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/oauth/connections', { credentials: 'include' });
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      const j = await res.json();
      setConns(j.connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const revoke = async (tokenId: string, name: string) => {
    if (!window.confirm(`确定解除与「${name}」的绑定吗？`)) return;
    setBusyId(tokenId);
    try {
      const res = await fetch(`/api/oauth/connections/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || `解除失败 (${res.status})`);
      }
      onAlert('success', `已解除与「${name}」的绑定`);
      setConns((prev) => (prev ? prev.filter((c) => c.tokenId !== tokenId) : prev));
    } catch (e) {
      onAlert('danger', e instanceof Error ? e.message : '解除失败');
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return (
      <div className="settings-alert settings-alert--danger">{error}</div>
    );
  }
  if (conns === null) {
    return <div style={{ color: 'var(--muted)', padding: '12px 0' }}>加载中…</div>;
  }
  if (conns.length === 0) {
    return (
      <div style={{ color: 'var(--muted)', padding: '12px 0' }}>
        暂无已绑定的应用。当你在外部应用点击「绑定 raricy 账号」时会出现在此。
      </div>
    );
  }
  return (
    <div className="oauth-conn-list">
      {conns.map((c) => (
        <div key={c.tokenId} className="oauth-conn-row">
          <div className="oauth-conn-row__main">
            <div className="oauth-conn-row__name">
              {c.applicationHomepageUrl ? (
                <a
                  href={c.applicationHomepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c.applicationName}
                </a>
              ) : (
                c.applicationName
              )}
            </div>
            <div className="oauth-conn-row__meta">
              授权于 {fmt(c.createdAt)}　·　到期 {fmt(c.expiresAt)}
            </div>
            <div className="oauth-conn-row__scopes">
              {c.scopes.map((s) => (
                <span key={s} className="oauth-chip">{s}</span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="settings-btn"
            disabled={busyId === c.tokenId}
            onClick={() => revoke(c.tokenId, c.applicationName)}
          >
            {busyId === c.tokenId ? '解除中…' : '解除绑定'}
          </button>
        </div>
      ))}
    </div>
  );
}