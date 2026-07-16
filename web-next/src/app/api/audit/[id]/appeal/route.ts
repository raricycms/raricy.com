// POST /api/audit/[id]/appeal — 对某条日志提交申诉（对齐 Flask /audit/appeals）
import { createAppeal } from '@/lib/audit-service';
import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await params;
  const logId = parseInt(id, 10);
  if (!Number.isInteger(logId) || logId <= 0) return apiErr(400, '无效的日志ID');

  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  const content = body && typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) return apiErr(400, '缺少参数');

  const res = await createAppeal({ logId, appellantId: user.id, content });
  if (res.ok) return apiOk({ appeal_id: res.appealId }, res.message);
  return apiErr(400, res.message);
}
