// market-stats.ts — 练手盘的**个人统计**：把已结清的仓位行折成几组数
//
// 纯聚合（无数据库、无 I/O，单元用例不需要库）：读库那一段在 market-stats-service.ts；词表由调用方
// 传进来 —— 这里一旦 import MARKET_SYMBOLS 就会把 prisma 拖进单元用例。杠杆展示档只是「哪几个值恒定
// 占一行」的分组，不是合法集（合法集是 1–100 的整数）。
//
// ★ 四个数从哪来（每条都防一个静默错）★
// 盈亏 = payout_units − stake_units（库里没有盈亏列，这是权威算式；market-service 平仓路径也这么算）——
// 别改成从 fish_transactions 求和：强平不写流水、实发 0 的正常平仓也不写流水，按账本求和 = 盈亏偏
// 乐观、笔数与胜率偏小，而屏幕上一切正常。
// 判「已结清」用白名单 SETTLED_STATUSES，不是「状态不为 open」的写法：加第四个终态时后者会静默把它
// 算进胜率与盈亏（白名单的失败方向是「少算」，会被 count + incomplete === 该桶行数 的不变式抓住）。
// 拆解表的桶 = 展示档顺序在前、数据里多出来的 key 追加在后：只按展示档遍历会让展示档之外的 key 只进
// 总数不进拆解表（Σ bySymbol.realizedUnits === realizedUnits 钉着）；7×、37× 都靠这个 append 分支。
// 全程在**存储单位**（整数）上累加、一次都不换算：先换成鱼干再相加会掉浮点渣，负零会印在页面上。
//
// ★ 三分类与「没有」的三种写法 ★ 赢 / 输 / 平 = payout > stake / < stake / === stake，平局也进
// 分母。爆仓按 status 判（手动平一个跌穿爆仓价的仓位实发同样是 0，但那不是爆仓）。winRatePct 在
// 0 笔时是 null 而不是 0（「一场没赢」≠「还没打过」，0/0 是 NaN）。payoutUnits === null 不 ?? 0：
// 那会让「数据缺一块」和「真的全亏」长得一样；它进 incomplete 计数，页面据此出声。
//
// 设计背景与取舍：docs/market-design-notes.md §4

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
