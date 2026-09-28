// market-stats-service.ts —— 练手盘统计的读路径。
//
// 【这个文件钉的是什么】统计页上那几个数**第二次**被算出来（第一次是平仓那一刻），
// 中间隔着一次查询、一次聚合、一次单位换算。四条最容易静默错的地方在这里钉：
//   1. **来源表**：盈亏只能来自 `market_positions` 的 `payout_units − stake_units`。
//      账本对不上它 —— 强平不写流水、实发为 0 的正常平仓也不写流水。所以这里既验
//      「有流水的那些数对得上」，也验「**没有流水**的已结清行照样进统计」。
//   2. **爆仓行**：e2e 造不出来（强平循环在 e2e 被置成 1 小时），只能在这层用引擎
//      那套夹具造 —— 它要计亏损、要计入爆仓数、且是按 `status` 判而不是按「实发为 0」判。
//   3. **只算自己的**：`where` 少一个 `userId` 就是把全站的数据摊给一个人看。
//   4. **已结清**：平仓与爆仓都算（`open` 的不算 —— 那是持仓那一块的事）。
//
// 【行情源被 mock 掉，是刻意的】同 market-service.test.ts：这里要确定的价格。
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';

vi.mock('@/lib/market-price', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/market-price')>();
  return { ...actual, fetchQuote: vi.fn() };
});

import { fetchQuote } from '@/lib/market-price';
import { openPosition, closePosition, MARKET_SELL_TYPE } from '@/lib/market-service';
import { getMarketStats } from '@/lib/market-stats-service';
import { sweepLiquidations, stopMarketLiquidator } from '@/lib/market-liquidator';

const mockQuote = vi.mocked(fetchQuote);

/** 让之后每一次取价返回这个价。 */
function priceIs(p: number, symbol: 'BTCUSDT' | 'ETHUSDT' = 'BTCUSDT') {
  mockQuote.mockResolvedValue({ symbol, price: p, changePercent: null, quotedAt: nowForDb() });
}

const ENTRY = 80000;
const LIQ_10X = 72000; // 80000 × (1 − 1/10)

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  mockQuote.mockReset();
  stopMarketLiquidator();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * 开一仓（余额经记账内核进入，所以用例末尾能跑记账不变式）。
 *
 * `stakeFish` 是**业务鱼干数**（`openPosition` 的 `amount` 就吃这个），余额另给 ——
 * 默认投 1 条，因为这一层要算的数是「1 条涨 10% 该到手多少」，投 100 条那些断言
 * 全都得乘 100 才成立（而乘出来的数看起来一样合理）。
 */
async function opened(stakeFish = 1, leverage?: number, balanceFish = 100) {
  const user = await makeFishUser(balanceFish);
  priceIs(ENTRY);
  const r = await openPosition({
    userId: user.id,
    symbolRaw: 'BTCUSDT',
    amount: stakeFish,
    ...(leverage == null ? {} : { leverageRaw: leverage }),
  });
  if (!r.ok) throw new Error(`开仓失败: ${r.message}`);
  return { userId: user.id, positionId: r.position.id };
}

/** 直接插一行已结清仓位（**不走服务、不写流水**）—— 用来钉「统计的来源是这张表」。 */
function insertSettledRow(userId: string, over: Partial<{ payoutUnits: number; status: string }> = {}) {
  const id = randomUUID();
  return prisma.marketPosition.create({
    data: {
      id,
      userId,
      symbol: 'BTCUSDT',
      stakeUnits: 10000,
      entryPrice: ENTRY,
      entryQuoteAt: nowForDb(),
      leverage: 1,
      liquidationPrice: 0,
      openKey: `test-${id}`,
      status: over.status ?? 'closed',
      exitPrice: 88000,
      exitQuoteAt: nowForDb(),
      payoutUnits: over.payoutUnits ?? 10997,
      closedAt: nowForDb(),
      createdAt: nowForDb(),
    },
  });
}

