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
import { LEVERAGE_PRESETS } from './market-leverage';
import { MARKET_SYMBOLS } from './market-price';

/**
 * 某用户**已结清**（平仓 + 爆仓）的仓位统计。
 *
 * 展示档（标的 / 杠杆）取生产的单一真相源 —— 「加一个标的」照旧只改那四处，这里自动
 * 跟上；没交易过的标的与快捷档也会各占一行 0（那是「还没碰过」，有信息量）。
 *
 * ⚠️ **杠杆传的是 `LEVERAGE_PRESETS`（快捷档），而它自 2026-10 起不再是「合法集」**
 * —— 合法集是 1–100 的每一个整数。它在这里的作用只是「哪几个值恒定占一行」。
 * 用过的非快捷档倍数（7×、37×…）由 `summarizeMarket` 的 append 规则追加在表尾，
 * 所以 Σ 拆解表 === 总数**仍然成立**（见 market-stats.ts 的分桶规则）。
 * ⚠️ **别把它改成硬编码的 1..100** —— 那会让统计页渲染 100 行 0。
 * ⚠️ 也别改成空数组：那会丢掉「没碰过的快捷档也占一行」这个产品语义。
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
  return summarizeMarket(rows, { symbols: MARKET_SYMBOLS, leverages: LEVERAGE_PRESETS });
}
