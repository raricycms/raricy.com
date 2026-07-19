'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  appName: string;
}

// 「授权 / 取消」按钮组件。
// 授权 → POST /api/oauth/authorize；后端会 302 跳到 redirect_uri?code=&state=
// 取消 → 直接跳回 redirect_uri?error=access_denied&state=
export default function AuthorizeForm({ clientId, redirectUri, state, scope, appName }: Props) {
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setSubmitting('approve');
    setError(null);
    try {
      // 默认 redirect: 'follow'：后端 Response.redirect(target, 302) 由浏览器自动跟随，
      // 用户最终落地到 redirect_uri?code=&state=，无需前端再处理 location header。
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state, scope }),
      });
      // 正常情况下 302 已被跟随，fetch resolve 出来的是 200，不会进下面这段。
      // 走到这说明后端走了非 redirect 路径（或被配置改过），用兜底跳回。
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message || `授权失败 (${res.status})`);
        setSubmitting(null);
        return;
      }
      window.location.href = redirectUri;
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络错误');
      setSubmitting(null);
    }
  };

  const deny = () => {
    setSubmitting('deny');
    const sep = redirectUri.includes('?') ? '&' : '?';
    const target = `${redirectUri}${sep}error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    window.location.href = target;
  };

  return (
    <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
      <button
        type="button"
        className="settings-btn settings-btn--primary"
        onClick={approve}
        disabled={submitting !== null}
      >
        {submitting === 'approve' ? '授权中…' : `授权 ${appName}`}
      </button>
      <button
        type="button"
        className="settings-btn"
        onClick={deny}
        disabled={submitting !== null}
      >
        取消
      </button>
      {error && (
        <div className="settings-alert settings-alert--danger" style={{ marginTop: 12, flex: '1 1 100%' }}>
          {error}
        </div>
      )}
    </div>
  );
}