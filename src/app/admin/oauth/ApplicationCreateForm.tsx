'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 创建表单：name 必填；redirectUris 一行一个。
// 成功后弹一次性 modal 展示 clientId + clientSecret，「我已保存」确认后关闭并刷新表格。

interface CreatedResult {
  clientId: string;
  clientSecret: string;
  application: {
    id: string;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    redirectUris: string[];
    createdAt: string;
  };
}

export default function ApplicationCreateForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [redirectUrisText, setRedirectUrisText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const redirectUris = redirectUrisText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (redirectUris.length === 0) {
      setError('至少需要一个 redirect_uri（一行一个）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/oauth/applications', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          homepageUrl: homepageUrl.trim() || undefined,
          redirectUris,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || `创建失败 (${res.status})`);
      setCreated({
        clientId: j.clientId,
        clientSecret: j.clientSecret,
        application: j.application,
      });
      // 重置表单
      setName('');
      setDescription('');
      setHomepageUrl('');
      setRedirectUrisText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* fallback */
    }
  };

  const closeModal = () => {
    setCreated(null);
    router.refresh(); // 触发 server component 重渲染以刷新表格
  };

  return (
    <>
      <div className="management-card">
        <div className="management-card__head">
          <h2 className="management-card__title">注册新应用</h2>
        </div>
        <div className="management-card__body">
        {error && <div className="settings-alert settings-alert--danger">{error}</div>}
        <form onSubmit={submit} className="settings-form">
          <div className="settings-field">
            <label htmlFor="oauth-name">应用名 <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              id="oauth-name"
              className="settings-input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：cattca-game"
            />
          </div>
          <div className="settings-field">
            <label htmlFor="oauth-desc">说明</label>
            <input
              id="oauth-desc"
              className="settings-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，一句话说明这个应用的用途"
            />
          </div>
          <div className="settings-field">
            <label htmlFor="oauth-homepage">主页 URL</label>
            <input
              id="oauth-homepage"
              className="settings-input"
              type="url"
              value={homepageUrl}
              onChange={(e) => setHomepageUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <div className="settings-field">
            <label htmlFor="oauth-redirect">
              回调 URI <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <textarea
              id="oauth-redirect"
              className="settings-input"
              required
              rows={4}
              value={redirectUrisText}
              onChange={(e) => setRedirectUrisText(e.target.value)}
              placeholder="每行一个 URL，例：&#10;https://example.com/oauth/callback&#10;http://localhost:3000/dev-cb"
              style={{ fontFamily: 'monospace', fontSize: '.85rem' }}
            />
            <small style={{ color: 'var(--ink-3)' }}>
              精确匹配（无通配）。多个用换行分隔。
            </small>
          </div>
          <button type="submit" className="settings-btn settings-btn--primary" disabled={submitting}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </form>
        </div>
      </div>

      {created && (
        <div className="oauth-modal-overlay" role="dialog" aria-modal="true">
          <div className="oauth-modal">
            <h2>应用已创建</h2>
            <p style={{ color: 'var(--ink-3)', marginBottom: 16 }}>
              ⚠️ <strong style={{ color: 'var(--danger)' }}>client_secret 仅此一次显示</strong>，
              请立即复制到安全的地方。关闭此弹窗后无法再次查看。
            </p>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">应用名</div>
              <div>{created.application.name}</div>
            </div>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">client_id</div>
              <div className="oauth-modal__row">
                <code>{created.clientId}</code>
                <button type="button" className="settings-btn" onClick={() => copy(created.clientId)}>复制</button>
              </div>
            </div>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">client_secret</div>
              <div className="oauth-modal__row">
                <code style={{ wordBreak: 'break-all' }}>{created.clientSecret}</code>
                <button type="button" className="settings-btn" onClick={() => copy(created.clientSecret)}>复制</button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" className="settings-btn settings-btn--primary" onClick={closeModal}>
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}