// ─────────────────────────────────────────────────────────────────────────────
// market-stats.ts — 练手盘的**个人统计**：把已结清的仓位行折成几组数
//
// 【为什么单独一个模块】这里全是纯算术，`tests/unit/market-stats.test.ts` 不需要
// 数据库就能跑；而读库那一段在 `market-stats-service.ts`。与 market-math /
// market-chart 同一个分工：纯逻辑住零依赖模块，I/O 住外面。
//
// 【词表由调用方传进来，这里刻意不 import】`MARKET_SYMBOLS` 住在 market-price.ts、
// 杠杆的展示档住在 market-leverage.ts。这个模块一旦 import 它们，单元用例就会跟着把
// 别的依赖（`MARKET_SYMBOLS` 那条会拖进 prisma）拉起来。所以口径是：这里只管「怎么折」，
// 展示档由 `summarizeMarket` 的第二个参数给。
// ⚠️ 杠杆自 2026-10 起是 **1–100 自由输入**，所以那个参数**不再是「合法集」**，
// 只是「哪几个值恒定占一行」的展示分组（见下面拆解表那一段）。
//
// ── 四个数从哪来（每条都防一个静默错）────────────────────────────────────────
//
// ★ 盈亏 = `payout_units − stake_units`。★
//   库里**没有**盈亏列，这就是权威算式（`market-service.ts` 的平仓路径当场也是这么算的）。
//   ⚠️ **别改成从 `fish_transactions` 求和**（那是错的，不是「另一种口径」）：强平**不写
//   流水**、实发为 0 的正常平仓**也不写流水**（没有钱动过），而迁移前的平仓流水在远端、
//   本地根本没有。按账本求和 = 盈亏偏乐观、笔数与胜率偏小，而屏幕上一切正常。
//
// ★ 判「已结清」用白名单 `SETTLED_STATUSES`，不是 `status !== 'open'`。★
//   两种写法今天等价，失败方向却不同：加第四个终态时（比如 `cancelled`，语义多半不是
//   「用户赌输了」），`not: 'open'` 会**静默把它算进胜率与盈亏**；而万一那一行的
//   `payout_units` 是 null，它会长得跟一次真爆仓一模一样。白名单的失败方向是「少算」，
//   而那会被下面这条不变式当场抓住。
//
// ★ 拆解表的桶 = 展示档顺序在前，数据里多出来的 key 追加在后。★
//   只按展示档遍历的话，**展示档之外的 key** 会只进总数、不进拆解表 —— 「拆解表之和 ≠
//   累计盈亏」两个数并排放在一屏里，谁也不会去加它。用例钉着
//   `Σ bySymbol.realizedUnits === realizedUnits`。
//   ⚠️ 这条规则在做空 + 自由杠杆之后**更要紧了**：杠杆是 1–100 的任意整数，7×、37×
//   都是**正常值**（不再是「白名单外 / 旧仓」那种异常），它们全靠这个 append 分支才
//   进得了表。**别把它「优化」成只 map(展示档)** —— 那会让用过的非展示档倍数静默消失
//   在拆解表里，而总数不变、Σ 对不上也没人加。
//
// ★ 全程在**存储单位**（整数）上累加，一次都不换算。★
//   逐行先换成「鱼干」再相加会掉浮点渣，而 `(-0.00004).toFixed(4)` 是 **'-0.0000'** ——
//   一个负零会直接印在页面上。整数相加天然精确，换算只留页面那一处。
//
// ── 三分类与「没有」的三种写法 ───────────────────────────────────────────────
//
//   · 赢 / 输 / 平 = `payout > stake` / `< stake` / `=== stake`，**平局也进分母**
//     （费率 0.02% 下「刚好吃平」真的会发生，只是窄）。
//   · 爆仓**按 `status` 判**，不按 `payout === 0` 判：手动平一个跌穿爆仓价的杠杆仓
//     实发同样是 0（market-math.ts 头部那个「同一个 max(0,…)」），但它不是爆仓。
//   · `winRatePct` 在 0 笔时是 `null` 而不是 0 —— 「一场没赢」与「还没打过」不是一回事，
//     而且 `0/0` 是 NaN，`NaN.toFixed(1)` 会在页面上印出「NaN%」。
//   · `payoutUnits === null`（库里有异常）**不 `?? 0`**：那会让「数据缺一块」和「真的
//     全亏」长得一模一样。它进 `incomplete` 计数，页面据此出声（不变式：
//     `count + incomplete === 该桶行数`）。
// ─────────────────────────────────────────────────────────────────────────────

import { settleClose } from './market-math';
// 只取类型（方向词表零依赖，但这里不需要它的值 —— 本模块要保持脱库可测）。
import type { Direction } from './market-leverage';

