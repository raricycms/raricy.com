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

// /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...&scope=profile
//
// 用户在外部应用点击「绑定 raricy 账号」时被引导至此。
// 必须已登录（raricy session cookie）；未登录跳 /login?next=当前 URL。
//
// 渲染：申请的应用名 + 主页链接 + 请求的 scope 列表 + 「授权 / 取消」按钮。
// 用户点「授权」→ POST /api/oauth/authorize → 拿 redirect_to 后顶层跳转 redirect_uri?code=&state=
// 用户点「取消」→ 跳回 redirect_uri?error=access_denied&state=

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

export default async function AuthorizePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const clientId = (sp.client_id || '').trim();
  const redirectUri = (sp.redirect_uri || '').trim();
  const state = sp.state || '';
  const scopeRaw = sp.scope || 'profile';
  const responseType = sp.response_type || '';

  // response_type 必须为 code
  if (responseType && responseType !== 'code') {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>不支持的 response_type</h1>
          <p>raricy OAuth 2.0 仅支持 <code>response_type=code</code>。</p>
        </div>
      </div>
    );
  }

  // 未登录跳登录（带 next 参数，登录后跳回）
  const user = await getCurrentUser();
  if (!user) {
    const here = `/oauth/authorize?${new URLSearchParams({
      ...(sp as Record<string, string>),
    }).toString()}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  // 参数不全
  if (!clientId || !redirectUri) {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>参数缺失</h1>
          <p>缺少 <code>client_id</code> 或 <code>redirect_uri</code>。</p>
        </div>
      </div>
    );
  }

  // 查应用
  const app = await prisma.oAuthApplication.findUnique({
    where: { clientId },
    select: { id: true, name: true, description: true, homepageUrl: true, redirectUris: true, disabledAt: true },
  });
  if (!app) {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>未知应用</h1>
          <p>client_id <code>{clientId}</code> 未在 raricy 注册。</p>
        </div>
      </div>
    );
  }
  if (app.disabledAt) {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>应用已停用</h1>
          <p>{app.name} 已被站长停用，无法绑定。</p>
        </div>
      </div>
    );
  }

  // redirect_uri 白名单
  let allowed: string[];
  try {
    allowed = parseRedirectUris(app.redirectUris);
  } catch {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>配置错误</h1>
          <p>该应用的 redirect_uris 配置损坏，请联系站长。</p>
        </div>
      </div>
    );
  }
  if (!allowed.includes(redirectUri)) {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>回调地址未注册</h1>
          <p>
            该应用未注册回调地址 <code>{redirectUri}</code>。<br />
            如你是站长，请到 <a href="/admin/oauth">OAuth 应用管理</a> 添加此 redirect_uri。
          </p>
        </div>
      </div>
    );
  }

  // scope 过滤
  const requested = normalizeScopes(scopeRaw);
  const scopes = requested.length > 0 ? requested : (['profile'] as const);
  const unknown = scopeRaw
    .split(/\s+/)
    .filter((s) => s && !SUPPORTED_SCOPES.includes(s as typeof SUPPORTED_SCOPES[number]));
  if (unknown.length > 0) {
    return (
      <div className="pwrap pwrap--narrow">
        <div className="card settings-card">
          <h1>不支持的 scope</h1>
          <p>
            raricy OAuth 不识别以下 scope：
            {unknown.map((s) => (
              <code key={s} style={{ marginLeft: 6 }}>{s}</code>
            ))}
            <br />当前可用：<code>{SUPPORTED_SCOPES.join(' / ')}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pwrap pwrap--narrow">
      <div className="card settings-card">
        <div className="settings-card__header">
          <span className="icon icon-shield-check"></span>
          <h1 className="settings-card__title">授权应用访问你的账号</h1>
        </div>

        <p className="settings-card__desc">
          <strong>{app.name}</strong>
          {app.homepageUrl && (
            <>
              {' '}（<a href={app.homepageUrl} target="_blank" rel="noopener noreferrer">{app.homepageUrl}</a>）
            </>
          )}
          申请访问你的 raricy 账号。
        </p>

        {app.description && (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>{app.description}</p>
        )}

        <div style={{ marginTop: 16, padding: '12px 16px', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>该应用将能够：</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {scopes.map((s) => (
              <li key={s}>
                <strong>{SCOPE_LABELS[s]?.title || s}</strong>
                {SCOPE_LABELS[s] && (
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>— {SCOPE_LABELS[s].desc}</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)' }}>
          授权后将创建一个 90 天有效的访问令牌。你随时可以在「账号设置 → 已绑定的应用」中解除绑定。
        </p>

        <AuthorizeForm
          clientId={clientId}
          redirectUri={redirectUri}
          state={state}
          scope={scopes.join(' ')}
          appName={app.name}
        />
      </div>
    </div>
  );
}