// ─────────────────────────────────────────────────────────────────────────────
// market-stats-service.ts — 练手盘个人统计的**读路径**（取数一段）
//
// 聚合那一段在 `market-stats.ts`（纯函数、脱库可测）；这里只负责把那个人的已结清
// 仓位捞出来、连同白名单一起交过去。分两层是因为纯逻辑不该为了跑用例而拉起 Prisma。
//
// ★ 盈亏的唯一来源是这一张表：`payout_units − stake_units`。★
//   ⚠️ **别改成从 `fish_transactions` 求和**（那不是「另一种口径」，是错的）：
//   · 强平**不写流水**（实发恒为 0，没有钱动过）；
//   · 实发为 0 的正常平仓**也不写流水**（同一档理由）；
//   · 迁移前的平仓流水在远端、本地根本没有。
//   按账本求和 = 盈亏偏乐观、笔数与胜率偏小 —— 而屏幕上一切正常，只是数字不对。
//   （`fish_transactions` 里有 `market_buy` / `market_sell` 两类，流水页按它筛选是
//   对的；**统计不是它的事**。）
//
// 【为什么不 take / 不分页】take 会把总数静默算小，而统计页上「少了几笔」没有任何
//   症状。量级上界由 `RULES.tradeDaily`（300 笔/天）兜着，5 列 × 万行的 findMany
//   在单进程站点上可接受；真到了要改成 SQL 聚合那天，判据是**新的 SQL 必须逐位重现
//   `summarizeMarket`，而那组用例一个字都不许改**（那时的对照表就是今天这份单测）。
//
// 【why 不加 orderBy】聚合与顺序无关。而这个页面的「按时间」只体现在持仓快照上
//   （那一份来自展示缓存，不查库）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { SETTLED_STATUSES, summarizeMarket, type MarketStats } from './market-stats';
import { ALL_LEVERAGES } from './market-service';
import { MARKET_SYMBOLS } from './market-price';

/**
 * 某用户**已结清**（平仓 + 爆仓）的仓位统计。
 *
 * 白名单（标的 / 杠杆）取生产的单一真相源 —— 「加一个标的」照旧只改那四处，这里自动
 * 跟上；没交易过的标的与杠杆也会各占一行 0（那是「还没碰过」，有信息量）。
 *
 * ⚠️ **杠杆传的是 ALL_LEVERAGES（并集），不是 LEVERAGE_OPTIONS。** 白名单分了两组
 * （阶梯 + 彩票档），只传阶梯那一组的话，彩票档的仓位会**只进总数、不进拆解表** ——
 * 拆解表之和于是与总数对不上，而页面上不会有任何东西提示这一点（与「改过
 * MARKET_SYMBOLS 之后残留的旧仓」是同一个陷阱，见 market-stats.ts 的分桶规则）。
 */
export async function getMarketStats(userId: string): Promise<MarketStats> {
  const rows = await prisma.marketPosition.findMany({
    // 白名单而不是 `{ not: 'open' }` —— 加第四个终态时不会静默把它算进胜率，理由见
    // market-stats.ts 文件头
    where: { userId, status: { in: [...SETTLED_STATUSES] } },
    select: {
      symbol: true,
      leverage: true,
      status: true,
      stakeUnits: true,
      payoutUnits: true,
    },
  });
  return summarizeMarket(rows, { symbols: MARKET_SYMBOLS, leverages: ALL_LEVERAGES });
}
