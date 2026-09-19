// ─────────────────────────────────────────────────────────────────────────────
// market-service.ts — 鱼干练手盘的开仓 / 平仓
//
// 【这是什么】用户投鱼干买入一个**绑定真实加密价格**的仓位，价格涨跌直接决定他能
// 拿回多少鱼干。**不是交易所，也不是庄家对赌**：没有撮合、没有对手盘、没有敞口。
// 系统账户 `raricy-blog-system` 是**无限水池** —— 赚了从它 mint，亏了就 burn 回它。
//
//   开仓：条件扣减 N 单位鱼干（用户 → 系统），建一行 position
//   平仓：payoutUnits = floor(N × 平仓价 / 开仓价 × (1 - 手续费))，加回用户（系统 → 用户）
//
// ── ★ 唯一的安全边界：成交价必须现取 ★ ──────────────────────────────────────
// 开仓与平仓都用 fetchQuote()（**下单那一刻**向交易所拉的价），**绝不读展示缓存**。
// 用缓存价成交 = 看盘的人可以在价格跳动后、缓存刷新前下单 —— 无风险、可重复、
// 无上限的套利，不需要任何交易水平。市场价源挂了就拒单（503），不降级。
// 见 src/lib/market-price.ts 的文件头。
//
// ── 写路径照抄 fish-market-service 的三段式（不是新发明）────────────────────
//   Phase 1  本地事务：扣款/入账 + 流水 + position + 账本 pending（纯 DB，毫秒级）
//   Phase 2  事务外 executeSync 调远端账户服务
//   Phase 3  远端失败 → 补偿事务精确撤销本地写入（对用户等价于回滚 → 503）
// **远端 HTTP 绝不在 SQLite 事务内**：写锁被占满 ACCOUNT_SERVICE_TIMEOUT，并发写
// 直接 "database is locked"。这是全站红线。
//
// ── 平仓的幂等是「免费」的，开仓的不是 ──────────────────────────────────────
//   平仓：仓位一旦 closed，再平就是重放 —— 由 status 的条件写挡住（count === 0
//         即已被人平掉），回读既有结果不动钱。不需要幂等键。
//   开仓：同一用户同一标的同一金额买两次是完全正常的（分批建仓），必须靠
//         openKey（带随机 nonce）区分，否则远端静默去重、本地记两笔 = 无声分叉。
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
import { addFish } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
// 客户端幂等键的格式校验复用转账那一条 —— 同一个「调用方给的键」概念，
// 没有理由长出第二套规则。依赖方向是单向的（fish-market-service 不 import 本文件）。
import { CLIENT_KEY_RE } from './fish-market-service';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
  type PendingSyncEntry,
} from './fish-sync';
import {
  AccountServiceError,
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  makeMarketIdempotencyKey,
} from './account-client';
import { rateLimit, RULES } from './rate-limit';
import {
  fetchQuote,
  parseSymbol,
  MarketPriceError,
  type MarketSymbol,
} from './market-price';

/** 开仓流水（负数）。与远端 entry_type 同名，便于对着两边流水排查。 */
export const MARKET_BUY_TYPE = 'market_buy';
/** 平仓流水（正数）。 */
export const MARKET_SELL_TYPE = 'market_sell';

/**
 * 手续费率。**只在平仓侧收一次**（见文件头）。
 * 改它要同步 docs/bot/ 与页面文案 —— 凡是复述了数值的对外文档都会 drift。
 */
export const MARKET_FEE_RATE = 0.001;

/**
 * 单笔最小投入（鱼干）。
 *
 * 【为什么不是 0.1】存储层的最小单位是 0.1 鱼干（1 个单位），而结算是
 * `floor(units × ratio × (1-手续费))`。投 0.1 鱼干 = 1 个单位时，**价格不涨过 0.1%
 * 就必然结算成 0** —— 那不是一个「高风险」的仓位，是一个几乎必赔的陷阱，而用户
 * 只会以为自己运气差。1 条鱼干（10 个单位）时舍入损失上界 0.1 条，最坏 10%；
 * 投到 10 条以上时舍入损失就降到 1% 以内。
 *
 * 顺带说明：这个下限也是**唯一**能拦住小数位数的位置 —— fishToUnits 只接受 ≤1 位
 * 小数，所以小于 1 的合法输入只有 0.1~0.9，正好全被这一条挡下。
 */
