import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getCandles, parseSymbol } from '@/lib/market-price';
import { displaySymbol } from '@/lib/market-service';
import { DEFAULT_INTERVAL, parseInterval } from '@/lib/market-candles';

// 有 GET，且读 cookie（getCurrentUser）—— 显式声明动态，别让 Next 试图静态化。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/fish/trade/candles?symbol=BTCUSDT&interval=1h — 图表的 K 线。
//
// 【★ 它和 quote 一样是**展示**，绝不可用于成交 ★】数据来自 globalThis 那份
// 60 秒保鲜的 K 线缓存（见 src/lib/market-price.ts）。成交价只有 `fetchQuote()`
// 一条路，由 buy / sell 在服务端现取。这个接口存在的意义是「切标的/切周期时
// 别让每个访客各自去打一次行情源」。
//
// 【非法周期不静默退回默认档】参数过白名单，不在名单里就 400。退回默认档会让
// 「我点的是 4h、画出来的是 1h」这种假象活下来 —— 图上一切正常，只有数据不对。
//
// 【ok 的含义：有没有数据可画】上游这次拉不到、但缓存里有上一次成功那份时，
// 照给那份并置 ok:true —— K 线不是价格，它没有「新鲜度」这一档：右端那根永远被
// 页面上的展示价并线顶着（见 useCandles），而左边不长出新柱子是**可见的**、
// 也是诚实的（没有数据就是没有数据，不编一根出来）。真的一根都没有才 ok:false，
// 页面显示「K 线暂不可用」+ 重试钮。
//
// 【不判禁言】与 quote / sell 同侧：禁言是「不能说话」，不该顺带变成「不能看盘」
// —— 他恰恰要靠这张图决定要不要止损。五处判定不对称的完整理由见 sell 路由头部。
//
// 【为什么不限频】上游键空间被钉死在 2 标的 × 6 周期 = 12（缓存键里没有别的维度），
// 配 60 秒缓存 → **进程级的上游请求量有界，且与访客数无关**；这条路由没有写路径、
// 没有副作用、响应体有界（≤1000 根 ≈ 50KB）。而被每标签页 1 次/秒地打的
// `/quote` 从来不限频 —— 给「切一次周期才拉一次」的接口上闸、放着那条裸奔，是不自洽的。
// 真要加，得新开一条 RULES（自带桶键前缀，别蹭 trade:）并同步 docs/bot/。
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const params = new URL(req.url).searchParams;
  const symbol = parseSymbol(params.get('symbol'));
  if (!symbol) return apiErr(400, '不支持的标的');

  // 不带 interval 就用默认档（页面首屏就是不带参数的那一次）；带了就必须在白名单里
  const raw = params.get('interval');
  const interval = raw === null ? DEFAULT_INTERVAL : parseInterval(raw);
  if (!interval) return apiErr(400, '不支持的周期');

  const candles = await getCandles(symbol, interval);

  return apiOk({
    ok: candles.length > 0,
    symbol,
    display: displaySymbol(symbol),
    interval,
    // 六元组的线上形状见 src/lib/market-candles.ts 的 CandleTuple
    candles,
  });
}
