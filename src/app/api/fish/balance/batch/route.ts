import { apiOk, apiErr } from '@/lib/format';
import { BALANCE_BATCH_MAX, getBalanceBatch } from '@/lib/fish-service';

// POST /api/fish/balance/batch — 公开接口，批量查询余额（对齐 /fish/api/balance/batch）。
// body: { user_ids: ["id1", "id2", ...] }
// 返回: { code: 200, balances: { id1: n, id2: m }, truncated: boolean }
//
// 【truncated 的语义】超过 BALANCE_BATCH_MAX 个 id 时服务层只查前 500 个：调用方
// 必须能分清「这个 id 没被查」与「这个 id 余额为 0」，否则对账会静默漏账。
// 截断本身仍回 200（向后兼容：老调用方忽略新字段即可）。
export async function POST(req: Request) {
  const data = await req.json().catch(() => null);
  if (!data || !('user_ids' in data)) {
    return apiErr(400, '请提供 user_ids 数组');
  }
  const userIds = (data as { user_ids: unknown }).user_ids;
  if (!Array.isArray(userIds)) {
    return apiErr(400, 'user_ids 必须是数组');
  }
  // 元素必须是字符串：数字 / null / 对象会被原样塞进 Prisma 的 `in`，客户端校验
  // 抛错 → 500。这是公开读口，畸形输入应当是 400，而不是「服务器开小差」。
  if (!userIds.every((id): id is string => typeof id === 'string')) {
    return apiErr(400, 'user_ids 的每一项都必须是字符串');
  }

  const balances = await getBalanceBatch(userIds);
  return apiOk({ balances, truncated: userIds.length > BALANCE_BATCH_MAX });
}