export const MIN_STAKE_FISH = 1;

/** 页面与文案用的短名：BTCUSDT → BTC。 */
export function displaySymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

/** 一笔持仓的对外形状（页面渲染用；未实现盈亏由页面拿现价自己算）。 */
export interface PositionView {
  id: string;
  symbol: MarketSymbol;
  /** 投入鱼干（业务单位，≤1 位小数）。 */
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

/** 业务拒绝（400/404）。刻意不导出：路由只认判别联合，不该 catch 它。 */
class MarketBusinessError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

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
  // ── 入参校验（不写库、不打远端、不打行情源）────────────────────────────────
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
    // fishToUnits 对 >1 位小数 fail-loud（抛的是普通 Error）。不在这里接住转成 400，
    // 它会冒泡到最外层被包成 AccountServiceError(503) —— 用户输入 0.05 收到
    // 「鱼干服务暂不可用」，且前端不知道该提示什么。与 transferFish 同一处判断。
    return { ok: false, code: 400, message: '投入金额最多 1 位小数' };
  }
  if (amount < MIN_STAKE_FISH) {
    return { ok: false, code: 400, message: `单笔最少投入 ${MIN_STAKE_FISH} 条小鱼干` };
  }

  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    // 生产 fail-closed：不做任何本地写入直接拒绝；dev 仅本地 + 告警。
    assertRemoteRequiredInProduction('练手盘开仓');
  }

  // 幂等键。调用方给了就用（同一笔重试要拿同一个键，服务端才认得出这是重放），
  // 否则随机生成一个。
  const clientKey = (input.clientKey ?? '').trim();
  if (clientKey && !CLIENT_KEY_RE.test(clientKey)) {
    return { ok: false, code: 400, message: '幂等键格式不合法（1-48 位，仅字母数字与 _ . : -）' };
  }
  // 客户端键只在调用方自己的命名空间里唯一（`mrk-0007` 这种），两个用户完全可能撞上
  // 同一个字符串 —— 而账本的 idempotencyKey 是**全局唯一**的，不混进身份就会互相挡住。
  // 同 makeClientIdempotencyKey 的理由。
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
  const entry: PendingSyncEntry = {
    idempotencyKey,
    operation: 'market_buy',
    payload: {
      userId: input.userId,
      amount,
      description: `练手盘 买入 ${displaySymbol(symbol)}（成交价 ${entryPrice}）`,
    },
  };
  const description = entry.payload.description as string;

  try {
    // ── Phase 1：本地事务（纯 DB，无远端 IO / 无出站 HTTP）────────────────────
    const phase1 = await prisma.$transaction(async (tx) => {
      // 1.1 原子条件扣减（单条 UPDATE 带谓词，防超扣 / 防负数）
      const dec = await tx.user.updateMany({
        where: { id: input.userId, driedFish: { gte: units } },
        data: { driedFish: { decrement: units } },
      });
      if (dec.count === 0) throw new MarketBusinessError(400, '小鱼干不足');

      // 1.2 支出流水。手写 create（不是 addFish —— 那是「加钱」的口径）。
      //     createdAt 必须显式写：schema 没有 @default(now())，漏写整条流水时间为
      //     NULL，流水倒序会乱、按区间的统计会静默失效。
      const txRow = await tx.fishTransaction.create({
        data: {
          userId: input.userId,
          amount: -units,
          type: MARKET_BUY_TYPE,
          description,
          referenceType: 'market_position',
          referenceId: positionId,
          // relatedUserId 留空：对手方是系统账户 `raricy-blog-system`，它只在远端
          // 存在、本地没有 users 行（填了会撞外键）。与签到同款 —— 那里也没填。
          createdAt: now,
        },
        select: { id: true },
      });

      // 1.3 持仓行。openKey 的唯一约束就是幂等的实现：并发同键会撞在这里，
      //     事务整体回滚，外层按重放处理。
      await tx.marketPosition.create({
        data: {
          id: positionId,
          userId: input.userId,
          symbol,
          stakeUnits: units,
          entryPrice,
          entryQuoteAt: quote.quotedAt,
          openTxId: txRow.id,
          openKey: idempotencyKey,
          status: 'open',
          createdAt: now,
        },
      });

      // 1.4 账本登记 pending（与业务写入同事务提交；dev fallback 不登记 —— 登记了
      //     就是一堆永远同步不出去的 pending，把 fish pending / sync-retry 的语义搞浑）
      if (remoteEnabled) await recordPendingSync(tx, entry);

      const after = await tx.user.findUnique({
        where: { id: input.userId },
        select: { driedFish: true },
      });
      return { balance: unitsToFish(after?.driedFish ?? 0), txId: txRow.id };
    });

    // ── Phase 2：事务外远端同步 ──────────────────────────────────────────────
    if (remoteEnabled) {
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        // ── Phase 3：补偿事务精确撤销本地写入（对用户等价于回滚）──────────────
        try {
          await prisma.$transaction(async (tx) => {
            await tx.fishTransaction.deleteMany({ where: { id: phase1.txId } });
            // 退回 —— **无条件** increment：Tx A 后余额是 B-u，之后最多再花掉 B-u，
            // 退回后 = B-s ≥ 0，数学上不可能变负。别「为了对称」加条件：那会在用户
            // 刚好花光时误判补偿失败，把一个本可自愈的局面推进 reconcile。
            await tx.user.update({
              where: { id: input.userId },
              data: { driedFish: { increment: units } },
            });
            // 删持仓行 —— 这是全站「永不物理删除」的**唯一例外**（同签到翻牌失败的
            // 补偿删流水）：这笔开仓从未生效，等价于它没发生过。
            await tx.marketPosition.deleteMany({ where: { id: positionId } });
            await tx.accountSyncLedger.deleteMany({
              where: { idempotencyKey: entry.idempotencyKey },
            });
          });
        } catch (undoErr) {
          await settleSync(entry.idempotencyKey, 'failed', String(undoErr)).catch(() => {});
          await logReconcileRequired(entry, undoErr);
        }
        console.warn(
          `[market] 开仓远端同步失败，本地写入已补偿回滚` +
            `（user=${input.userId} symbol=${symbol} amount=${amount}）: ${String(syncErr)}`
        );
        throw syncErr instanceof AccountServiceError
          ? syncErr
          : new AccountServiceError(`开仓同步失败: ${String(syncErr)}`, 503);
      }
    }

    return {
      ok: true,
      position: {
        id: positionId,
        symbol,
        stake: amount,
        entryPrice,
        openedAt: quote.quotedAt,
      },
      balance: phase1.balance,
    };
  } catch (e) {
    if (e instanceof MarketBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
    if (e instanceof AccountServiceError) throw e; // 远端失败：已补偿，路由转 503
    // 兜底：意外异常按 fail-closed 处理
    console.error(`[market] 开仓异常（user=${input.userId} symbol=${symbol}）:`, e);
    throw new AccountServiceError(`开仓失败: ${String(e)}`, 503);
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
  // 凭空多铸。落库前必须落成整数 —— 这是唯一进账本的数字。
  const gross = (pos.stakeUnits * exitPrice) / pos.entryPrice;
  const payoutUnits = Math.floor(gross * (1 - MARKET_FEE_RATE));

  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('练手盘平仓');
  }

  // ⚠️ payoutUnits 可能为 0（近乎归零的仓位，或投入小到 1 个单位）—— 那时
  // **没有钱动过**：不写流水、不登记账本、不发通知，只把仓位置 closed。
  // 漏了这一档会让 addFish 抛「amount 必须为正数」，用户看到一个 500。
  const idempotencyKey = `market-close-${pos.id}`;
  const description = `练手盘 卖出 ${displaySymbol(symbol)}（成交价 ${exitPrice}）`;
  const entry: PendingSyncEntry = {
    idempotencyKey,
    operation: 'market_sell',
    payload: { userId: input.userId, amount: unitsToFish(payoutUnits), description },
  };

  try {
    const phase1 = await prisma.$transaction(async (tx) => {
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
        // addFish：加余额 + 正数流水 + 显式 createdAt。不带 relatedUserId（同上）。
        const added = await addFish(tx, {
          userId: input.userId,
          amount: unitsToFish(payoutUnits),
          type: MARKET_SELL_TYPE,
          description,
          referenceType: 'market_position',
          referenceId: pos.id,
        });
        txId = added.txId;
        await tx.marketPosition.update({
          where: { id: pos.id },
          data: { closeTxId: txId },
        });
        if (remoteEnabled) await recordPendingSync(tx, entry);
      }

      const after = await tx.user.findUnique({
        where: { id: input.userId },
        select: { driedFish: true },
      });
      return { balance: unitsToFish(after?.driedFish ?? 0), txId };
    });

    // ── Phase 2 / 3：只有真的动了钱才需要同步与补偿 ──────────────────────────
    if (remoteEnabled && payoutUnits > 0) {
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        try {
          await prisma.$transaction(async (tx) => {
            // 3.1 撤流水
            if (phase1.txId !== null) {
              await tx.fishTransaction.deleteMany({ where: { id: phase1.txId } });
            }
            // 3.2 扣回已发的鱼干 —— **条件写**：用户可能已经把刚拿到的鱼干花掉了。
            //     扣不动就抛，整个补偿事务回滚（**绝不部分撤销** —— 那会造出
            //     「仓位还是 closed、钱却没扣回来」的凭空多出来的鱼干）。
            //     与 checkin-service 的补偿段同款。
            const dec = await tx.user.updateMany({
              where: { id: input.userId, driedFish: { gte: payoutUnits } },
              data: { driedFish: { decrement: payoutUnits } },
            });
            if (dec.count === 0) {
              throw new Error(`用户余额不足以回退平仓款（user=${input.userId} units=${payoutUnits}）`);
            }
            // 3.3 把仓位翻回 open —— 这一笔从未成交，用户的持仓原样还在。
            //     closedAt / exitPrice / payoutUnits / closeTxId 一并清掉，别留下
            //     「状态是 open 但带着平仓价」的半截行。
            await tx.marketPosition.update({
              where: { id: pos.id },
              data: {
                status: 'open',
                exitPrice: null,
                exitQuoteAt: null,
                payoutUnits: null,
                closeTxId: null,
                closedAt: null,
              },
            });
            await tx.accountSyncLedger.deleteMany({
              where: { idempotencyKey: entry.idempotencyKey },
            });
          });
        } catch (undoErr) {
          await settleSync(entry.idempotencyKey, 'failed', String(undoErr)).catch(() => {});
          await logReconcileRequired(entry, undoErr);
        }
        console.warn(
          `[market] 平仓远端同步失败，本地写入已补偿回滚（user=${input.userId} pos=${pos.id}）: ${String(syncErr)}`
        );
        throw syncErr instanceof AccountServiceError
          ? syncErr
          : new AccountServiceError(`平仓同步失败: ${String(syncErr)}`, 503);
      }
    }

    return {
      ok: true,
      positionId: pos.id,
      symbol,
      payout: unitsToFish(payoutUnits),
      profit: unitsToFish(payoutUnits - pos.stakeUnits),
      exitPrice,
      balance: phase1.balance,
    };
  } catch (e) {
    if (e instanceof MarketBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
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
    if (e instanceof AccountServiceError) throw e;
    console.error(`[market] 平仓异常（user=${input.userId} pos=${pos.id}）:`, e);
    throw new AccountServiceError(`平仓异常: ${String(e)}`, 503);
  }
}

/** 读余额（鱼干）。给返回值用，不走远端 —— 本地 users.driedFish 才是运营真源。 */
async function getBalanceFish(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { driedFish: true },
  });
  return unitsToFish(row?.driedFish ?? 0);
}
