// POST /api/admin/broadcast { detail, action?, targetGroup?, objectType?, objectId? }
//
// 权限：**仅站长**。对齐 Flask —— 那边群发在三处都卡了站长：
//   · 页面 admin_notifications        @owner_required
//   · 接口 send_notification_to_user  @owner_required
//   · service 层 notifications.py:321 显式判 is_owner（「仅站长可群发」）
// 此前这里只判 hasAdminRights，任何管理员都能给全站发通知 —— 比 Flask 松。
import { getCurrentUser, isOwner } from '@/lib/auth';
import { broadcast, type TargetGroup } from '@/lib/broadcast-service';
import { apiOk, apiErr } from '@/lib/format';

const GROUPS: TargetGroup[] = ['all', 'authenticated', 'normal'];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '没有站长权限');

  const body = (await req.json().catch(() => null)) as {
    detail?: unknown;
    action?: unknown;
    targetGroup?: unknown;
    objectType?: unknown;
    objectId?: unknown;
  } | null;

  const detail = body && typeof body.detail === 'string' ? body.detail : '';
  if (!detail.trim()) return apiErr(400, '通知内容不能为空');

  const action = body && typeof body.action === 'string' ? body.action : undefined;
  const rawGroup = body && typeof body.targetGroup === 'string' ? body.targetGroup : 'all';
  const targetGroup = (GROUPS as string[]).includes(rawGroup)
    ? (rawGroup as TargetGroup)
    : 'all';
  const objectType = body && typeof body.objectType === 'string' ? body.objectType : null;
  const objectId = body && typeof body.objectId === 'string' ? body.objectId : null;

  const res = await broadcast({
    actor: user!,
    action,
    detail,
    targetGroup,
    objectType,
    objectId,
  });
  if (res.ok)
    return apiOk({ sent_count: res.sentCount, failed_count: res.failedCount }, res.message);
  return apiErr(res.code, res.message);
}
