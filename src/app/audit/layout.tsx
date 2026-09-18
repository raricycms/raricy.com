import { requireCoreUser } from '@/lib/guard';
import AdminShell from '@/app/components/AdminShell';

// 操作日志（公示）的母版。
//
// 操作日志列表与详情都**带管理侧边栏**。
// 迁移时 /audit 被做成了独立页，导致进「操作日志」后管理面板整个消失、也回不去。
//
// 权限是 core+（不是 admin）：普通核心用户也能看公示，此时侧栏按逐项门控只显示
// 「用户管理 / 操作日志 / 返回网站」。这正是它不能直接放进 /admin 段的原因
//（那里整体要求 hasAdminRights）。
export default async function AuditLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCoreUser(); // 非核心用户 → 原地渲染 403 页
  return <AdminShell user={user}>{children}</AdminShell>;
}
