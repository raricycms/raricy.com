import type { Metadata } from 'next';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import ToolMenu from './ToolMenu';

// 工具箱 —— 工具清单本体在 ToolMenu.tsx（它同时承担首页那张工具卡）。
// 投票箱仅对核心用户显示（core 及以上）。
//
// ⚠️ `/tool` 是顶栏常驻入口，**必须有自己的 metadata**：本目录没有 layout.tsx
// （只有 7 个 legacy 子目录各自有），缺这条会落到根 layout 的站点级标题，
// 而 `/tool/dev`、`/tool/convert` 等子页都是「… - 聪明山工具箱」。
export const metadata: Metadata = {
  title: '工具箱 - 聪明山工具箱',
  description: '编码解码、哈希、格式化、网络查询与格式转换等在线工具合集。',
};

export default async function ToolMenuPage() {
  const user = await getCurrentUser();
  return <ToolMenu isCore={isCoreUser(user)} />;
}
