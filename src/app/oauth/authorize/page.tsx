import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  normalizeScopes,
  parseRedirectUris,
  SUPPORTED_SCOPES,
} from '@/lib/oauth';
import AuthorizeForm from './AuthorizeForm';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '授权应用访问你的账号',
  robots: 'noindex, nofollow',
};

interface PageProps {
  searchParams: Promise<{
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    scope?: string;
  }>;
}

const SCOPE_LABELS: Record<string, { title: string; desc: string }> = {
  profile: {
    title: '基础资料',
    desc: '读取你的 raricy 用户 ID、用户名、头像',
  },
};

function ErrorCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fd-page fd-page--narrow">
      <div className="fd-card fd-card--padded-lg">
        <header className="fd-settings-card__head u-mb-4">
          <span
            className="fd-settings-card__icon"
            aria-hidden="true"
            style={{ background: 'var(--fd-danger-soft)', color: 'var(--fd-danger)' }}
          >
            !
          </span>
          <h1 className="fd-settings-card__title">{title}</h1>
        </header>
        <div style={{ color: 'var(--fd-ink-2)', fontSize: 'var(--fd-text-base)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// OAuth 授权页 — Fluent Design
export default async function AuthorizePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const clientId = (sp.client_id || '').trim();
  const redirectUri = (sp.redirect_uri || '').trim();
  const state = sp.state || '';
  const scopeRaw = sp.scope || 'profile';
  const responseType = sp.response_type || '';

  if (responseType && responseType !== 'code') {
    return (
      <ErrorCard title="不支持的 response_type">
        raricy OAuth 2.0 仅支持 <code>response_type=code</code>。
      </ErrorCard>
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    const here = `/oauth/authorize?${new URLSearchParams({
      ...(sp as Record<string, string>),
    }).toString()}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  if (!clientId || !redirectUri) {
    return (
      <ErrorCard title="参数缺失">
        缺少 <code>client_id</code> 或 <code>redirect_uri</code>。
      </ErrorCard>
    );
  }

  const app = await prisma.oAuthApplication.findUnique({
    where: { clientId },
    select: {
      id: true,
      name: true,
      description: true,
      homepageUrl: true,
      redirectUris: true,
      disabledAt: true,
    },
  });
  if (!app) {
    return (
      <ErrorCard title="未知应用">
        client_id <code>{clientId}</code> 未在 raricy 注册。
      </ErrorCard>
    );
  }
  if (app.disabledAt) {
    return (
      <ErrorCard title="应用已停用">
        {app.name} 已被站长停用，无法绑定。
      </ErrorCard>
    );
  }

  let allowed: string[];
  try {
    allowed = parseRedirectUris(app.redirectUris);
  } catch {
    return (
      <ErrorCard title="配置错误">
        该应用的 redirect_uris 配置损坏，请联系站长。
      </ErrorCard>
    );
  }
  if (!allowed.includes(redirectUri)) {
    return (
      <ErrorCard title="回调地址未注册">
        该应用未注册回调地址 <code>{redirectUri}</code>。
        <br />
        如你是站长，请到{' '}
        <a href="/admin/oauth" style={{ color: 'var(--fd-accent)' }}>
          OAuth 应用管理
        </a>{' '}
        添加此 redirect_uri。
      </ErrorCard>
    );
  }

  const requested = normalizeScopes(scopeRaw);
  const scopes = requested.length > 0 ? requested : (['profile'] as const);
  const unknown = scopeRaw
    .split(/\s+/)
    .filter((s) => s && !SUPPORTED_SCOPES.includes(s as typeof SUPPORTED_SCOPES[number]));
  if (unknown.length > 0) {
    return (
      <ErrorCard title="不支持的 scope">
        raricy OAuth 不识别以下 scope：
        {unknown.map((s) => (
          <code key={s} style={{ marginLeft: 6 }}>
            {s}
          </code>
        ))}
        <br />
        当前可用：<code>{SUPPORTED_SCOPES.join(' / ')}</code>
      </ErrorCard>
    );
  }

  return (
    <div className="fd-page fd-page--narrow">
      <section className="fd-settings-card">
        <header className="fd-settings-card__head u-mb-5">
          <span className="fd-settings-card__icon" aria-hidden="true">
            🔐
          </span>
          <h1 className="fd-settings-card__title">授权应用访问你的账号</h1>
        </header>

        <p className="fd-settings-card__desc">
          <strong>{app.name}</strong>
          {app.homepageUrl && (
            <>
              {' '}
              （
              <a
                href={app.homepageUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--fd-accent)' }}
              >
                {app.homepageUrl}
              </a>
              ）
            </>
          )}
          {' '}申请访问你的 raricy 账号。
        </p>

        {app.description && (
          <p className="u-color-ink-2 u-text-sm u-mb-4">{app.description}</p>
        )}

        <div
          className="fd-card fd-card--padded-md"
          style={{
            background: 'var(--fd-accent-tint)',
            borderColor: 'var(--fd-accent-soft)',
            boxShadow: 'none',
            marginTop: 'var(--fd-space-4)',
          }}
        >
          <div
            style={{
              fontWeight: 600,
              marginBottom: 'var(--fd-space-2)',
              color: 'var(--fd-ink)',
            }}
          >
            该应用将能够：
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--fd-ink-2)' }}>
            {scopes.map((s) => (
              <li key={s} style={{ marginBottom: 4 }}>
                <strong>{SCOPE_LABELS[s]?.title || s}</strong>
                {SCOPE_LABELS[s] && (
                  <span style={{ color: 'var(--fd-ink-3)', marginLeft: 6 }}>
                    — {SCOPE_LABELS[s].desc}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <p
          style={{
            marginTop: 'var(--fd-space-4)',
            fontSize: 'var(--fd-text-sm)',
            color: 'var(--fd-ink-3)',
          }}
        >
          授权后将创建一个 90 天有效的访问令牌。你随时可以在「账号设置 → 已绑定的应用」中解除绑定。
        </p>

        <AuthorizeForm
          clientId={clientId}
          redirectUri={redirectUri}
          state={state}
          scope={scopes.join(' ')}
          appName={app.name}
        />
      </section>
    </div>
  );
}
