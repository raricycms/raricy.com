'use client';

import { useEffect, useState } from 'react';

// 一条 = 一个应用（不是一条 token）。外部应用每次重新授权都会新签一条 90 天 token，
// 按 token 展开会让同一个网站重复出现 N 行 —— 聚合口径见 src/lib/oauth.ts。
interface Connection {
  applicationId: string;
  applicationName: string;
  applicationHomepageUrl: string | null;
  scopes: string[];
  tokenCount: number;
  firstAuthorizedAt: string;
  lastAuthorizedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
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

  // 按应用解绑：后端会撤销该应用名下**全部**存活 token，故提示里点明条数，
  // 免得重复授权过的用户以为只撤掉一条。
  const revoke = async (applicationId: string, name: string, tokenCount: number) => {
    const extra = tokenCount > 1 ? `（该应用名下有 ${tokenCount} 个有效令牌，将一并撤销）` : '';
    if (!window.confirm(`确定解除与「${name}」的绑定吗？${extra}`)) return;
    setBusyId(applicationId);
    try {
      const res = await fetch(`/api/oauth/connections/${encodeURIComponent(applicationId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || `解除失败 (${res.status})`);
      }
      onAlert('success', `已解除与「${name}」的绑定`);
      setConns((prev) => (prev ? prev.filter((c) => c.applicationId !== applicationId) : prev));
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
    return <div style={{ color: 'var(--color-text-secondary)', padding: '12px 0' }}>加载中…</div>;
  }
  if (conns.length === 0) {
    return (
      <div style={{ color: 'var(--color-text-secondary)', padding: '12px 0' }}>
        暂无已绑定的应用。当你在外部应用点击「绑定 raricy 账号」时会出现在此。
      </div>
    );
  }
  return (
    <div className="oauth-conn-list">
      {conns.map((c) => (
        <div key={c.applicationId} className="oauth-conn-row">
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
              授权于 {fmt(c.firstAuthorizedAt)}
              {c.tokenCount > 1 && <>　·　{c.tokenCount} 次授权</>}
              　·　到期 {fmt(c.expiresAt)}
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
            disabled={busyId === c.applicationId}
            onClick={() => revoke(c.applicationId, c.applicationName, c.tokenCount)}
          >
            {busyId === c.applicationId ? '解除中…' : '解除绑定'}
          </button>
        </div>
      ))}
    </div>
  );
}