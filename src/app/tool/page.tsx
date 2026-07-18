import { getCurrentUser, isCoreUser } from '@/lib/auth';
import ToolMenu from './ToolMenu';

// 工具箱 — 严格对齐原 tool/new_menu.html（当前线上模板）。
// 投票箱 / 照片墙仅对核心用户显示（对齐模板的 is_core_user 判断）。
export default async function ToolMenuPage() {
  const user = await getCurrentUser();
  return <ToolMenu isCore={isCoreUser(user)} />;
}
