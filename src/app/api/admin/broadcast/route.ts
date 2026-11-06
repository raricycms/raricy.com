// POST /api/admin/broadcast { detail, action?, targetGroup?, objectType?, objectId? }
//
// 权限：**仅站长**。群发一次触达全站，是本站影响面最大的操作 ——
// 因此路由与 service 层各判一次，只对站长放开。
// 此前这里只判 hasAdminRights，任何管理员都能给全站发通知，故收紧到站长一档。
import { getCurrentUser, isOwner } from '@/lib/auth';
import { broadcast } from '@/lib/broadcast-service';
import { isTargetGroup, type TargetGroup } from '@/lib/broadcast-groups';
import { apiOk, apiErr } from '@/lib/format';

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
  // 缺省（未传 / null / 空串）仍按 'all'，保持既有调用方；**非空且非法**一律 400。
  // 不能回落 all：一次参数拼错 = 一条发错对象、不可撤回的全站打扰（R3-417）。
  const rawGroup = body?.targetGroup;
  let targetGroup: TargetGroup = 'all';
  if (rawGroup !== undefined && rawGroup !== null && rawGroup !== '') {
    if (!isTargetGroup(rawGroup)) return apiErr(400, '无效的目标用户组');
    targetGroup = rawGroup;
  }
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
