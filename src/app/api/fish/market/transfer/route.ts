import { apiOk, apiErr } from '@/lib/format';
import { transferFish, findTransferTargetByUsername } from '@/lib/fish-market-service';
import { requireMarketActor } from '../_auth';

// fernet / node:crypto 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/market/transfer — 用户间转账（无手续费）。
//
// body: { to_user_id? | to_username?, amount, note?, username?, password? }
//
// 【两种鉴权】有会话 cookie → 当前登录用户；没有会话 → 请求体里的
// `username` + `password`（站外脚本「单次发包」，不签发会话）。详见 ../_auth.ts。
// 权限档位：登录（或凭据有效）+ 非禁言，**不要求 core+** —— 与 /fish 面板、签到同档。
//
// 【收款人两种写法】网页挑完人手里就是 id，用 `to_user_id`；站外脚本通常只有
// 用户名，用 `to_username`（精确匹配，同 /api/auth/login 的匹配口径）。
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return apiErr(400, '无效的请求');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const actor = await requireMarketActor(req, body);
  if (actor instanceof Response) return actor;

  let toUserId = typeof body.to_user_id === 'string' ? body.to_user_id.trim() : '';
  if (!toUserId) {
    const toUsername = typeof body.to_username === 'string' ? body.to_username.trim() : '';
    if (!toUsername) return apiErr(400, '请提供 to_user_id 或 to_username');
    const target = await findTransferTargetByUsername(toUsername);
    if (!target) return apiErr(404, '接收者不存在');
    toUserId = target.id;
  }

  // 与 feed 路由同款：数字或数字字符串都能收，其余（NaN / 非数字）交给 service 判 400。
  const amount = Number(body.amount);
  const note = typeof body.note === 'string' ? body.note : null;
  // 可选：调用方自带的幂等键（站外脚本「超时后用同键重试」的唯一安全手段）。
  const clientIdempotencyKey =
    typeof body.idempotency_key === 'string' ? body.idempotency_key : null;

  try {
    const res = await transferFish(actor.id, toUserId, amount, note, { clientIdempotencyKey });
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: res.duplicated
        ? `该笔已成交（重复请求，未重复扣款）：已转给 ${res.recipient.username} ${res.amount} 条小鱼干`
        : `已转给 ${res.recipient.username} ${res.amount} 条小鱼干`,
      amount: res.amount,
      balance: res.balance,
      recipient: { id: res.recipient.id, username: res.recipient.username },
      // 共享单号：发送方与接收方的两条流水带同一个值，双方据此对同一笔账。
      // 重放（duplicated）时回报的是原单的单号，不是一个新值。
      transfer_id: res.transferId,
      duplicated: !!res.duplicated,
    });
  } catch (e) {
    // 本地事务要么成要么不成（记账已无远端），能冒到这里的都是真故障。
    console.error('[fish-market] 转账异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
