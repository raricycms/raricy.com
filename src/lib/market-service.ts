// ─────────────────────────────────────────────────────────────────────────────
// market-service.ts — 鱼干练手盘的开仓 / 平仓
//
// 【这是什么】用户投鱼干买入一个**绑定真实加密价格**的仓位，价格涨跌直接决定他能
// 拿回多少鱼干。**不是交易所，也不是庄家对赌**：没有撮合、没有对手盘、没有敞口。
//
//   开仓：条件扣减 N 单位鱼干 + 一条 market_buy 流水（负），建一行 position。
//         **做多**（`long`，默认）｜**做空**（`short`）—— 方向决定爆仓价在开仓价的哪一侧。
//   平仓：payoutUnits 由 market-math.ts 的 settleClose 算（页面上的「预计到手」用的是
//         同一个函数）。**做多** 等价于 floor(N × 平仓价/开仓价 × (1 − 手续费))；
//         **做空** 是 floor(N × (1 + 杠杆 × (1 − 平仓价/开仓价)) − 手续费)
//         —— 价格跌才赚，亏损同样封顶在投入。
//         加回用户 + 一条 market_sell 流水（正）
//
// 【「系统水池」是账外的，不是一行账户】迁移前开仓是「用户 → 系统账户
// `raricy-blog-system`」、平仓是反向 —— 那两笔是远端复式账本的另一条腿。搬进站内后
// **只有用户这一侧**：开仓就是扣用户、平仓就是加用户，各自留一条自己的流水。
// 于是「无限水池」不再表现为任何一行余额，而是**全站鱼干总量的增减**：赚了凭空 mint
// 进用户余额（总量增加），亏了少发给他（总量减少）。它因此不受「预算有界」约束 ——
// 有界性来自档位（core+），不来自额度。
// ⚠️ **别为了「复式配平」在 users 里虚构一个系统账户行**：`FishTransaction.userId`
// 是必填外键，那行会长进用户列表与搜索里，成为一个谁都没打算给它的「用户」。
//
// ── ★ 唯一的安全边界：成交价必须现取 ★ ──────────────────────────────────────
// 开仓与平仓都用 fetchQuote()（**下单那一刻**向交易所拉的价），**绝不读展示缓存**。
// 用缓存价成交 = 看盘的人可以在价格跳动后、缓存刷新前下单 —— 无风险、可重复、
// 无上限的套利，不需要任何交易水平。市场价源挂了就拒单（503），不降级。
// 见 src/lib/market-price.ts 的文件头。
//
// ── 写路径：一个事务，没有补偿 ───────────────────────────────────────────────
// 扣款/入账（走记账内核 postEntry）、流水、position 行**全部在一个 SQLite 事务里
// 提交** —— 要么全成、要么全不成。因此这里既没有「本地已提交、账目还没记」的窗口，
// 也没有补偿事务；能冒到调用方的异常都是真故障，不是「稍后重试就好」。账户服务曾在
// 站外，那时才有那个窗口（历史注记见 docs/architecture.md §6.3.1，账本表的来龙去脉
// 见 fish-idempotency.ts 头部）。
//
// ── 平仓的幂等是「免费」的，开仓的不是 ──────────────────────────────────────
//   平仓：仓位一旦 closed，再平就是重放 —— 由 status 的条件写挡住（count === 0
//         即已被人平掉），回读既有结果不动钱。不需要幂等键。
//   开仓：同一用户同一标的同一金额买两次是完全正常的（分批建仓），不能靠参数去重，
//         必须靠 openKey 区分：调用方给了客户端键就按它派生，否则服务端现生成一个
//         （见 makeMarketIdempotencyKey）。**open_key 的唯一约束就是幂等的实现** ——
//         重放按它回读既有仓位，并发重复由它挡下。
//
// ── 手续费 ──────────────────────────────────────────────────────────────────
// MARKET_FEE_RATE 只在**平仓侧收一次**：开仓免费、持有免费、兑现时才收。
// 于是「买入并长持」是零摩擦的（那是我们想鼓励的行为），而频繁进出会被磨。
// ⚠️ 0.02% 是**速度刹**不是护城河 —— 真正护住这个功能的是「成交价现取」那一条。
// 别把它当成能弥补方向性亏损的东西（2026-09 从 0.1% 降到 0.02%，磨的手感还在，
// 但它已经小到不该被当成成本来算）。
// ⚠️ 它乘在**平仓时的名义本金**上，所以杠杆越高、摩擦越大（10 倍仓位平价进出付
// 10 倍的钱；100× 那一档平仓一次就是投入的 2%）。这是刻意的，见 market-math.ts
// 头部第 2 条 —— 也是彩票档与 10× 之间**唯一真实的价格差**。
//
// ── 杠杆 ────────────────────────────────────────────────────────────────────
// 投入 N 条可以开 N×杠杆 条的名义仓位，涨跌按杠杆放大，**亏损封顶在投入的那 N 条**。
//   · 「借来的钱」**没有对应的账户、没有利息、没有还款路径** —— 它就是那个账外水池
//     的另一种用法（见上面那段）。别去建一张借贷表。
//   · **杠杆是 1–100 的整数**（2026-10 从固定白名单改成自由输入）。上下界、快捷档、
//     警告带阈值住 `market-leverage.ts`（零依赖 —— 页面要 import 它渲染选择器，
//     而本文件拖着 prisma）。**服务端一视同仁**：1 到 100 之间每个整数都收，
//     `LEVERAGE_PRESETS` 只是页面摆几个按钮、统计页恒定占几行，**不是合法集**。
//     改上下界不需要迁移（那一列是整数，不是枚举也不是外键）。
//   · 结算与爆仓的算术**全在 market-math.ts**（settleClose + liquidationPrice）。
//     这里一个数都不算 —— 页面上「预计到手 / 爆仓价」与真结算是同一份公式。
//
// ── 方向 ────────────────────────────────────────────────────────────────────
// `long`（默认）｜`short`。词表住 market-leverage.ts，**开仓那一刻写死**（同爆仓价）。
//   · 结算：空头是 `stake + notional × (1 − 平仓价/开仓价)` —— 价格跌才赚。
//     费率那一项**不随方向翻转**（见 market-math.ts 文件头第 3 条）。
//   · 爆仓价：两侧之别见 market-math.liquidationPrice()。
//   · **方向不进幂等键**（与杠杆同一条纪律，见 buy/route.ts 头部）：同一个键带不同
//     方向重试时，回报的是当初那一笔（从库里读），不会开出第二笔、不会重复扣款。
//     与「分批建仓是正常操作」那条并存 —— 客户端每次开弹窗都换一个随机键。
//
//   ★ 强平引擎：本站第一个「自己动手动钱」的后台循环 ★
//     **1 倍多头**永远碰不到爆仓价（价格到不了 0 以下）—— 但这句话**只对多头成立**：
//     1× 空头在 2 × 开仓价归零，是一个完全可达的价。所以判据是
//     `needsLiquidator(leverage, direction)`（= 方向是空 ‖ 杠杆 > 1），**不是** `leverage > 1`。
//     引擎在 src/lib/market-liquidator.ts —— 它**不写鱼干流水**（实发恒为 0，
//     没有钱动过），只把仓位行从 open 改成 liquidated。
//     ⚠️ **开这类仓要求引擎活着**（见下面的 isLiquidationRunning 判据）：卖一个你
//     兑现不了的产品比不卖更糟。所以关掉强平（MARKET_LIQUIDATE_MS=0）会连着把
//     **杠杆仓与空头仓（含 1×）**一起关掉，而不是留下一批没人清算的仓位。
//
//   ★ 爆仓判定**不判禁言** ★ 与 sell 同理（见 sell/route.ts 头部）：禁言是「不能
//     说话」，不该顺带变成「不能止损」。被禁言的用户手上还开着的杠杆仓照旧会被强平。
//     新增这条写路径时最容易顺手加一个 `!isMuted` 闸门 —— 别加。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { postEntry, InsufficientFishError } from './fish-service';
import { FISH_DECIMALS, fishToUnits, unitsToFish } from './fish-units';
// 结算公式与爆仓价（零依赖模块 —— 页面也 import 它，见那里的文件头）
import { settleClose, liquidationPrice as liqPriceOf } from './market-math';
// 杠杆与方向的词表（零依赖 —— 页面同样 import 它渲染选择器，见那里的文件头）。
// 上下界 / 快捷档 / 警告带阈值全住那边，**本文件不再自己定义任何一个数**。
import {
  parseLeverage,
  parseDirection,
  needsLiquidator,
  MIN_LEVERAGE,
  MAX_LEVERAGE,
  type Direction,
} from './market-leverage';
// 「已结清」的**白名单**（closed | liquidated）住在 market-stats —— 那一列的名字只有
// 一处权威，读口照它认。market-stats 只 import market-math，不成环。
import { SETTLED_STATUSES, type SettledStatus } from './market-stats';
// ⚠️ 这个 import 是**单向**的：market-liquidator 不 import 本文件（成环会当场炸在
// 模块求值上）。它只提供「引擎是否活着」这一个判据，以及那个后台循环本身。
import { isLiquidationRunning } from './market-liquidator';
// 客户端幂等键的格式校验复用转账那一条 —— 同一个「调用方给的键」概念，
// 没有理由长出第二套规则。定义在 fish-idempotency（零业务依赖），
// 所以这里 import 它不会把 fish-market-service 拖进来。
import { CLIENT_KEY_RE } from './fish-idempotency';
import { rateLimit, RULES } from './rate-limit';
import {
  fetchQuote,
  parseSymbol,
  MarketPriceError,
  type MarketSymbol,
} from './market-price';

