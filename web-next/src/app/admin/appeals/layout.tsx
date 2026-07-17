import { requireOwner } from '@/lib/guard';

// 申诉审批页仅站长可进 —— 对齐 Flask decide_appeal 的 @owner_required。
//
// 申诉是对管理员权力的制衡：让管理员自己审批申诉（包括针对自己那条操作的申诉）
// 这道闸就形同虚设。父级 admin/layout 只判到 hasAdminRights，故这里再收一档。
export default async function AppealsLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return <>{children}</>;
}
