import { getCurrentUser, isCoreUser } from '@/lib/auth';
import ToolMenu from './ToolMenu';

// 工具箱 — 严格对齐原 tool/new_menu.html（当前线上模板）。
// 投票箱仅对核心用户显示（core 及以上）。
export default async function ToolMenuPage() {
  const user = await getCurrentUser();
  return <ToolMenu isCore={isCoreUser(user)} />;
}
