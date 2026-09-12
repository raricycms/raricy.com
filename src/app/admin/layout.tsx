import { forbidden, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-url';
import AdminShell from '@/app/components/AdminShell';

// 管理端母版（对齐 Flask admin_base.html）。
// 统一鉴权：/admin/* 下的页面需要**核心用户**权限。
// 行为：
//   - 未登录 → 307 重定向到 /login?next=<原URL>
//   - 已登录但非 core+ → forbidden() 渲染 403
//
// 【为什么是 core 而不是 admin】这里的档位跟着 Flask 的 admin_base.html 走：那张母版
// 的侧栏对 is_core_user 就露出「用户管理」与「操作日志」两项，而 Flask 的
// auth.user_management 装饰器是 @authenticated_required（core+）——
// management.html 里核心用户看到的是**只读**版本的同一页（标题「用户列表」，
// 没有禁言 / 发通知 / 角色按钮）。原先这里收在 hasAdminRights，于是核心用户点侧栏
// 里那个「用户管理」必然 403：入口和门禁自相矛盾。
//
// 段内真正要管理权的页面各自把门（URL 猜得到，链接藏起来不等于挡住）：
//   · /admin、/admin/blogs     → requireAdmin()（在各自 page.tsx 里）
//   · /admin/oauth             → isOwner()（在 page.tsx 里）
//   · broadcast/categories/appeals → 各自的 layout.tsx 里 requireOwner()
// 新增段内路由时请照抄其中一档，别默认继承。
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
  if (!isCoreUser(user)) forbidden();

  return <AdminShell user={user}>{children}</AdminShell>;
}
