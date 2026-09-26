// market-liquidator.ts —— 练手盘强平引擎的本地语义。
//
// 【这个文件钉的是什么】引擎是**本站第一个会自己动手结清仓位的后台循环**，所以这里
// 断的不是「算术对不对」（那是 market-math.test.ts 的事），而是四件事：
//   1. 触发判据（现价 ≤ 爆仓价）与**结算价 = 爆仓价**（不是现价 —— 见那里的文件头）；
//   2. 强平**不写鱼干流水**（爆仓价处实发为 0，没有钱动过）；
//   3. 幂等与并发：用户自己先平了的仓位不会被它「复活」；
//   4. 闸门：引擎没在跑时**杠杆开仓被拒**，而 1 倍照旧。
//
// 【行情源被 mock 掉，是刻意的】同 market-service.test.ts：这里要确定的价格。
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, prisma } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { unitsToFish } from '@/lib/fish-units';

vi.mock('@/lib/market-price', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/market-price')>();
  return { ...actual, fetchQuote: vi.fn() };
});

import { fetchQuote, MarketPriceError } from '@/lib/market-price';
import { openPosition, closePosition } from '@/lib/market-service';
import {
  sweepLiquidations,
  scanLiquidations,
  isLiquidationRunning,
  __setLiquidationRunning,
  startMarketLiquidator,
  stopMarketLiquidator,
  liquidationIntervalMs,
  DEFAULT_LIQUIDATE_MS,
} from '@/lib/market-liquidator';

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
  // stop 会把运行标志**删掉**（不是写 false）→ 回到测试进程的默认口径（放行）。
  // 它同时也是每个用例之间的清场：别让上一个用例摆过的状态漏给下一个。
  stopMarketLiquidator();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const posRow = (id: string) => prisma.marketPosition.findUnique({ where: { id } });
const txnsOf = (userId: string) => prisma.fishTransaction.findMany({ where: { userId } });

/** 开一仓杠杆仓（余额经由记账内核进入，所以能跑记账不变式）。 */
async function openedLeveraged(leverage = 10, fish = 100) {
  const user = await makeFishUser(fish);
  priceIs(ENTRY);
  const r = await openPosition({
    userId: user.id,
    symbolRaw: 'BTCUSDT',
    amount: 100,
    leverageRaw: leverage,
  });
  if (!r.ok) throw new Error(`开仓失败: ${r.message}`);
  return { userId: user.id, positionId: r.position.id };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('触发判据', () => {
  it('现价跌破爆仓价 → 结清：status=liquidated、exit_price=**爆仓价**、payout=0', async () => {
    const { userId, positionId } = await openedLeveraged(10);

    // 喂一个**与爆仓价不同**的现价（71999 ≠ 72000）：下面那条断言于是真的在验
    // 「写的是爆仓价而不是现价」，而不是在验一个两边恰好相等的数。
    const live = LIQ_10X - 1;
    priceIs(live);
    expect(await sweepLiquidations()).toBe(1);

    const pos = await posRow(positionId);
    expect(pos?.status).toBe('liquidated');
    // ★ 结算价是**存着的那条线**，不是触发时的现价 —— 见引擎文件头（封顶 + 时间无关）
    expect(pos?.exitPrice).toBe(LIQ_10X);
    expect(pos?.exitPrice).not.toBe(live);
    expect(pos?.payoutUnits).toBe(0);
    expect(pos?.closedAt).not.toBeNull();
    expect(await listOpenCount(userId)).toBe(0);
  });

  it('现价**恰好**等于爆仓价也爆（判据是 ≤，不是 <）', async () => {
    const { positionId } = await openedLeveraged(10);
    priceIs(LIQ_10X);
    expect(await sweepLiquidations()).toBe(1);
    expect((await posRow(positionId))?.status).toBe('liquidated');
  });

  it('还差一点（现价在爆仓价之上）不动它', async () => {
    const { positionId } = await openedLeveraged(10);
    priceIs(LIQ_10X + 1);
    expect(await sweepLiquidations()).toBe(0);
    expect((await posRow(positionId))?.status).toBe('open');
  });

  it('1 倍仓**结构上不可能**被强平 —— 价格跌到 1 也不动', async () => {
    const user = await makeFishUser(100);
    priceIs(ENTRY);
    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
    if (!r.ok) throw new Error(r.message);

    priceIs(1);
    expect(await sweepLiquidations()).toBe(0);
    const pos = await posRow(r.position.id);
    expect(pos?.status).toBe('open');
    // 1 倍仓的爆仓价就是 0（价格到不了 0 以下）—— 它不是「还没算」的占位值
    expect(pos?.liquidationPrice).toBe(0);
  });

  it('不同标的各按各的价判（同一轮里两个仓位，只有一个该爆）', async () => {
    const user = await makeFishUser(200);
    priceIs(ENTRY, 'BTCUSDT');
    const btc = await openPosition({
      userId: user.id, symbolRaw: 'BTCUSDT', amount: 100, leverageRaw: 10,
    });
    priceIs(ENTRY, 'ETHUSDT');
    const eth = await openPosition({
      userId: user.id, symbolRaw: 'ETHUSDT', amount: 100, leverageRaw: 10,
    });
    if (!btc.ok || !eth.ok) throw new Error('开仓失败');

    // BTC 跌穿、ETH 没动。取价**按标的**分别返回（不是按调用顺序 —— 引擎按 Map 的
    // 插入序扫，把期望押在顺序上会让用例随实现细节变脆）。
    mockQuote.mockImplementation(async (sym) => ({
      symbol: sym,
      price: sym === 'BTCUSDT' ? LIQ_10X - 1 : ENTRY,
      changePercent: null,
      quotedAt: nowForDb(),
    }));

    expect(await sweepLiquidations()).toBe(1);
    expect((await posRow(btc.position.id))?.status).toBe('liquidated');
    expect((await posRow(eth.position.id))?.status).toBe('open');
  });
});

describe('强平不碰账本', () => {
  it('爆仓**不写鱼干流水**：开仓那一条负数流水就是全部', async () => {
    const { userId, positionId } = await openedLeveraged(10);
    // 夹具的 admin_grant（让余额有来源）+ 开仓那条 market_buy = 2 条
    expect(await txnsOf(userId)).toHaveLength(2);

    priceIs(LIQ_10X - 1);
    expect(await sweepLiquidations()).toBe(1);

    // ★ 没有钱动过 —— 实发为 0，与「实发为 0 的平仓」同一档（见 market-service 头部）
    const txns = await txnsOf(userId);
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.type).sort()).toEqual(['admin_grant', 'market_buy']);
    // 用户的钱就停在「投入全亏」上：余额 = 初始 − 投入
    expect(await balanceOf(userId)).toBe(0);
    expect((await posRow(positionId))?.closeTxId).toBeNull();

    // 记账不变式（新增鱼干写路径的纪律：末尾调一次）
    await expectLedgerConsistent('强平之后');
  });
});

