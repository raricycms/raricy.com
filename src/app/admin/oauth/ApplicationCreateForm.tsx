'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';

// 创建表单：name 必填；redirectUris 一行一个。
// 成功后弹一次性 modal 展示 clientId + clientSecret，「我已保存」确认后关闭并刷新表格。
//
// 【钉死的部分】id oauth-name / oauth-desc / oauth-homepage / oauth-redirect、required
// 属性、错误提示与那个一次性 secret 弹窗都照旧（弹窗的 oauth-modal-overlay /
// oauth-modal 是公开授权页共用的类，管理端只在 _oauth-admin.scss 里做 `.admin-content`
// 作用域内的覆写，绝不动 pages/_oauth.scss）。
// 视觉上字段从 .settings-input 迁到全站 .form-control（胶囊 / 20px 多行），表单本体是
// 一张 `.admin-panel`，不再是卡中卡。

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
      <section className="admin-panel">
        <div className="admin-section-head">
          <h2 className="admin-section-title">注册新应用</h2>
        </div>

        {error && <div className="settings-alert settings-alert--danger">{error}</div>}

        <form onSubmit={submit} className="admin-oauth-create">
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="oauth-name">
              应用名 <span className="admin-oauth-required">*</span>
            </label>
            <input
              id="oauth-name"
              className="form-control admin-field__control"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：cattca-game"
            />
          </div>

          <div className="admin-field">
            <label className="admin-field__label" htmlFor="oauth-desc">
              说明
            </label>
            <input
              id="oauth-desc"
              className="form-control admin-field__control"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，一句话说明这个应用的用途"
            />
          </div>

          <div className="admin-field">
            <label className="admin-field__label" htmlFor="oauth-homepage">
              主页 URL
            </label>
            <input
              id="oauth-homepage"
              className="form-control admin-field__control"
              type="url"
              value={homepageUrl}
              onChange={(e) => setHomepageUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </div>

          <div className="admin-field admin-oauth-create__full">
            <label className="admin-field__label" htmlFor="oauth-redirect">
              回调 URI <span className="admin-oauth-required">*</span>
            </label>
            <textarea
              id="oauth-redirect"
              className="form-control admin-field__control admin-oauth-create__mono"
              required
              rows={4}
              value={redirectUrisText}
              onChange={(e) => setRedirectUrisText(e.target.value)}
              placeholder={'每行一个 URL，例：\nhttps://example.com/oauth/callback\nhttp://localhost:3000/dev-cb'}
            />
            <small className="admin-oauth-hint">精确匹配（无通配）。多个用换行分隔。</small>
          </div>

          <div className="admin-oauth-create__actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </section>

      {created && (
        <div className="oauth-modal-overlay" role="dialog" aria-modal="true">
          <div className="oauth-modal">
            <h2>应用已创建</h2>
            <p className="admin-oauth-modal__note">
              <TriangleAlert aria-hidden="true" className="admin-oauth-modal__warn" />
              <span>
                <strong className="admin-oauth-modal__warn">client_secret 仅此一次显示</strong>
                ，请立即复制到安全的地方。关闭此弹窗后无法再次查看。
              </span>
            </p>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">应用名</div>
              <div>{created.application.name}</div>
            </div>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">client_id</div>
              <div className="oauth-modal__row">
                <code>{created.clientId}</code>
                <button
                  type="button"
                  className="btn btn-secondary admin-oauth-copy"
                  onClick={() => copy(created.clientId)}
                >
                  复制
                </button>
              </div>
            </div>

            <div className="oauth-modal__field">
              <div className="oauth-modal__label">client_secret</div>
              <div className="oauth-modal__row">
                <code className="admin-oauth-modal__secret">{created.clientSecret}</code>
                <button
                  type="button"
                  className="btn btn-secondary admin-oauth-copy"
                  onClick={() => copy(created.clientSecret)}
                >
                  复制
                </button>
              </div>
            </div>

            <div className="admin-oauth-modal__actions">
              <button type="button" className="btn btn-primary" onClick={closeModal}>
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
