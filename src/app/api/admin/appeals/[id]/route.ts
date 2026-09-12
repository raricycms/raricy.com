// POST /api/admin/appeals/[id] { decision:'accept'|'reject', note? } — 裁决申诉
//
// 权限：**仅站长**，对齐 Flask 的 decide_appeal（@admin_required + @owner_required）。
// 此前只判 hasAdminRights —— 申诉是对管理员权力的制衡，让管理员自己裁决申诉
// 等于把这道制衡取消掉（包括裁决针对自己那条操作的申诉）。
import { getCurrentUser, isOwner } from '@/lib/auth';
import { adjudicate } from '@/lib/admin-appeal-service';
import { apiOk, apiErr } from '@/lib/format';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return apiErr(403, '没有站长权限');

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