/**
 * 「已结清」的**白名单**。加终态时先改这里，再改 `market-stats-service.ts` 的 where
 * 与 `docs/architecture.md` §6.13 —— 用例会先红，报错会提醒这三处。
 */
export const SETTLED_STATUSES = ['closed', 'liquidated'] as const;
export type SettledStatus = (typeof SETTLED_STATUSES)[number];

/** 爆仓那一档。**它是 `status` 而不是「实发为 0」**，见文件头。 */
export const LIQUIDATED_STATUS: SettledStatus = 'liquidated';

/** 统计只吃这几列 —— 给的是 Prisma 的 select 形状，多一列都不需要。 */
export interface SettledRow {
  symbol: string;
  leverage: number;
  /** `closed` | `liquidated`（白名单外的值不进来，见 SETTLED_STATUSES） */
  status: string;
  /** 投入，**存储单位**（1 单位 = 0.0001 鱼干） */
  stakeUnits: number;
  /** 结算那一刻写下的实发，**存储单位**。爆仓行恒为 0；null = 数据异常 */
  payoutUnits: number | null;
}

interface Tally {
  /** payout 已知的笔数 */
  count: number;
  /** payout 缺失的行数（见文件头最后一节） */
  incomplete: number;
  wins: number;
  losses: number;
  /** 实发与投入恰好相等 —— 既不算赢也不算输，但**进胜率的分母** */
  flats: number;
  liquidated: number;
  stakeUnits: number;
  payoutUnits: number;
  realizedUnits: number;
}

export interface StatBucket extends Tally {
  /** 标的原始名（`BTCUSDT`）或杠杆（`'2'`）。标签由调用方渲染，这里不认币名 */
  key: string;
  /** 胜率**百分比数值**（0–100，不是 0–1）。0 笔时是 `null`，页面显示「—」 */
  winRatePct: number | null;
}

export interface MarketStats extends Tally {
  winRatePct: number | null;
  bySymbol: StatBucket[];
  byLeverage: StatBucket[];
}

/** 一条已结清持仓的浮动盈亏估算（页面用现价算出来的那份）。全部是**存储单位**。 */
export interface OpenEstimate {
  payoutUnits: number;
  /** 实发 − 投入，可能为负。穿过爆仓价时恰好是 `-stakeUnits`（亏光投入） */
  profitUnits: number;
  /**
   * 现价已经**穿过**这条仓位的爆仓价 —— 下一轮扫描就会被强平。
   * ⚠️ 方向词要跟着方向：多头是「**跌**到爆仓价之下」，空头是「**涨**到之上」。
   * **1 倍多头**恒为 false（它的爆仓价是 0，价格到不了 0 以下）；**1 倍空头不恒为 false**
   * —— 它在价格翻倍时归零，是个可达的价。
   */
  belowLiquidation: boolean;
}

function emptyTally(): Tally {
  return {
    count: 0,
    incomplete: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    liquidated: 0,
    stakeUnits: 0,
    payoutUnits: 0,
    realizedUnits: 0,
  };
}

function addRow(t: Tally, row: SettledRow): void {
  // ⚠️ 顺序：先判 null 再累加。`?? 0` 会让异常行伪装成「全亏」（见文件头）
  if (row.payoutUnits == null) {
    t.incomplete += 1;
    return;
  }
  const stake = row.stakeUnits;
  const payout = row.payoutUnits;
  t.count += 1;
  t.stakeUnits += stake;
  t.payoutUnits += payout;
  t.realizedUnits += payout - stake;
  if (payout > stake) t.wins += 1;
  else if (payout < stake) t.losses += 1;
  else t.flats += 1;
  if (row.status === LIQUIDATED_STATUS) t.liquidated += 1;
}

/** 收口：算胜率。**只在这一处算** —— `count === 0` 时给 null，绝不给 NaN。 */
function finalize(t: Tally): Omit<StatBucket, 'key'> {
  return { ...t, winRatePct: t.count === 0 ? null : (t.wins / t.count) * 100 };
}

/**
 * 桶键：**白名单顺序在前，数据里多出来的 key 按首次出现顺序追加在后**。
 * 理由见文件头（旧标的的仓位只进总数不进拆解表 = 两个数并排说谎）。
 */
