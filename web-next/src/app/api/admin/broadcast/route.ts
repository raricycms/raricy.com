// POST /api/admin/broadcast { detail, action?, targetGroup?, objectType?, objectId? }
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { broadcast, type TargetGroup } from '@/lib/broadcast-service';
import { apiOk, apiErr } from '@/lib/format';

const GROUPS: TargetGroup[] = ['all', 'authenticated', 'normal'];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

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
