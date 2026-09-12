import { requireOwner } from '@/lib/guard';

// 栏目管理仅站长可进 —— 栏目是站点结构（URL slug、发文规则、内容归属），
// 与 Flask 时代 @owner_required 口径一致，且与「通知发送」「申诉管理」同属站长专属。
//
// 父级 admin/layout 只判到 hasAdminRights，而 AdminShell 侧栏虽然对非站长隐藏了
// 「栏目管理」入口，但 URL 是猜得到的：没有这道 layout，普通管理员直接访问
// /admin/categories 就能改栏目结构。链接藏起来不等于挡住。
export default async function CategoriesLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return <>{children}</>;
}
