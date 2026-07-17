import { redirect } from 'next/navigation';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import AdminShell from '@/app/components/AdminShell';

// 管理端母版（对齐 Flask admin_base.html）。
// 统一鉴权：/admin/* 下的页面需要管理员权限，非管理员一律跳登录
//（避免每个 admin 页面各写一遍）。
//
// 注意：侧边栏本身不在这里定义 —— 它在 AdminShell，因为 /audit（操作日志）
// 也要用同一套侧栏，但那条路由不在 /admin 段下，且对 core 用户开放。详见 AdminShell。
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) redirect('/login');

  return <AdminShell user={user!}>{children}</AdminShell>;
}
