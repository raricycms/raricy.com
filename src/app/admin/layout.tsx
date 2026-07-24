import { forbidden, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-url';
import AdminShell from '@/app/components/AdminShell';

// 管理端母版（对齐 Flask admin_base.html）。
// 统一鉴权：/admin/* 下的页面需要管理员权限。
// 行为：
//   - 未登录 → 307 重定向到 /login?next=<原URL>
//   - 已登录但非 admin/owner → forbidden() 渲染 403
//
// 注意：侧边栏本身不在这里定义 —— 它在 AdminShell，因为 /audit（操作日志）
// 也要用同一套侧栏，但那条路由不在 /admin 段下，且对 core 用户开放。详见 AdminShell。
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    const h = await headers();
    const referer = h.get('referer');
    const host = h.get('host');
    let next = '/admin';
    if (referer) {
      try {
        const u = new URL(referer);
        if (!host || u.host === host) {
          const p = u.pathname + u.search;
          if (p.startsWith('/') && !p.startsWith('//')) next = p;
        }
      } catch { /* 忽略 */ }
    }
    redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`);
  }
  if (!hasAdminRights(user)) forbidden();

  return <AdminShell user={user}>{children}</AdminShell>;
}