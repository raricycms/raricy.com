import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { FOCUS_MODE_BLOCKED_TITLE } from '@/lib/focus-mode';
import { openPosition } from '@/lib/market-service';

// Prisma 与 node:crypto（幂等键派生）需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/fish/trade/buy — 练手盘开仓。
//
// body: { symbol, amount, leverage?, direction?, idempotency_key? }
//
// `direction`：`'long'`（缺省，向后兼容旧调用方）｜`'short'`。不认识的取值一律 400
//（不猜、不夹）。它对**仓位形状**的影响和杠杆一样大：空头的爆仓价在开仓价**上方**、
// 结算按「价格跌才赚」算，而这两件事都由服务端从这一列推导，前端只报方向本身。
//
// 【档位 = core+】与签到、投喂同档。练手盘是**签到之外第二条 core+ 赚取渠道** ——
// 它没有突破「非核心账号没有鱼干赚取渠道」这条口径，只是把 core+ 的路多开了一条。
// 所以两个页面（/fish/trade 与 /fish/trade/stats）与这里、以及 sell / quote / candles
// **六处**各判一次（页面与接口必须同档）。**加杠杆与加方向都没有新增第七处** ——
// 它们都只是 buy 的参数，档位与禁言的判定一个字都没变。别因为「做空更危险」就给
// 别处补一次禁言/档位判定：那会破坏下面那条六处不对称的口径。
//
// 【专注模式也在这六处判，但它是**全面封锁**，别照抄下面禁言的不对称】
// 开启专注模式的用户在看盘、下单、统计六处一律拿不到东西（含只读的 quote / candles
// 与统计页）。判据：专注是**本人一键可关**的偏好，不是被施加的状态 —— 挡掉只读口
// 不会把人困在仓位里（去设置里关掉即可，见 src/lib/focus-mode.ts），
// 而禁言只能等，所以禁言才必须留出「出仓」这条活路。
//
// 【不需要 core+ 的页面入口照样渲染】顶栏与 /fish 面板不对任何人藏入口，档不够的
// 用户点进来是 403（与签到、讨论一致，见 CLAUDE.md「入口不跟着藏」）。
//
// 【禁言只挡这一处】五处判定**不对称**：只有 buy 判禁言（禁言不开新仓），
// sell / quote / candles 与页面都只判档位（已开的仓必须能出、盘必须看得见）。
// 理由见 sell/route.ts 头部 —— 别为了「五处一样」把禁言判定补到那边去，
// 那等于让禁言变成锁仓。
// ⚠️ 强平（market-liquidator）同样**不判禁言** —— 禁言的人手上还开着的杠杆仓
// 照旧会被爆掉。别在那边补一个 `!isMuted`。
//
// 【幂等键由调用方给】开仓与转账不同：同一用户同一标的同一金额买两次是**正常操作**
// （分批建仓），服务端不能靠参数去重，必须由调用方在同一笔重试时复用同一个键。
// 前端在打开二次确认弹窗那一刻生成，失败时保留 → 重试拿到同一笔。
// ⚠️ **杠杆与方向都不进幂等键的派生**（`makeMarketIdempotencyKey` 只吃 user/symbol/units）：
// 同一个键重放时回报的是当初那一笔的真实倍数与真实方向（都从库里读），所以带着不同
// leverage / direction 重试同一个键不会买成两笔、也不会改掉已成交那笔的形状 ——
// 这正确，别去「补」它。把方向拼进键的后果是：同一笔重试时方向字段一抖动就变成**第二笔**，
// 两笔都成功、重复扣走 stake，而账本照样配平。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  // 专注模式：紧跟在档位之后。这条与下面那条禁言**都是「这个账号现在能不能用」**，
  // 顺序只决定「又禁言又开专注」时显示哪一句，两种顺序都不放行 —— 别把它读成判定的一部分。
  if (user.focusMode) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);
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
  // 杠杆与方向都**原样透传给 service**，不在这里解析 —— 区间/取值与报错文案都归它
  //（同 amount 的理由：service 里那些拒绝带着具体的用户可读文案）。
  const leverageRaw = body.leverage;
  const directionRaw = body.direction;
  const clientKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null;

  try {
    const res = await openPosition({
      userId: user.id,
      symbolRaw: body.symbol,
      amount,
      leverageRaw,
      directionRaw,
      clientKey,
    });
    if (!res.ok) return apiErr(res.code, res.message);

    // 文案随方向走：空头回「已买入」会让用户与策略都以为持了多单。
    // ⚠️ 多头那条**开头那三个字（「已买入」）是冻结的** —— tests/e2e 的 buyViaUI
    // 正拿它当「这一笔真的回来了」的信号，改它要同步改那个 helper。
    return apiOk({
      message: res.replayed
        ? '该笔已成交（重复请求，未重复扣款）'
        : `${res.position.direction === 'short' ? '已开空' : '已买入'} ${res.position.stake} 条小鱼干的 ${res.position.symbol}`,
      position: {
        id: res.position.id,
        symbol: res.position.symbol,
        // 方向、倍数与爆仓价都回给调用方：bot 与外部集成要能如实复述这一笔是什么。
        // ⚠️ `liquidation_price` 的语义随方向反转：空头那条线在开仓价**上方**，
        // 且 1× 空头**不是 0**（它在 2 × 开仓价归零）。别按「0 = 不会爆」去读它。
        direction: res.position.direction,
        stake: res.position.stake,
        entry_price: res.position.entryPrice,
        leverage: res.position.leverage,
        liquidation_price: res.position.liquidationPrice,
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
