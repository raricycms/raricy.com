import { forbidden, redirect } from 'next/navigation';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { listOAuthApplications } from '@/lib/oauth';
import ApplicationCreateForm from './ApplicationCreateForm';
import ApplicationRow from './ApplicationRow';

export const dynamic = 'force-dynamic';

// OAuth 应用管理（owner 专属）— Fluent Design
export default async function AdminOAuthPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/admin/oauth'));
  // 原地渲染 403（同 guard.ts / admin/layout.tsx）。原先 redirect('/forbidden') 是
  // 个死路：项目里没有 /forbidden 路由，管理员（非 owner）看到的是 404 而不是 403。
  if (!isOwner(user)) forbidden();

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
    <>
      <section className="admin-hero">
        <h1>OAuth 应用</h1>
        <p>注册并管理可调用 raricy 身份绑定的第三方应用。</p>
      </section>

      <div className="admin-container">
        <ApplicationCreateForm />

        <section className="management-card" style={{ marginTop: 20 }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
            已注册的应用（{data.length}）
          </h2>
          {data.length === 0 ? (
            <p className="text-muted" style={{ marginTop: 12 }}>
              暂无应用，使用上方表单创建第一个。
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
              {data.map((a) => (
                <ApplicationRow key={a.id} app={a} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
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
