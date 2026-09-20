// ─────────────────────────────────────────────────────────────────────────────
// market-service.ts — 鱼干练手盘的开仓 / 平仓
//
// 【这是什么】用户投鱼干买入一个**绑定真实加密价格**的仓位，价格涨跌直接决定他能
// 拿回多少鱼干。**不是交易所，也不是庄家对赌**：没有撮合、没有对手盘、没有敞口。
//
//   开仓：条件扣减 N 单位鱼干 + 一条 market_buy 流水（负），建一行 position
//   平仓：payoutUnits = floor(N × 平仓价 / 开仓价 × (1 - 手续费))，加回用户 + 一条
//         market_sell 流水（正）
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
// ⚠️ 0.1% 是**速度刹**不是护城河 —— 真正护住这个功能的是「成交价现取」那一条。
// 别把它当成能弥补方向性亏损的东西。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { postEntry, InsufficientFishError } from './fish-service';
import { FISH_DECIMALS, fishToUnits, unitsToFish } from './fish-units';
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
 * 手续费率。**只在平仓侧收一次**（见文件头）。
 * 改它要同步 docs/bot/ 与页面文案 —— 凡是复述了数值的对外文档都会 drift。
 */
export const MARKET_FEE_RATE = 0.001;

/**
 * 单笔最小投入（鱼干）。
 *
 * 【这个下限原来是防舍入陷阱的，现在不是了】结算是
 * `floor(units × ratio × (1-手续费))`，floor 朝系统一侧丢零头。存储粒度还是 0.1 鱼干时，
 * 那一「点」零头最大就是 0.1 条 —— 投 0.1 条（1 个单位）时**价格不涨过 0.1% 就必然
 * 结算成 0**，是个几乎必赔的陷阱，而用户只会以为自己运气差。2026-09 把存储粒度提到
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
  /** 投入鱼干（业务单位，≤4 位小数 —— 见 fish-units.ts）。 */
  stake: number;
  entryPrice: number;
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
      /** 实发鱼干（可能为 0 —— 近乎归零的仓位）。 */
      payout: number;
      /** 盈亏 = 实发 − 投入，可能为负。 */
      profit: number;
      /** 成交价（实际用于结算的那个）。 */
      exitPrice: number;
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
  stakeUnits: number;
  entryPrice: number;
  entryQuoteAt: Date;
}): PositionView {
  return {
    id: p.id,
    symbol: p.symbol as MarketSymbol,
    stake: unitsToFish(p.stakeUnits),
    entryPrice: p.entryPrice,
    openedAt: p.entryQuoteAt,
  };
}

/** 某用户当前持有的仓位（最近开的在前）。关掉的仓位不在返回值里。 */
export async function listOpenPositions(userId: string): Promise<PositionView[]> {
  const rows = await prisma.marketPosition.findMany({
    where: { userId, status: 'open' },
    select: { id: true, symbol: true, stakeUnits: true, entryPrice: true, entryQuoteAt: true },
    orderBy: { entryQuoteAt: 'desc' },
  });
  return rows.map(toPositionView);
}

/**
 * 开仓：投 `amount` 鱼干买入 `symbol`。
 *
 * 顺序不是随意的：**校验 → 幂等重放 → 限频 → 现取价 → 事务**。
 *   · 限频在校验之后（刷垃圾参数不该烧掉自己的额度，对齐点赞/评论）
 *   · 限频在幂等重放之后（重放不消耗额度 —— 调用方遇到超时就该用同键重试）
 *   · 现取价在限频之后（不然脚本可以用无效请求把我们的出站流量放大）
 */
export async function openPosition(input: {
  userId: string;
  symbolRaw: unknown;
  amount: unknown;
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
      id: true, symbol: true, stakeUnits: true, entryPrice: true, entryQuoteAt: true,
    },
  });
  if (existing) {
    const balance = await getBalanceFish(input.userId);
    return { ok: true, position: toPositionView(existing), balance, replayed: true };
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
  const description = `练手盘 买入 ${displaySymbol(symbol)}（成交价 ${entryPrice}）`;

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
          stakeUnits: units,
          entryPrice,
          entryQuoteAt: quote.quotedAt,
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
        stake: amount,
        entryPrice,
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
 * 平仓：把某个仓位按**此刻**的价结算掉，实发鱼干加回用户。
 *
 * 幂等天然成立 —— 仓位一旦 closed，再平就是重放（回读既有 payoutUnits，不动钱）。
 * 所以这里**没有**幂等键。
 */
export async function closePosition(input: {
  userId: string;
  positionId: string;
}): Promise<CloseResult> {
  const pos = await prisma.marketPosition.findUnique({
    where: { id: input.positionId },
    select: {
      id: true, userId: true, symbol: true, stakeUnits: true,
      entryPrice: true, status: true, payoutUnits: true, exitPrice: true,
    },
  });
  // 不是自己的仓位一律 404（别用 403 —— 那等于确认「这个 id 存在」）
  if (!pos || pos.userId !== input.userId) {
    return { ok: false, code: 404, message: '持仓不存在' };
  }

  // 重放快路径：已平过 → 回读既有结果。**放在取价与限频之前** —— 重放不该因为
  // 此刻行情源不通就报 503，也不该消耗额度。
  if (pos.status === 'closed') {
    return {
      ok: true,
      positionId: pos.id,
      symbol: pos.symbol as MarketSymbol,
      payout: unitsToFish(pos.payoutUnits ?? 0),
      profit: unitsToFish((pos.payoutUnits ?? 0) - pos.stakeUnits),
      exitPrice: pos.exitPrice ?? pos.entryPrice,
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

  // 结算。Math.floor（不是 round）：**舍入永远朝系统一侧**，宁可少发一个单位也不
  // 凭空多铸。落库前必须落成整数 —— 它是写进 payout_units 与那条流水的那一个数。
  const gross = (pos.stakeUnits * exitPrice) / pos.entryPrice;
  const payoutUnits = Math.floor(gross * (1 - MARKET_FEE_RATE));

  // ⚠️ payoutUnits 可能为 0 —— 那时**没有钱动过**：不写流水、不发通知，只把仓位置 closed。
  // 漏了这一档就会让记账内核抛出来（postEntry 对 units === 0 也是抛的，它只收
  // 非零整数），用户看到一个 500 —— 而实发 0 是合法结果，仓位照样要平掉。
  //
  // 这条分支在 2026-09 精度提到 0.0001 条之后**几乎打不到了**：实发 0 要求价格跌掉
  // 99.99% 以上（精度还是 0.1 条时，投 1 个单位的仓位随便一动就归零，那才是常态）。
  // 留着它是因为「跌到 0」在数学上仍可能，而不是因为常见。
  const description = `练手盘 卖出 ${displaySymbol(symbol)}（成交价 ${exitPrice}）`;

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
      payout: unitsToFish(payoutUnits),
      profit: unitsToFish(payoutUnits - pos.stakeUnits),
      exitPrice,
      balance: applied.balance,
    };
  } catch (e) {
    if (e instanceof MarketAlreadyClosedError) {
      // 并发平仓的输家：回读赢家写下的结果，如实回报（不动钱）。
      const fresh = await prisma.marketPosition.findUnique({
        where: { id: pos.id },
        select: { payoutUnits: true, exitPrice: true },
      });
      return {
        ok: true,
        positionId: pos.id,
        symbol,
        payout: unitsToFish(fresh?.payoutUnits ?? 0),
        profit: unitsToFish((fresh?.payoutUnits ?? 0) - pos.stakeUnits),
        exitPrice: fresh?.exitPrice ?? exitPrice,
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