/**
 * 开仓 / 平仓流水类型。
 *
 * ⚠️ 这两个字符串是**既成事实**，改不得：存量 `account_sync_ledger` 行的 operation
 * 就是它们（迁移前写下的），而流水筛选里「练手盘」那个合称
 *（fish-service.applyTypeFilter 的 `market_all`）也照着这两个值认。
 */
export const MARKET_BUY_TYPE = 'market_buy';
export const MARKET_SELL_TYPE = 'market_sell';

/**
 * 手续费率（0.0002 = 0.02%）。**只在平仓侧收一次**（见文件头）。
 *
 * 改它要同步：页面文案、钉住这个数的用例（`tests/service` 与 `tests/route` 各一条），
 * 以及**任何新增的复述** —— 眼下没有对外文档写这个数（`docs/bot/fish-bot.md` 只列了
 * 练手盘的流水类型），所以别去那儿找，找不到不是漏了。
 * ⚠️ 页面上的费率文本**走 `market-math.ts` 的 `formatFeeRate`**，别自己
 * `toFixed(1)` —— 那个「保留几位小数」是跟着费率走的量（0.02% 会被它渲染成
 * 「0.0%」，而屏幕上那句话读起来仍然通顺）。
 */
export const MARKET_FEE_RATE = 0.0002;

