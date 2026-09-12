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
// 授权 → POST /api/oauth/authorize；后端返回 JSON { redirect_to }，
//         前端 window.location.href 跳到 redirect_to（含 code & state）。
// 取消 → 直接跳回 redirect_uri?error=access_denied&state=
//
// ⚠️ 注意：这里不能用 fetch + 让浏览器 follow 302 的方式。
// fetch 即便默认 follow redirect，也只会在内部接力请求，document 不会
// 做顶层导航——用户会留在 /oauth/authorize，最终又得靠 window.location.href
// 兜底，那时候就拿不到 code 了。
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
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message || `授权失败 (${res.status})`);
        setSubmitting(null);
        return;
      }
      const j = (await res.json()) as { redirect_to?: string };
      if (!j.redirect_to) {
        setError('服务器响应缺少 redirect_to');
        setSubmitting(null);
        return;
      }
      // 顶层导航：跳到第三方应用 callback（含 code & state）
      window.location.href = j.redirect_to;
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