import { forbidden, redirect } from 'next/navigation';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { listOAuthApplications } from '@/lib/oauth';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminEmpty from '@/app/components/AdminEmpty';
import { KeyRound } from 'lucide-react';
import ApplicationCreateForm from './ApplicationCreateForm';
import ApplicationRow from './ApplicationRow';

export const dynamic = 'force-dynamic';

// OAuth 应用管理（owner 专属）。
//
// 版式与 /admin 其它页同构：抬头 → 创建表单 → 已注册应用列表。
// 两张面板都直接是 `.admin-panel`（`+ .admin-panel` 自带 16px 间距），
// 行卡由 ApplicationRow 自己提供 —— 页面**不再**套一层管理卡，否则又会长回
// 「卡中卡」（外壳责任规则见 docs/frontend-styles.md §8.2）。
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
      <AdminPageHeader
        eyebrow={
          <>
            <KeyRound aria-hidden="true" />
            开发
          </>
        }
        title="OAuth 应用"
        subtitle="注册并管理可调用 raricy 身份绑定的第三方应用。"
      />

      <div className="admin-container">
        <ApplicationCreateForm />

        <section className="admin-panel">
          <div className="admin-section-head">
            <h2 className="admin-section-title">
              已注册的应用
              <span className="admin-section-count numeric">{data.length}</span>
            </h2>
          </div>

          {data.length === 0 ? (
            <AdminEmpty
              icon={KeyRound}
              title="暂无应用"
              description="使用上方表单创建第一个 OAuth 应用。"
            />
          ) : (
            <div className="admin-apps-list">
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