/**
 * 单笔最小投入（鱼干）。
 *
 * 【这个下限原来是防舍入陷阱的，现在不是了】结算是
 * `floor(units × ratio × (1-手续费))`，floor 朝系统一侧丢零头。存储粒度还是 0.1 鱼干时，
 * 那一「点」零头最大就是 0.1 条 —— 投 0.1 条（1 个单位）时**价格不涨过 0.1% 就必然
 * 结算成 0**（那个阈值就是当时的费率，0.1%），是个几乎必赔的陷阱，而用户只会以为
 * 自己运气差。2026-09 把存储粒度提到
 * 0.0001 条（迁移 21_fish_units_1e4）之后，每次结算的零头上界变成 0.0001 条 ——
 * 对 1 条的仓位是 0.01%，投 0.1 条也不再有「必赔」性质。
 *
 * 下限因此改由**产品理由**支撑：一个仓位就是库里一行 + 页面上一条，尘埃仓位只是噪音。
 * 想调它的话，别再用「防舍入」当论据 —— 那条论据已经随精度提升失效了。
 *
 * ⚠️ **调用方的判定顺序不能动**：openPosition 先 fishToUnits 换算、后判这个下限。
 * 颠倒的话，0.05 会落到「最多 4 位小数」那一档而不是「最少投入 1 条」——
 * 报错文案指向一个用户根本没犯的错。
 */
export const MIN_STAKE_FISH = 1;

// ── 杠杆与方向的词表**已经搬去 `market-leverage.ts`（零依赖）** ────────────────
// 为什么搬：页面（客户端组件）要 import 上下界与快捷档去渲染选择器，而本文件拖着
// prisma 进不了客户端包（同 market-math.ts / blog-visibility.ts 的做法）。
// 上下界（MIN_LEVERAGE / MAX_LEVERAGE）、快捷档（LEVERAGE_PRESETS）、警告带
//（HIGH_RISK_LEVERAGE）、方向词表与两个解析函数，连同各自的判据与实测表，全在那边。
//
// 下面这行**重导出** `parseLeverage`：它的既有 import 路径（buy 路由、若干用例）
// 不必跟着搬 —— 搬家不该变成一次全仓的改名。
export { parseLeverage };

/** 页面与文案用的短名：BTCUSDT → BTC。 */
export function displaySymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

/**
 * 生成**服务端自动**的开仓幂等键（调用方没给客户端键时）。
 * 格式：`market-{sha256(userId-symbol-units-nonce)[:16]}-{ts}-{nonce}`（43 字符）。
 *
 * 【它现在的去处只有一处：`market_positions.open_key`】这个键不再是「发往远端的
 * 幂等键」，而是那一行的唯一键 —— 重放按它回读、并发重复由唯一约束挡下。
 *
 * 【为什么必须带随机 nonce】同一用户对**同一标的同一金额**买两次是完全正常的操作
 * （分批建仓）。秒级时间戳下不带 nonce 会让第二笔算出同一个键 —— 撞上 open_key 的
 * 唯一约束，第二笔整笔回滚（用户收到 500），而他以为买成了两笔。
 *
 * 【为什么把 userId 哈希掉、为什么键长这样】键的形状是**冻结的**：迁移前它要发往
 * 账户服务，而一个 userId 就有 36 字符，原样拼进去会顶到那边 64 字符的上限；库里
 * 也已经有一批这个形状的 open_key。客户端键那一路（`mop-…`）**必须逐字节重现**
 * （重放靠它认人），两条路保持同一代形状，别只改一条。
 *
 * 【键里嵌了 units，而 units 的标度改过一次（迁移 21_fish_units_1e4）—— 这是安全的】
 * 因为服务端自动键**只在这里生成一次、当场就用于查 + 插，从不事后重算**；调用方给键
 * 那一路压根不含 units。所以标度变只让**新**键的哈希输入不同，不存在「同一个逻辑仓位
 * 算出两个键」或跨标度碰撞。
 * ⚠️ **别把这条当 bug 去「修」**。真正要防的是反过来的改动：以后若有人加一条
 * 「按请求参数重算键去查有没有已存在的行」的服务端去重，迁移前落库的那些行就认不出来了
 * —— 那才会把重放变成第二笔。
 */
export function makeMarketIdempotencyKey(
  userId: string,
  symbol: string,
  units: number,
  nonce: string
): string {
  const short = createHash('sha256')
    .update(`${userId}-${symbol}-${units}-${nonce}`)
    .digest('hex')
    .slice(0, 16);
  return `market-${short}-${Math.floor(Date.now() / 1000)}-${nonce}`;
}

/** 一笔持仓的对外形状（页面渲染用；未实现盈亏由页面拿现价自己算）。 */
export interface PositionView {
  id: string;
  symbol: MarketSymbol;
  /** `long`｜`short`。**开仓那一刻写死**，页面据此渲染那枚方向角标与结算口径。 */
  direction: Direction;
  /** 投入鱼干（业务单位，≤4 位小数 —— 见 fish-units.ts）。 */
  stake: number;
  entryPrice: number;
  /** 杠杆倍数（1 = 无杠杆）。页面据此显示「10×」与那条强平提示。 */
  leverage: number;
  /**
   * 保证金归零的价。**直接读它、别自己拿开仓价乘一遍** —— 这是开仓那一刻算出来
   * 写死的数，与强平引擎用的是同一个（见 market-math.liquidationPrice 的注释）。
   * ⚠️ **只有 1 倍多头**才是 0（那条线不存在）；1× 空头是 2 × 开仓价，是一个真数。
   * 所以页面「要不要显示爆仓价」的判据是 `liquidationPrice > 0`，**不是** `leverage > 1`。
   */
  liquidationPrice: number;
  openedAt: Date;
}

