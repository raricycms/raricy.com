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
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state, scope }),
        redirect: 'manual', // 手动处理 302
      });
      // 后端 302 → 用 location header；失败 → 读 body 报错
      if (res.status === 0 || res.type === 'opaqueredirect') {
        // 浏览器 follow 前的 redirect（fetch manual 不暴露 location）
        // 这种 case 极少；真发生就退到读 header
        window.location.href = redirectUri;
        return;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          window.location.href = loc;
          return;
        }
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message || `授权失败 (${res.status})`);
        setSubmitting(null);
        return;
      }
      // 200 但无 redirect — 异常路径
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