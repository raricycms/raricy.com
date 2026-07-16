// POST /api/admin/appeals/[id] { decision:'accept'|'reject', note? } — 裁决申诉
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { adjudicate } from '@/lib/admin-appeal-service';
import { apiOk, apiErr } from '@/lib/format';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const { id } = await ctx.params;
  const appealId = parseInt(id, 10);
  if (!Number.isInteger(appealId) || appealId <= 0) return apiErr(400, '无效的申诉ID');

  const body = (await req.json().catch(() => null)) as {
    decision?: unknown;
    note?: unknown;
  } | null;
  const decision = body && typeof body.decision === 'string' ? body.decision : '';
  const note = body && typeof body.note === 'string' ? body.note : '';
  if (decision !== 'accept' && decision !== 'reject') return apiErr(400, '无效处理结果');

  const res = await adjudicate({ actor: user!, appealId, decision, note });
  if (res.ok) return apiOk({}, res.message);
  return apiErr(res.code, res.message);
}