export type OpenResult =
  | { ok: true; position: PositionView; balance: number; replayed?: true }
  | { ok: false; code: number; message: string };

export type CloseResult =
  | {
      ok: true;
      positionId: string;
      symbol: MarketSymbol;
      /** 这一笔的方向（从**仓位行**读）—— 路由据此给方向感知的文案与响应字段。 */
      direction: Direction;
      /** 实发鱼干（可能为 0 —— 近乎归零的仓位）。 */
      payout: number;
      /** 盈亏 = 实发 − 投入，可能为负。 */
      profit: number;
      /** 成交价（实际用于结算的那个）。 */
      exitPrice: number;
      /**
       * 这个仓位是被**强平**掉的（而不是本人按的卖出）。只有重放路径会给它 ——
       * 走到真结算分支说明仓位当时还是 open，那就还没有爆。
       * 路由据此把文案从「已卖出」改成「已爆仓」，别让用户以为是自己卖掉的。
       */
      liquidated?: true;
      balance: number;
      replayed?: true;
    }
  | { ok: false; code: number; message: string };

/** 平仓时发现仓位已被并发请求平掉：不是故障，回读既有结果按重放处理。 */
class MarketAlreadyClosedError extends Error {
  constructor(public position: { id: string; symbol: string; payoutUnits: number | null; stakeUnits: number; exitPrice: number | null }) {
    super('position already closed');
  }
}

function toPositionView(p: {
  id: string;
  symbol: string;
  direction: string;
  stakeUnits: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number;
  entryQuoteAt: Date;
}): PositionView {
  return {
    id: p.id,
    symbol: p.symbol as MarketSymbol,
    direction: p.direction as Direction,
    stake: unitsToFish(p.stakeUnits),
    entryPrice: p.entryPrice,
    leverage: p.leverage,
    liquidationPrice: p.liquidationPrice,
    openedAt: p.entryQuoteAt,
  };
}

/** 某用户当前持有的仓位（最近开的在前）。**已结清的仓位（平掉或爆掉）不在返回值里。** */
export async function listOpenPositions(userId: string): Promise<PositionView[]> {
  const rows = await prisma.marketPosition.findMany({
    where: { userId, status: 'open' },
    select: {
      id: true, symbol: true, direction: true, stakeUnits: true, entryPrice: true,
      leverage: true, liquidationPrice: true, entryQuoteAt: true,
    },
    orderBy: { entryQuoteAt: 'desc' },
  });
  return rows.map(toPositionView);
}

/** 一笔**已结清**的仓位（用户向）—— 「最近结清」那一块的形状。金额是**业务鱼干**。 */
export interface SettledPositionView {
  id: string;
  symbol: MarketSymbol;
  /** `long`｜`short` —— 供「最近结清」打那枚方向角标（金额口径与方向无关，见下）。 */
  direction: Direction;
  /** 投入（业务鱼干）。 */
  stake: number;
  /**
   * 结清时的成交价。**强平写的是那行上存着的爆仓价**，不是触发那一刻的现价
   *（见 market-liquidator.ts 文件头）。`exit_price` 为空的老行退回开仓价（同平仓重放那条）。
   */
  exitPrice: number;
  leverage: number;
  /** 实发（业务鱼干）。**数据异常时为 null —— 别 `?? 0`**：那会让「缺一块」与「真的全亏」
   *  长得一模一样（同 market-stats.ts 文件头那条纪律）。 */
  payout: number | null;
  /** 盈亏 = 实发 − 投入（业务鱼干，可能为负）。`payout` 为 null 时它也是 null。 */
  profit: number | null;
  /** `closed`（本人平）｜`liquidated`（被强平）。 */
  status: SettledStatus;
  /** 结清时刻。异常行为 null，页面显示「—」。 */
  closedAt: Date | null;
}

/**
 * 某用户**最近结清**的仓位（平仓 + 爆仓，最近的在前）—— /fish/trade 那一块的数据源。
 *
 * 【为什么另起一个读口，不复用 getMarketStats】统计那边把它们**折成几组数**；这里要的是
 * **逐笔明细** —— 用户能看到「我那一笔怎么了」。爆仓 / 实发为 0 的平仓会从上方的「我的
 * 持仓」里消失，而流水页**没有它们的条目**（没有钱动过就不写流水，见 market-stats.ts
 * 文件头）。这一块补的就是那个缺口。
 *
 * 【来源是 `market_positions`，不是账本】盈亏 = `payout_units − stake_units`，与平仓那一刻、
 * 与统计页是**同一个口径**。⚠️ **别改成从 `fish_transactions` 求和**（那是错的，不是
 * 「另一种口径」）：强平不写流水、实发为 0 的正常平仓也不写流水 —— 按账本求和会让这两类
 * 凭空消失，且**不报任何错**。理由的完整版在 market-stats.ts 与 market-stats-service.ts 头部。
 *
 * 【判「已结清」用白名单 SETTLED_STATUSES，不是 `status !== 'open'`】加第四个终态时，
 * 后者会静默把它连同它 `payout_units` 可能为 null 的行一起算进来。
 *
 * 【take 是刻意的，且必须可见】这一块是**最近若干笔**的概览（要看总数去统计页）。
 * 被截断时调用方据返回长度判断「还有更多」，页面上如实说明 —— 绝不静默截断成
 * 「就这些」。
 */
