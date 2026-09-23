import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getCachedQuotes } from '@/lib/market-price';
import { MARKET_FEE_RATE, MIN_STAKE_FISH, displaySymbol } from '@/lib/market-service';

// 有 GET，且读 cookie（getCurrentUser）—— 显式声明动态，别让 Next 试图静态化。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/fish/trade/quote — 练手盘的**展示**行情，页面轮询它。
//
// 【★ 它给的是缓存价，绝不用于成交 ★】成交价由 buy / sell 在服务端现取
// （见 src/lib/market-price.ts 的文件头）。这个接口存在的意义只是「别让每个访客
// 各自去打一次行情源」—— 前台拿着它渲染，下单时前端**不传价**，价格完全由服务端定。
//
// 【拉不到就如实说】缓存空且当次刷新也失败时返回 ok:false + 空数组，
// 页面显示「行情暂不可用」。**绝不编一个价出来** —— 用户会照着一个假价格按下买入。
//
// 【不判禁言】只读展示。挡了它，禁言用户虽然卖得掉仓位，但页面上的价会冻在进页面
// 那一刻（轮询被 403、面板静默丢弃），卖出弹窗里的「预计到手」就是拿一个旧价算的
// —— 那正是这个功能最不能有的东西。五处判定不对称的理由见 sell 路由头部。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { quotes, ok } = await getCachedQuotes();

  return apiOk({
    ok,
    quotes: quotes.map((q) => ({
      symbol: q.symbol,
      display: displaySymbol(q.symbol),
      price: q.price,
      change_percent: q.changePercent,
      // 页面据此显示「数据可能不是最新的」—— 陈旧时不要假装它是实时价
      stale: q.stale,
      age_ms: q.ageMs,
      // stream = 常驻 WS 那一帧（~50ms），poll = 15 秒的 REST 轮询。
      // **只给排障用，页面不渲染它** —— 想知道「流现在活没活着」，以前只能翻日志。
      source: q.source,
    })),
    fee_rate: MARKET_FEE_RATE,
    min_stake: MIN_STAKE_FISH,
  });
}
