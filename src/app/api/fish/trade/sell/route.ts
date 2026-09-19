import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { AccountServiceError } from '@/lib/account-client';
import { closePosition } from '@/lib/market-service';

// fernet / node:crypto 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/trade/sell — 练手盘平仓（整仓）。
//
// body: { position_id }
//
// 【没有幂等键，这是刻意的】平仓天生幂等：仓位一旦 closed，再平就是重放（服务端
// 回读当初结算的 payoutUnits 原样回报，不动钱）。重复提交不会多发钱，
// 所以这里比 buy 少一个参数 —— 别顺手加一个「为了对称」。
//
// 【档位同上】core+，与 buy 和页面各判一次（页面与接口必须同档）。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法使用练手盘');

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

  const positionId = typeof body.position_id === 'string' ? body.position_id.trim() : '';
  if (!positionId) return apiErr(400, '缺少 position_id');

  try {
    const res = await closePosition({ userId: user.id, positionId });
    if (!res.ok) return apiErr(res.code, res.message);

    const sign = res.profit > 0 ? '+' : '';
    return apiOk({
      message: res.replayed
        ? '该仓位已经卖过了（重复请求，未重复结算）'
        : `已卖出 ${res.symbol}，${sign}${res.profit} 条小鱼干`,
      position_id: res.positionId,
      symbol: res.symbol,
      payout: res.payout,
      profit: res.profit,
      exit_price: res.exitPrice,
      balance: res.balance,
      replayed: !!res.replayed,
    });
  } catch (e) {
    if (e instanceof AccountServiceError) return apiErr(503, '鱼干服务暂不可用，请稍后再试');
    console.error('[market] 平仓异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
