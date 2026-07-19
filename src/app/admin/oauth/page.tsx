import { redirect } from 'next/navigation';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { listOAuthApplications } from '@/lib/oauth';
import ApplicationCreateForm from './ApplicationCreateForm';
import ApplicationRow from './ApplicationRow';

// /admin/oauth —— owner 专属：注册并管理 OAuth 2.0 第三方应用。
// 父级 /admin/layout.tsx 已校验 hasAdminRights，这里再叠加 isOwner，
// 把 admin 角色挡在外面（OAuth 应用是跨站信任锚点，必须由站长直接管）。

export const dynamic = 'force-dynamic';

export default async function AdminOAuthPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/admin/oauth'));
  if (!isOwner(user)) redirect('/forbidden');

  const apps = await listOAuthApplications();

  const data = apps.map((a) => ({
    id: a.id,
    clientId: a.clientId,
    name: a.name,
    description: a.description,
    homepageUrl: a.homepageUrl,
    redirectUris: safeParse(a.redirectUris),
    createdAt: a.createdAt?.toISOString() ?? null,
    disabledAt: a.disabledAt?.toISOString() ?? null,
  }));

  return (
    <div className="admin-container">
      <section className="admin-hero">
        <h1>OAuth 应用</h1>
        <p>注册并管理可调用 raricy 身份绑定的第三方应用。</p>
      </section>

      <ApplicationCreateForm />

      <div className="admin-section">
        <h2 className="admin-section__title">已注册的应用（{data.length}）</h2>
        {data.length === 0 ? (
          <p style={{ color: 'var(--ink-3)' }}>暂无应用，使用上方表单创建第一个。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {data.map((a) => (
              <ApplicationRow key={a.id} app={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}