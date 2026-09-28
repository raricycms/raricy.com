import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { FOCUS_MODE_BLOCKED_TITLE } from '@/lib/focus-mode';
import { closePosition } from '@/lib/market-service';

// Prisma 与 node:crypto 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/trade/sell — 练手盘平仓（整仓）。
//
// body: { position_id }
//
// 【没有幂等键，这是刻意的】平仓天生幂等：仓位一旦 closed，再平就是重放（服务端
// 回读当初结算的 payoutUnits 原样回报，不动钱）。重复提交不会多发钱，
// 所以这里比 buy 少一个参数 —— 别顺手加一个「为了对称」。
//
// 【档位同上】core+，与 buy / quote / candles / 两个页面各判一次（页面与接口必须同档）。
//
// ── ★ 禁言不挡平仓（与 buy 刻意不同）★ ──────────────────────────────────────
// 禁言是「不能说话」，不该顺带变成「不能止损」。被禁言期间行情照走，若这里也判
// isCurrentlyBanned，用户手上**已经开着的**仓位就一股也卖不掉 —— 他只能看着浮亏
// 扩大，且没有自救手段（禁言还会递增 sessionVersion 把旧会话全废，重新登录也一样）。
// 所以六处的**禁言**判定不对称，别顺手「统一」：
//   buy     —— core+ **且**未禁言（禁言不开新仓，也就没有新的赚取）
//   sell    —— 只判 core+（已开的仓必须能出）
//   quote   —— 只判 core+（只读展示，且下面这个弹窗的「预计到手」要用它）
//   candles —— 只判 core+（只读展示；禁言用户更得看得见图才好决定止损）
//   两个页面 —— 只判 core+（入口不跟着藏，点了买入才拿 403）
// 代价是禁言用户仍能兑现**已有**仓位的浮盈 —— 那是「能出仓」的另一面，不是漏洞。
// 真要断掉一个人的鱼干路，用的是封号，不是把人锁在仓位里。
// 页面 /fish/trade 照旧不藏入口（点了买入才拿 403），与签到、讨论同款。
//
// ⚠️ 上面这张表**只讲禁言**。专注模式不做这种不对称：开启者在六处一律拿不到东西
// （含只读的 quote / candles 与统计页）—— 理由是专注本人一键可关，不会把人困住。
// 别把这张表当成「新判定该长什么样」的模板。见 buy 路由头部。
//
// 【杠杆加进来之后这条依然成立，而且更要紧】强平引擎（market-liquidator）同样
// **不判禁言** —— 一个被禁言的人手上还开着的杠杆仓照旧会被爆掉，他也能自己平掉。
// 反过来才是灾难：禁言 + 不能出仓 = 眼睁睁看着浮亏扩大还不能止损（而且禁言会递增
// sessionVersion 废掉旧会话，重新登录也一样）。这条判据在 buy/sell/强平三处一致。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  // 专注模式挡平仓，这与上面「禁言不挡平仓」不矛盾 —— 别顺着那条推论给这里开个口子：
  // 禁言的活路来自「他只能等，所以必须留出出仓的路」；专注是他自己一键可关的偏好。
  if (user.focusMode) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);

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
    // ⚠️ **爆仓的仓位走到这里也是「成功」**，而且 payout 是 0。三种文案要分开：
    //   liquidated → 如实说爆了（用户可能是「看到跌穿了、点卖出」才发现早就爆了，
    //                这时回一句「已卖出，-100 条小鱼干」会让他以为是自己卖掉的）
    //   replayed   → 「已经卖过了」
    //   其余        → 正常成交
    // 别把 liquidated 并进 replayed 那一档里 —— 它是「你没卖成，是系统平的」。
    const message = res.liquidated
      ? '该仓位已爆仓（保证金归零，强平已结清）'
      : res.replayed
        ? '该仓位已经卖过了（重复请求，未重复结算）'
        : `已卖出 ${res.symbol}，${sign}${res.profit} 条小鱼干`;
    return apiOk({
      message,
      position_id: res.positionId,
      symbol: res.symbol,
      payout: res.payout,
      profit: res.profit,
      exit_price: res.exitPrice,
      liquidated: !!res.liquidated,
      balance: res.balance,
      replayed: !!res.replayed,
    });
  } catch (e) {
    // 本地事务要么成要么不成（记账已无远端），能冒到这里的都是真故障。
    console.error('[market] 平仓异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
