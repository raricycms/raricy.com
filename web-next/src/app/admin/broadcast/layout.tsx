import { requireOwner } from '@/lib/guard';

// 通知发送页仅站长可进 —— 对齐 Flask 的 @owner_required。
//
// 父级 admin/layout 只判到 hasAdminRights，而 AdminShell 侧栏虽然对非站长隐藏了
// 「通知发送」入口，但 URL 是猜得到的：没有这道 layout，普通管理员直接访问
// /admin/broadcast 就能打开群发表单。链接藏起来不等于挡住。
export default async function BroadcastLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return <>{children}</>;
}