export async function listSettledPositions(
  userId: string,
  limit = 10
): Promise<SettledPositionView[]> {
  const rows = await prisma.marketPosition.findMany({
    where: { userId, status: { in: [...SETTLED_STATUSES] } },
    select: {
      id: true, symbol: true, direction: true, stakeUnits: true,
      entryPrice: true, exitPrice: true, leverage: true,
      payoutUnits: true, status: true, closedAt: true,
    },
    // closedAt 为空的老行排最后（SQLite 的 NULL 在 DESC 下最后）—— 不让异常行顶掉真实记录
    orderBy: { closedAt: 'desc' },
    take: Math.max(1, limit),
  });
  return rows.map((p) => {
    const payoutUnits = p.payoutUnits;
    // 全程在存储单位上算，最后各换算一次（同 market-stats.ts：逐行先换再算会掉浮点渣）
    return {
      id: p.id,
      symbol: p.symbol as MarketSymbol,
      direction: p.direction as Direction,
      stake: unitsToFish(p.stakeUnits),
      exitPrice: p.exitPrice ?? p.entryPrice,
      leverage: p.leverage,
      payout: payoutUnits == null ? null : unitsToFish(payoutUnits),
      profit: payoutUnits == null ? null : unitsToFish(payoutUnits - p.stakeUnits),
      status: p.status as SettledStatus,
      closedAt: p.closedAt,
    };
  });
}

/**
 * 开仓：投 `amount` 鱼干买入 `symbol`，按 `leverage` 倍杠杆。
 *
 * 顺序不是随意的：**校验 → 幂等重放 → 强平可用性 → 限频 → 现取价 → 事务**。
 *   · 限频在校验之后（刷垃圾参数不该烧掉自己的额度，对齐点赞/评论）
 *   · 限频在幂等重放之后（重放不消耗额度 —— 调用方遇到超时就该用同键重试）
 *   · **强平可用性也在幂等重放之后**：重放只是回读既有仓位、不产生新风险，
 *     不该因为「引擎此刻没在跑」就失败 —— 否则一笔已经成交的单子会看起来像失败了
 *   · 强平可用性在限频之前：它必拒，没道理让调用方为一次注定失败的请求烧额度
 *   · 现取价在限频之后（不然脚本可以用无效请求把我们的出站流量放大）
 */
