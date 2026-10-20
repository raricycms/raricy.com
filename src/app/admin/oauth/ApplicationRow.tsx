'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// 已注册应用的一行。
//
// 【修掉的债】根节点此前是 `.management-card`，而页面又把它套在另一个
// `.management-card` 里 —— 卡中卡：双 30px 内距、两层同色，去掉描边后边界彻底
// 消失（docs/frontend-styles.md §12 登记过）。现在页面给 `.admin-panel` 外壳，
// 行自己只用 `.admin-app-row`（内容底色 + 20px 圆角）。
// 接口调用、`window.confirm` 文案、错误提示与「禁用 / 启用」按钮的文案都照旧
// —— 无障碍名必须是这两个词本身（安全相关用例按它定位）。
// 状态徽标从 oauth-badge 换成共享 `.admin-chip`（启用中 / 已禁用）。

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
    <article className="admin-app-row">
      <div className="admin-app-row__head">
        <div className="admin-app-row__title-row">
          <h3 className="admin-app-row__title">{app.name}</h3>
          {app.disabledAt ? (
            <span className="admin-chip admin-chip--warning">已禁用</span>
          ) : (
            <span className="admin-chip admin-chip--success">启用中</span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary admin-app-row__toggle"
          onClick={toggle}
          disabled={busy}
          aria-busy={busy}
        >
          {app.disabledAt ? '启用' : '禁用'}
        </button>
      </div>

      <div className="admin-app-row__body">
        {app.description && <p className="admin-app-row__desc">{app.description}</p>}

        {app.homepageUrl && (
          <p className="admin-app-row__homepage">
            主页：
            <a href={app.homepageUrl} target="_blank" rel="noopener noreferrer">
              {app.homepageUrl}
            </a>
          </p>
        )}

        <div className="admin-app-row__field">
          <span className="admin-app-row__label">client_id</span>
          <code className="admin-app-row__code">{app.clientId}</code>
          <button
            type="button"
            className="btn btn-secondary admin-oauth-copy"
            onClick={() => copy(app.clientId)}
          >
            复制
          </button>
        </div>

        <div className="admin-app-row__field admin-app-row__field--top">
          <span className="admin-app-row__label">回调 URI</span>
          <ul className="admin-app-row__uris">
            {app.redirectUris.map((u) => (
              <li key={u}>
                <code className="admin-app-row__code">{u}</code>
              </li>
            ))}
          </ul>
        </div>

        {error && <div className="settings-alert settings-alert--danger admin-app-row__error">{error}</div>}
      </div>
    </article>
  );
}
