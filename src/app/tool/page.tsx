import { getCurrentUser, isCoreUser } from '@/lib/auth';
import ToolMenu from './ToolMenu';

// 工具箱 —— 工具清单本体在 ToolMenu.tsx（它同时承担首页那张工具卡）。
// 投票箱仅对核心用户显示（core 及以上）。
export default async function ToolMenuPage() {
  const user = await getCurrentUser();
  return <ToolMenu isCore={isCoreUser(user)} />;
}
