// market-service.ts —— 练手盘开仓 / 平仓的**本地语义**（dev fallback 分支）。
//
// 【行情源被 mock 掉，是刻意的】这个文件测的是「钱怎么走」：扣款、流水、position 行、
// 结算公式、边界、幂等、并发。价格必须是**确定的**，否则断言「涨 10% 该 mint 多少」
// 根本写不出来。真实行情源的解析由 tests/unit/market-price.test.ts 负责。
//
// 【与 fail-closed 的分工】本文件跑真实模块 + dev fallback（tests/setup.ts 把
// ACCOUNT_SERVICE_INTERNAL_TOKEN 置空 → accountServiceEnabled() 恒 false →
// 只写本地、不登记账本）。远端失败零痕迹 / 补偿 / 账本那套在 market-failclosed 里测。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';

// 只替换 fetchQuote，其余（parseSymbol / MarketPriceError / MARKET_SYMBOLS）保持真身 ——
// 那些是纯逻辑，mock 掉就等于把被测的白名单校验也一起假掉了。
vi.mock('@/lib/market-price', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/market-price')>();
  return { ...actual, fetchQuote: vi.fn() };
});

import { fetchQuote, MarketPriceError } from '@/lib/market-price';
import {
  openPosition,
  closePosition,
  listOpenPositions,
  MARKET_BUY_TYPE,
  MARKET_SELL_TYPE,
  MARKET_FEE_RATE,
} from '@/lib/market-service';

const mockQuote = vi.mocked(fetchQuote);

/** 让下一次（以及之后每一次）取价返回这个价。 */
function priceIs(p: number, symbol: 'BTCUSDT' | 'ETHUSDT' = 'BTCUSDT') {
  mockQuote.mockResolvedValue({
    symbol,
    price: p,
    changePercent: null,
    quotedAt: nowForDb(),
  });
}