export async function openPosition(input: {
  userId: string;
  symbolRaw: unknown;
  amount: unknown;
  /** 杠杆倍数（原样，未解析）。**不传 = 1**，见 parseLeverage */
  leverageRaw?: unknown;
  /** 方向（原样，未解析）。**不传 = 'long'**，见 parseDirection */
  directionRaw?: unknown;
  clientKey?: string | null;
}): Promise<OpenResult> {
  // ── 入参校验（不写库、不打行情源）──────────────────────────────────────────
  const symbol = parseSymbol(input.symbolRaw);
  if (!symbol) return { ok: false, code: 400, message: '不支持的标的' };

  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 400, message: '投入金额需大于 0' };
  }
  let units: number;
  try {
    units = fishToUnits(amount);
  } catch {
    // fishToUnits 对超精度 fail-loud（抛的是普通 Error）。不在这里接住转成 400，
    // 它会冒泡成 500 —— 用户输入 0.00005 看到「服务器开小差了」，前端也不知道该提示什么。
    // 与 transferFish 同一处判断。
    return { ok: false, code: 400, message: `投入金额最多 ${FISH_DECIMALS} 位小数` };
  }
  if (amount < MIN_STAKE_FISH) {
    return { ok: false, code: 400, message: `单笔最少投入 ${MIN_STAKE_FISH} 条小鱼干` };
  }

  // 杠杆（不传 = 1）。**必须在最前面判**，而且报错文案要把**区间**念出来 ——
  // 写「不支持的杠杆」等于让用户猜。自由输入之后没有可枚举的白名单了，所以念的是
  // 「1 到 100 的整数」这个边界本身（边界只有一处权威：market-leverage 的 MAX_LEVERAGE）。
  const leverage = parseLeverage(input.leverageRaw);
  if (leverage === null) {
    return {
      ok: false,
      code: 400,
      message: `杠杆需是 ${MIN_LEVERAGE}–${MAX_LEVERAGE} 之间的整数`,
    };
  }

  // 方向（不传 = long）。**与杠杆同一条纪律**：缺省向后兼容（存量客户端与 bot 不传
  // 这个字段），给了不认识的值就 400，**不猜也不夹**。
  // ⚠️ 它**不进幂等键**（见文件头与 buy/route.ts 头部）：同一个键带不同方向重试时，
  // 回报的是当初那一笔 —— 把方向拼进键会让「同一笔重试」变成**第二笔**、重复扣款。
  const direction = parseDirection(input.directionRaw);
  if (direction === null) {
    return { ok: false, code: 400, message: '方向只能是 long 或 short' };
  }

  // 幂等键。调用方给了就用（同一笔重试要拿同一个键，服务端才认得出这是重放），
  // 否则随机生成一个。
  const clientKey = (input.clientKey ?? '').trim();
  if (clientKey && !CLIENT_KEY_RE.test(clientKey)) {
    return { ok: false, code: 400, message: '幂等键格式不合法（1-48 位，仅字母数字与 _ . : -）' };
  }
  // 客户端键只在调用方自己的命名空间里唯一（`mrk-0007` 这种），两个用户完全可能撞上
  // 同一个字符串 —— 而 `market_positions.open_key` 是**全局唯一**的，不混进身份就会
  // 互相挡住：甲买了，乙用同一个键买会被当成「重放」，拿到甲那笔的结果。
  // 同 makeClientIdempotencyKey 的理由（幂等键是全局唯一的）。
  const idempotencyKey = clientKey
    ? `mop-${createHash('sha256').update(input.userId).digest('hex').slice(0, 8)}-${clientKey}`
    : makeMarketIdempotencyKey(input.userId, symbol, units, randomBytes(4).toString('hex'));

  // 重放：这一单已经开过了 → 如实回报既有结果，不再建仓、不再取价、不消耗额度。
  const existing = await prisma.marketPosition.findUnique({
    where: { openKey: idempotencyKey },
    select: {
      id: true, symbol: true, direction: true, stakeUnits: true, entryPrice: true,
      leverage: true, liquidationPrice: true, entryQuoteAt: true,
    },
  });
  if (existing) {
    const balance = await getBalanceFish(input.userId);
    return { ok: true, position: toPositionView(existing), balance, replayed: true };
  }

  // ── ★ 会爆仓的仓位要求强平引擎活着 ★ ───────────────────────────────────────
  // 卖一个兑现不了的产品比不卖更糟：引擎不跑的话，穿过爆仓价的仓位没人清算，
  // 用户手上的仓位会「该没还没没」，而系统既不报错也不提示。
  // 所以关掉强平（MARKET_LIQUIDATE_MS=0，运维开关）会连着把**这类开仓**一起关掉
  // —— **1 倍多头不受影响**（它永远碰不到爆仓价，不需要引擎）。
  // ⚠️ 判据是 `needsLiquidator`，**不是 `leverage > 1`**：1× 空头在 2 × 开仓价归零，
  // 同样需要引擎。写成 `leverage > 1` 会让引擎关着的时候照卖 1× 空头，而强平扫描
  //（按 `liquidation_price > 0` 筛）也捞不到它 —— 行永远停在 open，全程静默。
  // 判据是「引擎在本进程里起来了」，不是「env 非 0」：env 配了但启动失败（比如端口
  // 之类）同样不该卖。见 market-liquidator.ts 的 isLiquidationRunning。
  if (needsLiquidator(leverage, direction) && !isLiquidationRunning()) {
    console.warn(
      `[market] 强平引擎未运行，拒绝开仓（user=${input.userId} ${leverage}x ${direction}）`
    );
    return { ok: false, code: 503, message: '杠杆暂不可用，请稍后再试' };
  }

  // 限频（放在重放之后：同一笔重试不该把自己挡在门外）
  const perMinute = rateLimit(`trade:h:${input.userId}`, RULES.tradeMinute);
  const perDay = rateLimit(`trade:d:${input.userId}`, RULES.tradeDaily);
  if (!perMinute.allowed || !perDay.allowed) {
    return { ok: false, code: 429, message: '下单太频繁了，请稍后再试' };
  }

  // ── ★ 现取成交价（事务外，失败即拒单 —— 绝不退回展示缓存）★ ────────────────
  let quote;
  try {
    quote = await fetchQuote(symbol);
  } catch (e) {
    if (e instanceof MarketPriceError) {
      console.warn(`[market] 取价失败，拒绝开仓（user=${input.userId} symbol=${symbol}）: ${e.message}`);
      return { ok: false, code: 503, message: '行情暂不可用，请稍后再试' };
    }
    throw e;
  }
  const entryPrice = quote.price;
  const positionId = randomUUID();
  const now = nowForDb();
  // 爆仓价：**开仓这一刻算一次就写死**（见 schema.prisma 那一列的注释）。
  // 算法住 market-math（与页面上显示的那个数、与强平引擎的判据是同一个函数）。
  const entryLiqPrice = liqPriceOf(entryPrice, leverage, direction);
  // 方向与杠杆都写进流水描述里：这一行是用户在流水页能看到的**唯一**上下文，
  // 而「10 倍」正是解释「为什么我只投了 100 条却亏了 100 条」的那句话。
  // ⚠️ **方向必须写，哪怕 1 倍**：1× 多头与 1× 空头在流水页长得一模一样，而它们
  // 是方向相反的两笔 —— 少了那两个字，流水就还原不出用户当时干了什么。
  // 杠杆 1 倍时不加前缀（默认档，加个「1倍杠杆」只是噪音）。
  const dirWord = direction === 'short' ? '做空' : '买入';
  const description = `练手盘 ${leverage > 1 ? `${leverage}倍杠杆` : ''}${dirWord} ${displaySymbol(symbol)}（成交价 ${entryPrice}）`;

  try {
    // ── 一个事务：扣款、流水、持仓行 ──────────────────────────────────────────
    const applied = await prisma.$transaction(async (tx) => {
      // 1.1 扣款 + 支出流水（走记账内核）。余额不足由内核抛 InsufficientFishError，
      //     整笔回滚，外层转成 400 业务结果 —— 别在这里自己 updateMany 再判 count
      //     （那正是内核收起来的那段）。
      const txRow = await postEntry(tx, {
        userId: input.userId,
        units: -units,
        type: MARKET_BUY_TYPE,
        description,
        referenceType: 'market_position',
        referenceId: positionId,
        // relatedUserId 留空：这里没有对手方 —— 「系统水池」是账外概念，不是一行用户
        //（同签到，那里也没有对手方）。
      });

      // 1.2 持仓行。openKey 的唯一约束就是幂等的实现：并发同键会撞在这里，事务整体
      //     回滚，那一个请求收到 500（不是「已成交」）—— 它用同一个键重试就会落到
      //     上面的重放分支，这是这套机制自愈的方式。
      await tx.marketPosition.create({
        data: {
          id: positionId,
          userId: input.userId,
          symbol,
          direction,
          stakeUnits: units,
          entryPrice,
          entryQuoteAt: quote.quotedAt,
          leverage,
          liquidationPrice: entryLiqPrice,
          openTxId: txRow.txId,
          openKey: idempotencyKey,
          status: 'open',
          createdAt: now,
        },
      });

      const after = await tx.user.findUnique({
        where: { id: input.userId },
        select: { driedFish: true },
      });
      return { balance: unitsToFish(after?.driedFish ?? 0) };
    });

    return {
      ok: true,
      position: {
        id: positionId,
        symbol,
        direction,
        stake: amount,
        entryPrice,
        leverage,
        liquidationPrice: entryLiqPrice,
        openedAt: quote.quotedAt,
      },
      balance: applied.balance,
    };
  } catch (e) {
    if (e instanceof InsufficientFishError) {
      // 余额不足是**业务结果**，不是故障（内核抛出时整笔开仓已回滚）。
      return { ok: false, code: 400, message: '小鱼干不足' };
    }
    // 兜底：本地事务要么成要么不成（记账已无远端），能冒到这里的是真故障 → 路由 500。
    console.error(`[market] 开仓异常（user=${input.userId} symbol=${symbol}）:`, e);
    throw e;
  }
}