function bucketKeys(whitelist: readonly (string | number)[], extras: Iterable<string>): string[] {
  const out = whitelist.map(String);
  const seen = new Set(out);
  for (const k of extras) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 把已结清的仓位行折成总览 + 两张拆解表。
 *
 * @param universes **展示档**（`MARKET_SYMBOLS` / `LEVERAGE_PRESETS`）—— 由调用方给，
 *   这样「加一个标的/快捷档」照旧只改那一处单一真相源，这里不用动。
 *   ⚠️ 杠杆那边它**不是合法集**（合法集是 1–100 的整数）：它只决定哪几个值恒定占一行。
 */
export function summarizeMarket(
  rows: readonly SettledRow[],
  universes: { symbols: readonly string[]; leverages: readonly number[] }
): MarketStats {
  const total = emptyTally();
  const bySymbolRaw = new Map<string, Tally>();
  const byLeverageRaw = new Map<string, Tally>();

  for (const row of rows) {
    addRow(total, row);
    const symbolTally = bySymbolRaw.get(row.symbol) ?? emptyTally();
    addRow(symbolTally, row);
    bySymbolRaw.set(row.symbol, symbolTally);
    const levKey = String(row.leverage);
    const levTally = byLeverageRaw.get(levKey) ?? emptyTally();
    addRow(levTally, row);
    byLeverageRaw.set(levKey, levTally);
  }

  const bucket = (raw: Map<string, Tally>, key: string): StatBucket => ({
    key,
    ...finalize(raw.get(key) ?? emptyTally()),
  });

  return {
    ...finalize(total),
    bySymbol: bucketKeys(universes.symbols, bySymbolRaw.keys()).map((k) => bucket(bySymbolRaw, k)),
    byLeverage: bucketKeys(universes.leverages, byLeverageRaw.keys()).map((k) =>
      bucket(byLeverageRaw, k)
    ),
  };
}

/**
 * 一条**还没平**的仓位的浮动盈亏 —— 「现在按这个价卖掉能拿回多少」。
 *
 * 走 `settleClose`（结算公式的唯一实现），于是它与卖出弹窗里的「预计到手」、
 * 与 `/fish/trade` 持仓行上的那个数是**同一个数**（同一份手续费口径：平仓侧收一次）。
 * ⚠️ 自己抄一遍公式 = 屏幕上同一笔仓位在两页显示两个数，而两个看起来都合理。
 *
 * ⚠️ **缺价就别调用它**（调用方判 null）：一个「返回 null」的签名会被 `?? 0` 勾走，
 * 而 `?? 0` 在这里的意思是「浮亏 100%」，那是编出来的。
 *
 * 三个必填参数与 market-math 同一条纪律：`leverage` / `feeRate` 忘传会静默按 1 倍、
 * 按 0 费率算，而屏幕上那个数看着完全合理。
 */
export function estimateOpenPosition(input: {
  /** 投入，存储单位 */
  stakeUnits: number;
  entryPrice: number;
  /** **这一笔**的方向（不是下单选择器那个 —— 选择器只管下一笔）。**必填** */
  direction: Direction;
  /** **这一笔**的杠杆（不是下单选择器那个 —— 选择器只管下一笔） */
  leverage: number;
  /** 读仓位行上存着的那一列，**别自己拿开仓价乘一遍** */
  liquidationPrice: number;
  /** 现价（展示缓存价） */
  exitPrice: number;
  feeRate: number;
}): OpenEstimate {
  const settled = settleClose({
    stakeUnits: input.stakeUnits,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    feeRate: input.feeRate,
    leverage: input.leverage,
    direction: input.direction,
  });
  // 穿线方向随方向走（多头 ≤、空头 ≥），与强平引擎的判据**必须同款**：
  // 两处对同一笔仓位的陈述分了家的话，页面会显示一个「看起来正常」的浮亏，而引擎
  // 下一秒就把它清掉。`> 0` 那道守卫挡的是 **1 倍多头**（爆仓价 0 = 那条线不存在）；
  // 空头的爆仓价恒 > 0，这道守卫对它天然为真。
  const belowLiquidation =
    input.liquidationPrice > 0 &&
    (input.direction === 'short'
      ? input.exitPrice >= input.liquidationPrice
      : input.exitPrice <= input.liquidationPrice);
  return {
    payoutUnits: settled.payoutUnits,
    profitUnits: settled.payoutUnits - input.stakeUnits,
    belowLiquidation,
  };
}

/**
 * 持仓浮动盈亏**合计**。
 *
 * 【空数组 → 0，缺价 → null】两者刻意不同：
 *   · 没有持仓 = 0 是**一个完整的答案**；
 *   · 有持仓但有一行取不到价 = **不知道**，必须整体显示「—」——不然那个合计会看着
 *     像一个完整的数，而它少算了一笔。
 */
export function sumProfitUnits(estimates: readonly (OpenEstimate | null)[]): number | null {
  let sum = 0;
  for (const e of estimates) {
    if (!e) return null;
    sum += e.profitUnits;
  }
  return sum;
}
