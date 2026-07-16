import { castVote } from '@/lib/vote-service';
import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// POST /api/votes/:id/vote — 投票（需登录，唯一约束 + 原子自增，内存限频 voteHourly）
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { optionId?: unknown } | null;
  const optionId =
    body && (typeof body.optionId === 'number' || typeof body.optionId === 'string')
      ? Number(body.optionId)
      : NaN;
  if (!Number.isInteger(optionId)) return apiErr(400, '请选择一个选项');

  const res = await castVote(id, optionId, user.id);
  if ('rateLimited' in res) return apiErr(429, '投票频率过高，请稍后再试');
  if ('error' in res) return apiErr(res.status, res.error);

  return Response.json({ code: 200, message: '投票成功' });
}
