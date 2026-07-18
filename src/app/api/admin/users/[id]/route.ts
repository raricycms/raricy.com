// /api/admin/users/[id]
//   PATCH  { role }                       — 变更角色（涉及 owner 需站长）
//   POST   { action:'ban', hours, reason } — 禁言
//   POST   { action:'unban', reason? }     — 解除禁言
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { setRole, banUser, unbanUser } from '@/lib/admin-user-service';
import { apiOk, apiErr } from '@/lib/format';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { role?: unknown } | null;
  const role = body && typeof body.role === 'string' ? body.role : '';
  if (!role) return apiErr(400, '缺少角色参数');

  const res = await setRole({ actor: user!, targetId: id, newRole: role });
  if (res.ok) return apiOk({ role: res.role }, res.message);
  return apiErr(res.code, res.message);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    hours?: unknown;
    reason?: unknown;
  } | null;
  const action = body && typeof body.action === 'string' ? body.action : '';
  const reason = body && typeof body.reason === 'string' ? body.reason : '';

  if (action === 'ban') {
    const hours = Number(body?.hours);
    const res = await banUser({ actor: user!, targetId: id, hours, reason });
    if (res.ok) return apiOk({ ban_id: res.banId }, res.message);
    return apiErr(res.code, res.message);
  }

  if (action === 'unban') {
    const res = await unbanUser({ actor: user!, targetId: id, reason });
    if (res.ok) return apiOk({}, res.message);
    return apiErr(res.code, res.message);
  }

  return apiErr(400, '无效的操作');
}
