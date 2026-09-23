import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { openPosition } from '@/lib/market-service';

// Prisma 与 node:crypto（幂等键派生）需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/trade/buy — 练手盘开仓。
//
// body: { symbol, amount, idempotency_key? }
//
// 【档位 = core+】与签到、投喂同档。练手盘是**签到之外第二条 core+ 赚取渠道** ——
// 它没有突破「非核心账号没有鱼干赚取渠道」这条口径，只是把 core+ 的路多开了一条。
// 所以页面（/fish/trade）与这里、以及 sell / quote / candles **五处**各判一次
//（页面与接口必须同档）。
//
// 【不需要 core+ 的页面入口照样渲染】顶栏与 /fish 面板不对任何人藏入口，档不够的
// 用户点进来是 403（与签到、讨论一致，见 CLAUDE.md「入口不跟着藏」）。
//
// 【禁言只挡这一处】五处判定**不对称**：只有 buy 判禁言（禁言不开新仓），
// sell / quote / candles 与页面都只判档位（已开的仓必须能出、盘必须看得见）。
// 理由见 sell/route.ts 头部 —— 别为了「五处一样」把禁言判定补到那边去，
// 那等于让禁言变成锁仓。
//
// 【幂等键由调用方给】开仓与转账不同：同一用户同一标的同一金额买两次是**正常操作**
// （分批建仓），服务端不能靠参数去重，必须由调用方在同一笔重试时复用同一个键。
// 前端在打开二次确认弹窗那一刻生成，失败时保留 → 重试拿到同一笔。
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

  // 金额只做 Number()：NaN / 非数字 / 小数位交给 service 判 400（与 transfer 路由同款）。
  // ⚠️ 别在这里把参数校验做一半 —— service 里那些拒绝带着具体的用户可读文案。
  const amount = Number(body.amount);
  const clientKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null;

  try {
    const res = await openPosition({
      userId: user.id,
      symbolRaw: body.symbol,
      amount,
      clientKey,
    });
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: res.replayed
        ? '该笔已成交（重复请求，未重复扣款）'
        : `已买入 ${res.position.stake} 条小鱼干的 ${res.position.symbol}`,
      position: {
        id: res.position.id,
        symbol: res.position.symbol,
        stake: res.position.stake,
        entry_price: res.position.entryPrice,
        opened_at: res.position.openedAt.toISOString(),
      },
      balance: res.balance,
      replayed: !!res.replayed,
    });
  } catch (e) {
    // 本地事务要么成要么不成（记账已无远端），能冒到这里的都是真故障。
    console.error('[market] 开仓异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