beforeEach(async () => {
  await resetDb();
  // 限频桶是进程内 Map（不随 DB 清空）：不清的话用例之间互相吃额度，
  // 表现为「明明只下了几单却 429」。
  __resetRateLimitStore();
  mockQuote.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

const txnsOf = (userId: string) =>
  prisma.fishTransaction.findMany({ where: { userId }, orderBy: { id: 'asc' } });

/** 开一仓，返回 userId 与 positionId。 */
async function opened(fish = 100, entryPrice = 80000) {
  const user = await makeUser({ driedFish: fish });
  priceIs(entryPrice);
  const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
  if (!r.ok) throw new Error(`开仓失败: ${r.message}`);
  return { userId: user.id, positionId: r.position.id };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('开仓', () => {
  it('扣款、写一条负数流水、建一行 open 持仓', async () => {
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);

    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.position.symbol).toBe('BTCUSDT');
    expect(r.position.stake).toBe(30);
    expect(r.position.entryPrice).toBe(80000);
    expect(r.balance).toBe(70);

    const txns = await txnsOf(user.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe(MARKET_BUY_TYPE);
    expect(txns[0].amount).toBe(-300000); // 存储单位 = 0.0001 鱼干
    expect(txns[0].createdAt).not.toBeNull(); // 漏写 createdAt 会让流水倒序静默错乱
    expect(txns[0].referenceId).toBe(r.position.id);

    const pos = await prisma.marketPosition.findUnique({ where: { id: r.position.id } });
    expect(pos?.status).toBe('open');
    expect(pos?.stakeUnits).toBe(300000);
    expect(pos?.openTxId).toBe(txns[0].id);
    expect(pos?.closedAt).toBeNull();

    expect(await listOpenPositions(user.id)).toHaveLength(1);
  });

  it('鱼干不足：400，且**零痕迹**（不建仓、不写流水）', async () => {
    const user = await makeUser({ driedFish: 5 });
    priceIs(80000);

    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(400);
    expect(r.message).toContain('不足');

    expect(await balanceOf(user.id)).toBe(5);
    expect(await txnsOf(user.id)).toHaveLength(0);
    expect(await listOpenPositions(user.id)).toHaveLength(0);
  });

  // 顺序纪律：**入参校验**在限频之前（刷垃圾参数不该烧自己的额度，对齐点赞/评论）。
  // ⚠️ 余额不足**不**享受这条豁免 —— 它在事务里，位于限频之后（转账那套同理）。
  // 那不是缺陷：一个余额够不着的账号反复点购买，本身就该被刹住。
  it('入参非法不消耗限频额度（校验在前、限频在后）', async () => {
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);
    for (let i = 0; i < RULES.tradeMinute.limit + 5; i++) {
      const r = await openPosition({ userId: user.id, symbolRaw: 'DOGEUSDT', amount: 10 });
      expect(r.ok).toBe(false);
    }
    const ok = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 10 });
    expect(ok.ok, '额度不该被垃圾参数的请求吃光').toBe(true);
  });

  it('非法标的 / 金额格式 / 低于最小投入 一律 400，且不取价', async () => {
    const user = await makeUser({ driedFish: 100 });

    for (const [symbolRaw, amount, hint] of [
      ['DOGEUSDT', 10, '不支持的标的'],
      ['BTCUSDT', 0, '大于 0'],
      ['BTCUSDT', -5, '大于 0'],
      ['BTCUSDT', Number.NaN, '大于 0'],
      ['BTCUSDT', 0.00005, '4 位小数'], // 5 位小数：fishToUnits fail-loud
      ['BTCUSDT', 0.5, '最少投入'], // 精度合法，但低于下限
      [null, 10, '不支持的标的'],
      ['BTCUSDT', '10' as unknown as number, '大于 0'],
    ] as const) {
      const r = await openPosition({ userId: user.id, symbolRaw, amount });
      expect(r.ok, `${String(symbolRaw)} / ${String(amount)}`).toBe(false);
      if (!r.ok) expect(r.message, hint).toContain(hint);
    }
    expect(mockQuote, '被拒的请求不该去打行情源').not.toHaveBeenCalled();
    expect(await txnsOf(user.id)).toHaveLength(0);
  });

  it('★ 行情源取不到价 → 503 且零痕迹（绝不退回缓存价成交）', async () => {
    const user = await makeUser({ driedFish: 100 });
    mockQuote.mockRejectedValue(new MarketPriceError('行情源不可达'));

    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(503);

    expect(await balanceOf(user.id)).toBe(100);
    expect(await txnsOf(user.id)).toHaveLength(0);
    expect(await listOpenPositions(user.id)).toHaveLength(0);
  });

  it('同键重放：只建一个仓位、只扣一次钱', async () => {
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);

    const a = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40, clientKey: 'mrk-1' });
    const b = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40, clientKey: 'mrk-1' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.position.id).toBe(a.position.id);
      expect(b.replayed).toBe(true);
    }
    expect(await balanceOf(user.id)).toBe(60);
    expect(await txnsOf(user.id)).toHaveLength(1);
    expect(await listOpenPositions(user.id)).toHaveLength(1);
  });

  it('★ 同额但不给键 → 是两笔新仓（分批建仓是正常操作，别被幂等吃掉）', async () => {
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);

    await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 });
    await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 });

    expect(await balanceOf(user.id)).toBe(20);
    expect(await listOpenPositions(user.id)).toHaveLength(2);
  });

  it('两个用户用同一个客户端键不会互相挡住（键混进了身份哈希）', async () => {
    const a = await makeUser({ driedFish: 100 });
    const b = await makeUser({ driedFish: 100 });
    priceIs(80000);

    const ra = await openPosition({ userId: a.id, symbolRaw: 'BTCUSDT', amount: 10, clientKey: 'same-key' });
    const rb = await openPosition({ userId: b.id, symbolRaw: 'BTCUSDT', amount: 10, clientKey: 'same-key' });
    expect(ra.ok && rb.ok).toBe(true);
    expect(await listOpenPositions(a.id)).toHaveLength(1);
    expect(await listOpenPositions(b.id)).toHaveLength(1);
  });

  it('客户端键格式非法 → 400', async () => {
    const user = await makeUser({ driedFish: 100 });
    const r = await openPosition({
      userId: user.id, symbolRaw: 'BTCUSDT', amount: 10,
      clientKey: 'x'.repeat(49),
    });
    expect(r.ok).toBe(false);
  });

  it('超过分钟档 → 429（每笔都要现取行情 + 一次远端转账，不封顶就是出站放大器）', async () => {
    const user = await makeUser({ driedFish: 100_000 });
    priceIs(80000);
    const limit = RULES.tradeMinute.limit;

    for (let i = 0; i < limit; i++) {
      const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 1 });
      expect(r.ok, `第 ${i + 1} 单应放行`).toBe(true);
    }
    const over = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('平仓', () => {
  it('涨价 → 按比例 mint，扣 0.1% 手续费（floor 舍入朝系统一侧）', async () => {
    const { userId, positionId } = await opened(100, 80000);

    priceIs(88000); // +10%
    const r = await closePosition({ userId, positionId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 100 鱼干 = 1e6 单位 → gross = 1.1e6 → ×0.999 = 1,098,900 → floor = 1,098,900 = 109.89 鱼干
    // （精度还是 0.1 鱼干时这里是 109.8 —— 差的那 0.09 正是 floor 少丢的零头）
    expect(r.payout).toBe(109.89);
    expect(r.profit).toBeCloseTo(9.89, 10);
    expect(r.exitPrice).toBe(88000);
    expect(r.balance).toBe(109.89);

    const txns = await txnsOf(userId);
    expect(txns).toHaveLength(2);
    expect(txns[1].type).toBe(MARKET_SELL_TYPE);
    expect(txns[1].amount).toBe(1098900);

    const pos = await prisma.marketPosition.findUnique({ where: { id: positionId } });
    expect(pos?.status).toBe('closed');
    expect(pos?.payoutUnits).toBe(1098900);
    expect(pos?.exitPrice).toBe(88000);
    expect(pos?.closeTxId).toBe(txns[1].id);
    expect(pos?.closedAt).not.toBeNull();

    expect(await listOpenPositions(userId)).toHaveLength(0);
  });

  it('跌价 → burn（用户拿回的就少了，差额留给了系统水池）', async () => {
    const { userId, positionId } = await opened(100, 80000);

    priceIs(72000); // -10%
    const r = await closePosition({ userId, positionId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // gross = 1e6×0.9 = 9e5 → ×0.999 = 899,100 → floor = 89.91
    expect(r.payout).toBe(89.91);
    expect(r.profit).toBeCloseTo(-10.09, 10);
    expect(r.balance).toBe(89.91);
  });

  it('★ 实发为 0 的边界：平仓成功、**不写流水**、不抛 500', async () => {
    // 投 1 条鱼干（10000 个单位），跌 99.99% → floor(1e4 × 0.0001 × 0.999) = floor(0.999) = 0
    //
    // ⚠️ 精度提到 0.0001 之后，这条边界**要跌 99.99% 才够得着**（旧粒度下跌 90% 就归零了：
    // floor(10 × 0.1 × 0.999) = 0）。留着它仍是对的 —— 实发 0 在数学上依然可能，
    // 而服务端必须正确处理那一档（不写流水、不发通知、仓位照样平掉）。
    const user = await makeUser({ driedFish: 10 });
    priceIs(80000);
    const o = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 1 });
    expect(o.ok).toBe(true);
    if (!o.ok) return;

    priceIs(8);
    const r = await closePosition({ userId: user.id, positionId: o.position.id });
    expect(r.ok, '归零不该是 500').toBe(true);
    if (!r.ok) return;

    expect(r.payout).toBe(0);
    expect(r.profit).toBeCloseTo(-1, 10);
    expect(await balanceOf(user.id)).toBe(9); // 10 − 1（投入） + 0（实发）

    // 只有开仓那一条流水 —— 平仓没有钱动过，就不该有流水行
    const txns = await txnsOf(user.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe(MARKET_BUY_TYPE);

    const pos = await prisma.marketPosition.findUnique({ where: { id: o.position.id } });
    expect(pos?.status).toBe('closed');
    expect(pos?.payoutUnits).toBe(0);
  });

  it('★ 低于最小投入的仓位开不出来（下限现在只剩产品理由，不再是防舍入陷阱）', async () => {
    // 这个下限**原来是防舍入陷阱的**：粒度 0.1 条时投 0.1 条、价格不涨过 0.1% 就必然
    // 结算成 0。精度提到 0.0001 之后那条理由失效了（每次结算的零头上界降到 0.0001 条），
    // 下限改由「尘埃仓位只是库里一行 + 页面上一条的噪音」支撑。
    // 断言本身不变 —— 变的是它为什么在这里。
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);
    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 0.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('最少投入');
  });

  it('★ 重复平仓 = 重放：不动钱、不重复发', async () => {
    const { userId, positionId } = await opened(100, 80000);
    priceIs(88000);
    const first = await closePosition({ userId, positionId });
    expect(first.ok).toBe(true);

    // 价格已经变了，但重放必须回报**当初结算的那个数**，而不是按新价重算
    priceIs(200000);
    const second = await closePosition({ userId, positionId });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.replayed).toBe(true);
    expect(second.payout).toBe(first.payout);
    expect(second.exitPrice).toBe(first.exitPrice);
    expect(await balanceOf(userId)).toBe(first.payout);
    expect(await txnsOf(userId)).toHaveLength(2);
  });

  it('重放不该消耗限频额度，也不该因为行情源挂了而 503', async () => {
    const { userId, positionId } = await opened(100, 80000);
    priceIs(88000);
    await closePosition({ userId, positionId });

    mockQuote.mockRejectedValue(new MarketPriceError('挂了'));
    const again = await closePosition({ userId, positionId });
    expect(again.ok, '已平过的仓位不该因为此刻取不到价就报 503').toBe(true);
  });

  it('别人的仓位 → 404（不是 403 —— 那等于确认这个 id 存在）', async () => {
    const { positionId } = await opened(100, 80000);
    const other = await makeUser({ driedFish: 0 });
    priceIs(88000);

    const r = await closePosition({ userId: other.id, positionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(404);
  });

  it('不存在的仓位 → 404', async () => {
    const user = await makeUser({ driedFish: 0 });
    const r = await closePosition({ userId: user.id, positionId: 'no-such-position' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(404);
  });

  it('★ 并发平仓只成交一次（条件写挡住后来者）', async () => {
    const { userId, positionId } = await opened(100, 80000);
    priceIs(88000);

    const [a, b] = await Promise.all([
      closePosition({ userId, positionId }),
      closePosition({ userId, positionId }),
    ]);
    expect(a.ok && b.ok).toBe(true);

    // 关键断言：钱只发了一次
    expect(await balanceOf(userId)).toBe(109.89);
    const sellTxns = (await txnsOf(userId)).filter((t) => t.type === MARKET_SELL_TYPE);
    expect(sellTxns, '并发平仓只该产生一条卖出流水').toHaveLength(1);
    if (a.ok && b.ok) expect(a.payout).toBe(b.payout);
  });

  it('★ 取不到价 → 拒单，仓位原样不动', async () => {
    const { userId, positionId } = await opened(100, 80000);
    mockQuote.mockRejectedValue(new MarketPriceError('不可达'));

    const r = await closePosition({ userId, positionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(503);

    const pos = await prisma.marketPosition.findUnique({ where: { id: positionId } });
    expect(pos?.status, '拒单后仓位必须还是 open').toBe('open');
    expect(pos?.exitPrice).toBeNull();
    expect(await balanceOf(userId)).toBe(0); // 开仓花光了 100
    expect(await listOpenPositions(userId)).toHaveLength(1);
  });

  it('手续费率是 0.1%（改它要同步对外文档）', () => {
    expect(MARKET_FEE_RATE).toBe(0.001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('listOpenPositions', () => {
  it('只列 open 的、最近开的在前', async () => {
    const user = await makeUser({ driedFish: 100 });
    priceIs(80000);
    const first = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 10 });
    await new Promise((r) => setTimeout(r, 5));
    priceIs(3000);
    const second = await openPosition({ userId: user.id, symbolRaw: 'ETHUSDT', amount: 10 });
    expect(first.ok && second.ok).toBe(true);

    const list = await listOpenPositions(user.id);
    expect(list).toHaveLength(2);
    expect(list[0].symbol).toBe('ETHUSDT'); // 后开的在前

    if (second.ok) await closePosition({ userId: user.id, positionId: second.position.id });
    const after = await listOpenPositions(user.id);
    expect(after).toHaveLength(1);
    expect(after[0].symbol).toBe('BTCUSDT');
  });
});
