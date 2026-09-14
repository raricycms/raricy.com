import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { transferFish } from '@/lib/fish-market-service';
import { AccountServiceError } from '@/lib/account-client';

// fernet / node:crypto 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/market/transfer { to_user_id, amount, note? } — 用户间转账（无手续费）。
//
// 【权限档位：登录 + 非禁言】**不要求 core+** —— 与 /fish 面板、签到同一档。
// 投喂要求 core+ 是因为它挂在博客页上（博客本身 core+ 才能看），转账是鱼干的
// 通用能力：任何能签到拿鱼干的人都该能转。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法转账');

  let toUserId: string;
  let amount: number;
  let note: string | null;
  try {
    const body = await req.json();
    if (typeof body !== 'object' || body === null) return apiErr(400, '无效的请求');
    toUserId = typeof body.to_user_id === 'string' ? body.to_user_id : '';
    // 与 feed 路由同款：数字或数字字符串都能收，其余（NaN / 非数字）交给 service 判 400。
    amount = Number(body.amount);
    note = typeof body.note === 'string' ? body.note : null;
  } catch {
    return apiErr(400, '请求体格式错误');
  }
  if (!toUserId) return apiErr(400, '请选择收款人');

  try {
    const res = await transferFish(user.id, toUserId, amount, note);
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: `已转给 ${res.recipient.username} ${res.amount} 条小鱼干`,
      amount: res.amount,
      balance: res.balance,
      recipient: { id: res.recipient.id, username: res.recipient.username },
    });
  } catch (e) {
    // 远端同步失败（fail-closed，本地已补偿回滚）→ 503，用户可重试。
    if (e instanceof AccountServiceError) return apiErr(503, '鱼干服务暂不可用，请稍后再试');
    console.error('[fish-market] 转账异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