describe('幂等与并发', () => {
  it('用户先自己平了 → 引擎不改它（不会「复活」成 liquidated）', async () => {
    const { positionId } = await openedLeveraged(10);

    // 用户手动平掉（价格已经跌穿，实发 0 —— 与强平同数，见 market-math.ts）
    const user = (await posRow(positionId))!.userId;
    priceIs(LIQ_10X - 1);
    const r = await closePosition({ userId: user, positionId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payout).toBe(0);

    // 引擎再扫一轮：什么都不该发生，尤其是**不能**把 status 改成 liquidated
    expect(await sweepLiquidations()).toBe(0);
    expect((await posRow(positionId))?.status).toBe('closed');
  });

  it('扫两轮：第二轮不再重复结清（同一仓只算一次）', async () => {
    await openedLeveraged(10);
    priceIs(LIQ_10X - 1);
    expect(await sweepLiquidations()).toBe(1);
    expect(await sweepLiquidations()).toBe(0);
  });
});

describe('行情源不可用时', () => {
  it('取价失败 → 本轮跳过，仓位原样留着（不降级、不拿假价爆）', async () => {
    const { positionId } = await openedLeveraged(10);
    mockQuote.mockRejectedValue(new MarketPriceError('boom'));

    expect(await sweepLiquidations()).toBe(0);
    expect((await posRow(positionId))?.status).toBe('open');
  });

  it('行情恢复后那一轮照旧会爆（跳过只是延后，不是放弃）', async () => {
    const { positionId } = await openedLeveraged(10);
    mockQuote.mockRejectedValue(new MarketPriceError('boom'));
    expect(await sweepLiquidations()).toBe(0);

    priceIs(LIQ_10X - 1);
    expect(await sweepLiquidations()).toBe(1);
    expect((await posRow(positionId))?.status).toBe('liquidated');
  });

  it('没有任何杠杆仓时一次行情源都不打（空扫是免费的）', async () => {
    mockQuote.mockClear();
    expect(await sweepLiquidations()).toBe(0);
    expect(mockQuote).not.toHaveBeenCalled();
  });
});

describe('闸门：引擎没在跑就不卖杠杆', () => {
  it('isLiquidationRunning 在测试进程里默认为真（循环本就不加载）', () => {
    expect(isLiquidationRunning()).toBe(true);
  });

  it('显式关掉之后：杠杆开仓 503，**1 倍照旧能开**', async () => {
    const user = await makeFishUser(200);
    __setLiquidationRunning(false);
    priceIs(ENTRY);

    const lev = await openPosition({
      userId: user.id, symbolRaw: 'BTCUSDT', amount: 100, leverageRaw: 10,
    });
    expect(lev.ok).toBe(false);
    if (!lev.ok) {
      expect(lev.code).toBe(503);
      expect(lev.message).toContain('杠杆');
    }
    // 1 倍不受影响：它永远碰不到爆仓价，不需要引擎
    const plain = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
    expect(plain.ok).toBe(true);

    // 零痕迹：被拒的那笔没有扣款、没有建仓 —— 流水只有两条（夹具的 admin_grant
    // + 刚才那笔 1 倍），100 条 10× 那条一条都没留下。
    const txns = await txnsOf(user.id);
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.type).sort()).toEqual(['admin_grant', 'market_buy']);
    expect(await balanceOf(user.id)).toBe(100); // 200 − 100（只扣了 1 倍那笔）
    await expectLedgerConsistent('杠杆被拒之后');
  });

  it('★ stopMarketLiquidator 不能把闸门永久关死 ★（写 false 就会波及同文件后面的用例）', async () => {
    __setLiquidationRunning(false);
    stopMarketLiquidator();
    // 删标志 = 回到默认口径，而不是把进程钉在「引擎没跑」上
    expect(isLiquidationRunning()).toBe(true);
  });

  it('启动尝试在测试进程里直接返回 false（NODE_ENV=test 那道保险）', () => {
    expect(startMarketLiquidator()).toBe(false);
  });
});

