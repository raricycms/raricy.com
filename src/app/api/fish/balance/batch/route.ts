import { apiOk, apiErr } from '@/lib/format';
import { getBalanceBatch } from '@/lib/fish-service';

// POST /api/fish/balance/batch — 公开接口，批量查询余额（对齐 /fish/api/balance/batch）。
// body: { user_ids: ["id1", "id2", ...] }
// 返回: { code: 200, balances: { id1: n, id2: m } }
export async function POST(req: Request) {
  const data = await req.json().catch(() => null);
  if (!data || !('user_ids' in data)) {
    return apiErr(400, '请提供 user_ids 数组');
  }
  const userIds = (data as { user_ids: unknown }).user_ids;
  if (!Array.isArray(userIds)) {
    return apiErr(400, 'user_ids 必须是数组');
  }

  const balances = await getBalanceBatch(userIds as string[]);
  return apiOk({ balances });
}