describe('已结清的战绩', () => {
  it('走真写路径买卖一轮：笔数 / 盈亏 / 拆解表都对得上那一笔的结算数', async () => {
    const { userId, positionId } = await opened();

    priceIs(88000);
    const closed = await closePosition({ userId, positionId });
    if (!closed.ok) throw new Error(`平仓失败: ${closed.message}`);
    expect(closed.payout).toBe(1.0997); // floor(10000 × 1.1 × 0.9998)

    const stats = await getMarketStats(userId);
    expect(stats.count).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(0);
    expect(stats.winRatePct).toBe(100);
    expect(stats.stakeUnits).toBe(10000);
    expect(stats.payoutUnits).toBe(10997);
    expect(stats.realizedUnits).toBe(997);
    // 存储单位 → 鱼干只在这一处换算
    expect(unitsToFish(stats.realizedUnits)).toBe(0.0997);

    const btc = stats.bySymbol.find((b) => b.key === 'BTCUSDT')!;
    expect(btc.count).toBe(1);
    expect(btc.realizedUnits).toBe(997);
    const eth = stats.bySymbol.find((b) => b.key === 'ETHUSDT')!;
    expect(eth.count).toBe(0);
    expect(eth.winRatePct).toBeNull();
    const one = stats.byLeverage.find((b) => b.key === '1')!;
    expect(one.realizedUnits).toBe(997);

    expectLedgerConsistent('统计读路径不改账，跑一遍是确认开平仓那一侧仍然自洽');
  });

  it('★ 已结清但**没有对应流水**的仓位照样进统计（盈亏的来源是仓位行，不是账本）', async () => {
    // 直接插行、不写流水：这正是「实发为 0 的平仓」与「爆仓」在库里的样子 ——
    // 它们都不写流水。所以任何从 fish_transactions 求和的实现都会漏掉它们。
    const user = await makeUser();
    await insertSettledRow(user.id, { payoutUnits: 10997 });

    const stats = await getMarketStats(user.id);
    expect(stats.count, '统计必须看见这一行').toBe(1);
    expect(stats.payoutUnits).toBe(10997);
    expect(stats.realizedUnits).toBe(997);

    // 账本里一条流水都没有 —— 两个来源在这里**必然对不上**，而统计是对的
    const flows = await prisma.fishTransaction.count({ where: { userId: user.id } });
    expect(flows).toBe(0);
    // 用户是 makeUser 造的（没有鱼干），所以这条不变式仍然成立：0 == 0
    expectLedgerConsistent('直接插行不动账本');
  });

  it('平仓实发合计与账本里的 market_sell 之和相等（今天恰好相等 —— 相等不等于可以换源）', async () => {
    const { userId, positionId } = await opened();
    priceIs(88000);
    await closePosition({ userId, positionId });

    const stats = await getMarketStats(userId);
    const sells = await prisma.fishTransaction.aggregate({
      where: { userId, type: MARKET_SELL_TYPE },
      _sum: { amount: true },
    });
    expect(stats.payoutUnits).toBe(sells._sum.amount ?? 0);
    // 反过来说明为什么**不能**反过来用账本当来源：见上一条（没有流水的那两类平仓）
    expectLedgerConsistent();
  });

  it('只算自己的：另一个人的仓位不进我的统计', async () => {
    const me = await opened();
    priceIs(88000);
    await closePosition({ userId: me.userId, positionId: me.positionId });

    const other = await makeUser();
    await insertSettledRow(other.id, { payoutUnits: 50000 });

    const stats = await getMarketStats(me.userId);
    expect(stats.count).toBe(1);
    expect(stats.payoutUnits).toBe(10997);
  });

  it('还开着的仓位不算已结清（它归「当前持仓」那一块）', async () => {
    const { userId } = await opened();
    const stats = await getMarketStats(userId);
    expect(stats.count).toBe(0);
    expect(stats.incomplete).toBe(0);
    expect(stats.winRatePct).toBeNull();
  });

  it('爆仓行：计亏损、计入爆仓数，且它是按 status 判的不是按实发判的', async () => {
    const { userId, positionId } = await opened(1, 10);

    // 现价跌破爆仓价 → 引擎结清（结算价写的是爆仓价，实发恒为 0）
    priceIs(LIQ_10X - 1);
    expect(await sweepLiquidations()).toBe(1);
    expect((await prisma.marketPosition.findUnique({ where: { id: positionId } }))?.status).toBe(
      'liquidated'
    );

    const stats = await getMarketStats(userId);
    expect(stats.count).toBe(1);
    expect(stats.liquidated).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.realizedUnits).toBe(-10000); // 亏光投入
    expect(stats.payoutUnits).toBe(0);

    // ★ 强平不写流水 —— 所以「实发合计」只能来自 payout_units
    const flows = await prisma.fishTransaction.count({
      where: { userId, type: MARKET_SELL_TYPE },
    });
    expect(flows).toBe(0);
    expectLedgerConsistent('强平不动账本');
  });

  it('★ 手动平掉一个跌穿爆仓价的杠杆仓：同样计亏损，但**不算爆仓**', async () => {
    const { userId, positionId } = await opened(1, 10);

    // 现价在爆仓价之下，但**不让引擎扫**（引擎没在跑/这一轮没 tick），用户自己按卖出。
    // 走的是同一个 max(0, …)，实发同样是 0 —— 只有 status 分得开这两件事。
    priceIs(LIQ_10X - 1);
    const closed = await closePosition({ userId, positionId });
    if (!closed.ok) throw new Error(`平仓失败: ${closed.message}`);
    expect(closed.payout, '跌穿爆仓价手动平也是 0').toBe(0);

    const stats = await getMarketStats(userId);
    expect(stats.losses).toBe(1);
    expect(stats.liquidated, '它是手动平的，不是爆仓').toBe(0);
    expect(stats.realizedUnits).toBe(-10000);
    expectLedgerConsistent();
  });
});