describe('scanLiquidations（只读预览）', () => {
  it('★ 只读：列出该爆的，但**一个字节都不写**（CLI 确认屏靠这条）', async () => {
    const { positionId } = await openedLeveraged(10);
    priceIs(LIQ_10X - 1);

    const { due, skipped } = await scanLiquidations();
    expect(skipped).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(positionId);
    expect(due[0].leverage).toBe(10);
    expect(due[0].liquidationPrice).toBe(LIQ_10X);
    expect(due[0].currentPrice).toBe(LIQ_10X - 1); // 判据用的是现价
    expect(due[0].stakeUnits).toBe(1_000_000);

    // ★ CLI 的 describe 跑在确认闸**之前**，「写库绝不允许发生在这里」——
    // 所以扫完之后那一行必须原样躺着（这是这条用例存在的全部理由）
    const pos = await posRow(positionId);
    expect(pos?.status).toBe('open');
    expect(pos?.payoutUnits).toBeNull();
    expect(pos?.exitPrice).toBeNull();
    expect(pos?.closedAt).toBeNull();
    expect(await txnsOf(pos!.userId)).toHaveLength(2); // 夹具 + 开仓
  });

  it('没到线的仓位不出现在名单里', async () => {
    await openedLeveraged(10);
    priceIs(LIQ_10X + 1);
    expect((await scanLiquidations()).due).toEqual([]);
  });

  it('取价失败的标的进 skipped（确认屏要把「这轮没扫成」说出来）', async () => {
    await openedLeveraged(10);
    mockQuote.mockRejectedValue(new MarketPriceError('boom'));

    const { due, skipped } = await scanLiquidations();
    expect(due).toEqual([]);
    expect(skipped).toEqual([{ symbol: 'BTCUSDT', reason: '行情源不可用' }]);
  });

  it('没有任何杠杆仓时一次行情源都不打', async () => {
    mockQuote.mockClear();
    const { due } = await scanLiquidations();
    expect(due).toEqual([]);
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it('扫描说该爆、真正动手是**重新扫一遍**（不是复用那份名单）', async () => {
    // 扫描拿到「该爆」，但在动手之前价格弹回去了 —— sweep 自己重扫，于是什么都不做。
    // 这正是「预览给你看、执行重新判」那条纪律的落点：拿旧扫描去结清 = 对着一个
    // 过期的世界动手。
    const { positionId } = await openedLeveraged(10);
    priceIs(LIQ_10X - 1);
    expect((await scanLiquidations()).due).toHaveLength(1);

    priceIs(LIQ_10X + 1); // 弹回去了
    expect(await sweepLiquidations()).toBe(0);
    expect((await posRow(positionId))?.status).toBe('open');
  });
});

describe('间隔配置', () => {
  it('默认 15 秒；0 / 负数 / 非数字 = 关闭（运维开关）', () => {
    // ⚠️ 先清掉环境变量：tests/setup.ts 把 MARKET_LIQUIDATE_MS 置成了 '0'（那条循环
    // 在测试进程里本来也不跑，置 0 是沿用另外三个循环的写法）。不 stub 掉这一句，
    // 「默认值」断的就是 setup.ts 设的那个数，而不是代码里的默认值。
    vi.stubEnv('MARKET_LIQUIDATE_MS', '');
    expect(liquidationIntervalMs()).toBe(DEFAULT_LIQUIDATE_MS);
    for (const raw of ['0', '-1', 'abc']) {
      vi.stubEnv('MARKET_LIQUIDATE_MS', raw);
      expect(liquidationIntervalMs(), `MARKET_LIQUIDATE_MS=${raw}`).toBe(0);
    }
    vi.stubEnv('MARKET_LIQUIDATE_MS', '5000');
    expect(liquidationIntervalMs()).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function listOpenCount(userId: string): Promise<number> {
  return prisma.marketPosition.count({ where: { userId, status: 'open' } });
}

async function balanceOf(id: string): Promise<number> {
  return unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );
}