/**
 * 平仓（手动，整仓）：把某个仓位按**此刻**的价结算掉，实发鱼干加回用户。
 *
 * 幂等天然成立 —— 仓位一旦**结清**，再平就是重放（回读既有 payoutUnits，不动钱）。
 * 所以这里**没有**幂等键。
 *
 * ⚠️ 判据是 `status !== 'open'` 而**不是** `status === 'closed'`：爆仓也是结清
 * （status = 'liquidated'，强平引擎写的）。写成后者的话，一个已经爆掉的仓位在这个
 * 分支上会被当成「还开着」，于是走下面的取价 + 结算 + 条件写 —— 条件写会挡住
 *（where status='open' 匹配 0 行）→ 落到 MarketAlreadyClosedError → 回读，结果**恰好
 * 还是对的**，但要多打一次行情源、多烧一次限频额度，而且那一步的语义已经错了。
 * 这类「结果碰巧对」的错法最难发现，所以判据必须写全。
 */
export async function closePosition(input: {
  userId: string;
  positionId: string;
}): Promise<CloseResult> {
  const pos = await prisma.marketPosition.findUnique({
    where: { id: input.positionId },
    select: {
      id: true, userId: true, symbol: true, direction: true, stakeUnits: true,
      entryPrice: true, status: true, payoutUnits: true, exitPrice: true,
      leverage: true,
    },
  });
  // 不是自己的仓位一律 404（别用 403 —— 那等于确认「这个 id 存在」）
  if (!pos || pos.userId !== input.userId) {
    return { ok: false, code: 404, message: '持仓不存在' };
  }

  // 重放快路径：已结清（平掉或爆掉）→ 回读既有结果。**放在取价与限频之前** ——
  // 重放不该因为此刻行情源不通就报 503，也不该消耗额度。
  if (pos.status !== 'open') {
    return {
      ok: true,
      positionId: pos.id,
      symbol: pos.symbol as MarketSymbol,
      direction: pos.direction as Direction,
      payout: unitsToFish(pos.payoutUnits ?? 0),
      profit: unitsToFish((pos.payoutUnits ?? 0) - pos.stakeUnits),
      exitPrice: pos.exitPrice ?? pos.entryPrice,
      // 爆掉的仓位也让用户「卖」一下会走到这里。如实告诉他是爆了，而不是「已卖出」
      liquidated: pos.status === 'liquidated' || undefined,
      balance: await getBalanceFish(input.userId),
      replayed: true,
    };
  }

  const symbol = pos.symbol as MarketSymbol;

  const perMinute = rateLimit(`trade:h:${input.userId}`, RULES.tradeMinute);
  const perDay = rateLimit(`trade:d:${input.userId}`, RULES.tradeDaily);
  if (!perMinute.allowed || !perDay.allowed) {
    return { ok: false, code: 429, message: '操作太频繁了，请稍后再试' };
  }

  // ── ★ 现取成交价（同开仓：失败即拒单，绝不退回展示缓存）★ ──────────────────
  let quote;
  try {
    quote = await fetchQuote(symbol);
  } catch (e) {
    if (e instanceof MarketPriceError) {
      console.warn(`[market] 取价失败，拒绝平仓（user=${input.userId} pos=${pos.id}）: ${e.message}`);
      return { ok: false, code: 503, message: '行情暂不可用，请稍后再试' };
    }
    throw e;
  }
  const exitPrice = quote.price;

  // 结算。公式住在 market-math.ts —— **页面上的「预计到手」用的是同一个函数**，
  // 别把这条算术抄一份回这里（两份必然 drift，而用户是看着那个数按下确认的）。
  //
  // ⚠️ `leverage` 与 `direction` 都必须从**这一行**读，别从调用方传进来：它们是仓位的
  // 属性，不是这次请求的属性。少传杠杆 = 10 倍的仓位按 1 倍结算；少传方向 = **空头按
  // 多头结算（盈亏整体反向）** —— 两种症状一样：屏幕上那个数看起来完全合理。
  const { payoutUnits } = settleClose({
    stakeUnits: pos.stakeUnits,
    entryPrice: pos.entryPrice,
    exitPrice,
    feeRate: MARKET_FEE_RATE,
    leverage: pos.leverage,
    direction: pos.direction as Direction,
  });

  // ⚠️ payoutUnits 可能为 0 —— 那时**没有钱动过**：不写流水、不发通知，只把仓位置 closed。
  // 漏了这一档就会让记账内核抛出来（postEntry 对 units === 0 也是抛的，它只收
  // 非零整数），用户看到一个 500 —— 而实发 0 是合法结果，仓位照样要平掉。
  //
  // 这条分支在 2026-09 精度提到 0.0001 条之后**几乎打不到了**：实发 0 要求价格跌掉
  // 99.99% 以上（精度还是 0.1 条时，投 1 个单位的仓位随便一动就归零，那才是常态）。
  // 留着它是因为「跌到 0」在数学上仍可能，而不是因为常见。
  //
  // ⚠️ 加杠杆之后它**又常见了**：杠杆仓的实发 0 有两个来源 —— 价格跌穿爆仓价（权益
  // 被 max(0,…) 截成 0），以及权益还没归零但被手续费吃光。两者都走这一档。
  // **手动平一个已跌穿爆仓价的杠杆仓，实发与爆仓一样是 0**（同一个公式、同一个
  // max(0,…)）—— 这是刻意的，见 market-math.ts 头部「那个 max(0, …) 就是爆仓」。
  // 文案随方向走：多头是「卖出」，空头是「平空」（买回）—— 1× 空头也带那个词，
  // 否则它与 1× 多头在流水页逐字相同，而它们是方向相反的两笔。
  const dirWord = pos.direction === 'short' ? '平空' : '卖出';
  const description = `练手盘 ${pos.leverage > 1 ? `${pos.leverage}倍杠杆` : ''}${dirWord} ${displaySymbol(symbol)}（成交价 ${exitPrice}）`;

  try {
    // ── 一个事务：翻状态、结算入账、流水 ──────────────────────────────────────
    const applied = await prisma.$transaction(async (tx) => {
      const now = nowForDb();
      // 先把状态翻掉（条件写）。并发平仓只有一个能拿到 count === 1。
      const flipped = await tx.marketPosition.updateMany({
        where: { id: pos.id, userId: input.userId, status: 'open' },
        data: {
          status: 'closed',
          exitPrice,
          exitQuoteAt: quote.quotedAt,
          payoutUnits,
          closedAt: now,
        },
      });
      if (flipped.count === 0) throw new MarketAlreadyClosedError(pos);

      let txId: number | null = null;
      if (payoutUnits > 0) {
        // 入账 + 正数流水（走记账内核）。units 直接就是 payoutUnits（存储单位），
        // 不必过一遍业务鱼干的换算。不带 relatedUserId：这里没有对手方（见文件头）。
        const posted = await postEntry(tx, {
          userId: input.userId,
          units: payoutUnits,
          type: MARKET_SELL_TYPE,
          description,
          referenceType: 'market_position',
          referenceId: pos.id,
        });
        txId = posted.txId;
        await tx.marketPosition.update({
          where: { id: pos.id },
          data: { closeTxId: txId },
        });
      }

      const after = await tx.user.findUnique({
        where: { id: input.userId },
        select: { driedFish: true },
      });
      return { balance: unitsToFish(after?.driedFish ?? 0) };
    });

    return {
      ok: true,
      positionId: pos.id,
      symbol,
      direction: pos.direction as Direction,
      payout: unitsToFish(payoutUnits),
      profit: unitsToFish(payoutUnits - pos.stakeUnits),
      exitPrice,
      balance: applied.balance,
    };
  } catch (e) {
    if (e instanceof MarketAlreadyClosedError) {
      // 并发平仓的输家：回读赢家写下的结果，如实回报（不动钱）。
      //
      // ⚠️ 赢家**可能是强平引擎**（用户手动平仓与爆仓撞在同一瞬间，这是真实可能的：
      // 用户看到价格穿过爆仓价、按下平仓，同一刻引擎那一轮也扫到了这个仓位）。
      // 所以要把 status 一起读回来 —— 是引擎赢的话如实说「爆仓」，别报「已卖出」。
      const fresh = await prisma.marketPosition.findUnique({
        where: { id: pos.id },
        select: { payoutUnits: true, exitPrice: true, status: true },
      });
      return {
        ok: true,
        positionId: pos.id,
        symbol,
        direction: pos.direction as Direction,
        payout: unitsToFish(fresh?.payoutUnits ?? 0),
        profit: unitsToFish((fresh?.payoutUnits ?? 0) - pos.stakeUnits),
        exitPrice: fresh?.exitPrice ?? exitPrice,
        liquidated: fresh?.status === 'liquidated' || undefined,
        balance: await getBalanceFish(input.userId),
        replayed: true,
      };
    }
    // 兜底：本地事务要么成要么不成（记账已无远端），能冒到这里的是真故障 → 路由 500。
    console.error(`[market] 平仓异常（user=${input.userId} pos=${pos.id}）:`, e);
    throw e;
  }
}

/** 读余额（鱼干），给返回值用。余额的真源就是本地 `users.driedFish`。 */
async function getBalanceFish(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { driedFish: true },
  });
  return unitsToFish(row?.driedFish ?? 0);
}
