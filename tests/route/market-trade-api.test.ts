// 练手盘四个接口的**鉴权分叉与档位**。
//
// 【为什么单独一个文件】这里打的是真实 route handler，重点在「页面与接口必须同档」：
// core+ 这一档在页面（/fish/trade）、buy、sell、quote、candles 五处各判一次，
// 任何一处漏判都是一扇绕开档位的门 —— 而功能照常工作、测试照常绿。service 层的钱
// 怎么走由 tests/service/market-*.test.ts 负责，这个文件不重复测那些。
//
// 【禁言判定是**不对称**的，别「统一」】档位那一列是五处的**并集**，禁言不是：
// 只有 buy 判禁言（禁言不开新仓），sell / quote / candles 只判档位 —— 已开的仓位
// 必须能出、盘必须看得见，否则禁言顺带变成锁仓。理由见
// src/app/api/fish/trade/sell/route.ts 头部。
//
// 【行情源打桩，是刻意的】成交价必须**现取**（那是练手盘唯一的安全边界：拿展示缓存
// 成交 = 看盘的人可以在价格跳动后、缓存刷新前下单，无风险、可重复、无上限的套利）。
// 但真实价格是外部世界的变量，断言「涨 10% 该 mint 多少」写不出来 —— 所以在**测试**
// 这一侧打桩，且有一条用例专门钉住「取价失败就拒单，绝不退回展示缓存」。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）：账目与业务数据在同一个库里、同一个事务。
// 跑过钱路径的用例末尾都用 expectLedgerConsistent() 收口（见 tests/helpers/fish-ledger.ts）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

// 故障注入开关：默认关，只有「事务失败 → 500 且回滚」那两条用例打开它。
//
// 【为什么在记账内核这一层注入】它是**事务内**唯一能把「钱已经写了」与「事务还没提交」
// 同时摆出来的位置 —— 断言才真的落在「整笔回滚」上，而不是「根本没进去」这个空洞的
// 真命题上。包装是纯透传的（先跑真身，再决定要不要炸），所以其余用例照旧跑真实现。
const { failAfterPostEntry } = vi.hoisted(() => ({ failAfterPostEntry: { on: false } }));

vi.mock('@/lib/fish-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fish-service')>();
  return {
    ...actual,
    postEntry: async (...args: Parameters<typeof actual.postEntry>) => {
      const res = await actual.postEntry(...args);
      if (failAfterPostEntry.on) throw new Error('注入的故障：记账已写入，提交前炸');
      return res;
    },
  };
});

const { mockQuote, mockCandles } = vi.hoisted(() => ({
  mockQuote: vi.fn<(symbol: string) => Promise<unknown>>(),
  mockCandles: vi.fn<(symbol: string, interval?: string) => Promise<unknown>>(),
}));

vi.mock('@/lib/market-price', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/market-price')>();
  // getCandles 也要打桩：它是**唯一会出站**的只读读口，真跑会去连币安
  return {
    ...actual,
    fetchQuote: mockQuote,
    getCachedQuotes: vi.fn(),
    getCandles: mockCandles,
  };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { createSessionToken } from '@/lib/session';
import { nowForDb } from '@/lib/db-time';
import { unitsToFish } from '@/lib/fish-units';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { MarketPriceError, getCachedQuotes } from '@/lib/market-price';
import { MARKET_BUY_TYPE } from '@/lib/market-service';
import { sweepLiquidations, __setLiquidationRunning } from '@/lib/market-liquidator';
import { POST as buy } from '@/app/api/fish/trade/buy/route';
import { POST as sell } from '@/app/api/fish/trade/sell/route';
import { GET as quote } from '@/app/api/fish/trade/quote/route';
import { GET as candles } from '@/app/api/fish/trade/candles/route';

function makeReq(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

/** 让下一次（以及之后每一次）取价返回这个价。 */
const priceIs = (p: number) =>
  mockQuote.mockResolvedValue({
    symbol: 'BTCUSDT', price: p, changePercent: null, quotedAt: nowForDb(),
  });

/**
 * 造一个 core+ 且已登录的用户。
 *
 * 初始鱼干用 makeFishUser 造（余额经由记账内核进入，与线上同构）——
 * expectLedgerConsistent 断的是「余额 == 该用户所有流水之和」，
 * 直接 `makeUser({ driedFish: N })` 塞出来的无来源余额在它眼里就是一条撕裂的账。
 */
async function makeCoreUser(driedFish = 100, role: 'core' | 'admin' | 'owner' = 'core') {
  const u = await makeFishUser(driedFish, { role });
  session.token = await createSessionToken({ uid: u.id, sv: 0 });
  return u;
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined;
  failAfterPostEntry.on = false;
  vi.clearAllMocks();
  priceIs(80000); // 基准价：80000
  // K 线桩：一根 1 小时的六元组 [openTime, o, h, l, c, v]
  mockCandles.mockResolvedValue([[1_700_000_000_000, 80000, 80100, 79900, 80050, 12]]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── 档位（页面与接口必须同档）────────────────────────────────────────────────

describe('档位：五处各判一次', () => {
  it('未登录 → 401（四个接口都一样）', async () => {
    for (const [name, res] of [
      ['buy', await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }))],
      ['sell', await sell(makeReq('/api/fish/trade/sell', { position_id: 'x' }))],
      ['quote', await quote()],
      ['candles', await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h'))],
    ] as const) {
      expect(res.status, `${name} 应 401`).toBe(401);
    }
  });

  it('★ 普通用户（role=user）→ 403，四个接口都一样', async () => {
    const u = await makeFishUser(100, { role: 'user' });
    session.token = await createSessionToken({ uid: u.id, sv: 0 });

    for (const [name, res] of [
      ['buy', await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }))],
      ['sell', await sell(makeReq('/api/fish/trade/sell', { position_id: 'x' }))],
      ['quote', await quote()],
      ['candles', await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h'))],
    ] as const) {
      expect(res.status, `${name} 应 403 —— 漏判就是绕开档位的门`).toBe(403);
    }
    // 而且真的没扣钱
    expect(await balanceOf(u.id)).toBe(100);

    await expectLedgerConsistent('普通用户被 403 拒后');
  });

  it('★ 禁言用户：买不了新仓，但**卖得掉**手上的仓位（禁言不是锁仓）', async () => {
    const u = await makeCoreUser(100);
    // 先正常开一仓 —— 模拟「持仓期间被封」。禁言会递增 sessionVersion 废掉旧会话，
    // 而登录路径不判禁言（他登得回来），所以判定只能落在路由上。
    const opened = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 40 }));
    const { position } = await opened.json();
    await prisma.user.update({ where: { id: u.id }, data: { isBanned: true, banUntil: null } });

    // 行情：只读，放行 —— 挡了它，卖出弹窗的「预计到手」就是拿一个冻住的价算的
    vi.mocked(getCachedQuotes).mockResolvedValue({
      ok: true,
      quotes: [
        { symbol: 'BTCUSDT', price: 80000, changePercent: 0, quotedAt: nowForDb(), ageMs: 0, stale: false, source: 'poll' },
      ],
    });
    expect((await quote()).status, '只读展示不该被禁言挡住').toBe(200);
    // K 线同理：他正需要看着图决定要不要止损
    const chart = await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h'));
    expect(chart.status, '看盘不该被禁言挡住').toBe(200);

    // 开新仓：403，不打行情源、不动钱
    const callsBefore = mockQuote.mock.calls.length;
    const blocked = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }));
    expect(blocked.status, '禁言不能开新仓').toBe(403);
    expect(mockQuote.mock.calls.length, '被拒的开仓不该去打行情源').toBe(callsBefore);
    expect(await balanceOf(u.id), '被拒的开仓一分没动').toBe(60);

    // 平仓：必须放行 —— 否则已开的仓位就烂在里面了，他只能看着浮亏扩大
    priceIs(88000);
    const sold = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(sold.status, '禁言用户必须能出仓').toBe(200);
    const data = await sold.json();
    // 40 条 = 400000 单位 → floor(400000 × 88000/80000 × 0.9998) = 439912 单位 = 43.9912 条
    expect(data.payout).toBe(43.9912);
    expect(data.profit).toBe(3.9912);
    expect(await balanceOf(u.id)).toBe(103.9912);

    await expectLedgerConsistent('禁言用户平仓后');
  });

  it('core / admin / owner 都放行', async () => {
    for (const role of ['core', 'admin', 'owner'] as const) {
      await resetDb();
      __resetRateLimitStore();
      const u = await makeCoreUser(100, role);
      const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }));
      expect(res.status, `role=${role} 应放行`).toBe(200);

      await expectLedgerConsistent(`role=${role} 开仓成功后`);
    }
  });
});

// ── 入参 ────────────────────────────────────────────────────────────────────

describe('请求体与参数', () => {
  it('body 不是对象 / 不是 JSON → 400', async () => {
    await makeCoreUser(100);

    const arr = await buy(
      new Request('http://localhost/api/fish/trade/buy', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]',
      })
    );
    expect(arr.status).toBe(400);

    const bad = await buy(
      new Request('http://localhost/api/fish/trade/buy', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
      })
    );
    expect(bad.status).toBe(400);
  });

  it('缺 symbol / 金额非法 → 400，且文案来自 service（不做一半校验）', async () => {
    await makeCoreUser(100);

    const noSym = await buy(makeReq('/api/fish/trade/buy', { amount: 10 }));
    expect(noSym.status).toBe(400);
    expect((await noSym.json()).message).toContain('标的');

    const badAmt = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 'abc' }));
    expect(badAmt.status).toBe(400);
    expect((await badAmt.json()).message).toContain('大于 0');
  });

  it('平仓缺 position_id → 400', async () => {
    await makeCoreUser(100);
    const res = await sell(makeReq('/api/fish/trade/sell', {}));
    expect(res.status).toBe(400);
  });

  it('平别人的仓位 → 404', async () => {
    const a = await makeCoreUser(100);
    const open = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }));
    const { position } = await open.json();

    const b = await makeUser({ driedFish: 0, role: 'core' });
    session.token = await createSessionToken({ uid: b.id, sv: 0 });
    const res = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(res.status).toBe(404);
    expect(await balanceOf(a.id)).toBe(90); // 没被动过

    await expectLedgerConsistent('平别人的仓位被 404 拒后');
  });
});

// ── 成功路径 ────────────────────────────────────────────────────────────────

describe('成功路径', () => {
  it('买入 → 持仓建好、余额扣掉、响应形状齐全', async () => {
    const u = await makeCoreUser(100);
    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 30 }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.code).toBe(200); // HTTP status 必须 === body.code（前端只认它）
    expect(data.position.stake).toBe(30);
    expect(data.position.entry_price).toBe(80000);
    expect(data.balance).toBe(70);
    expect(data.replayed).toBe(false);

    expect(await prisma.marketPosition.count({ where: { userId: u.id } })).toBe(1);

    await expectLedgerConsistent('开仓 30 条成功后');
  });

  it('前端**不传价** —— 成交价完全由服务端现取决定', async () => {
    await makeCoreUser(100);
    // 故意在 body 里塞一个假价，服务端必须无视它
    const res = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 30, price: 1, entry_price: 1 })
    );
    const data = await res.json();
    expect(data.position.entry_price, '客户端给的价不得影响成交价').toBe(80000);
  });

  it('卖出 → 结算、余额到账', async () => {
    await makeCoreUser(100);
    const open = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100 }));
    const { position } = await open.json();

    priceIs(88000);
    const res = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.payout).toBe(109.978);
    expect(data.profit).toBeCloseTo(9.978, 10);
    expect(data.balance).toBe(109.978);

    await expectLedgerConsistent('平仓结算后');
  });

  it('重复卖出 → 200 但标记 replayed，钱不多发', async () => {
    const u = await makeCoreUser(100);
    const open = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100 }));
    const { position } = await open.json();
    priceIs(88000);

    await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    const again = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(again.status).toBe(200);
    expect((await again.json()).replayed).toBe(true);
    expect(await balanceOf(u.id), '第二次结算没有再加一次钱').toBe(109.978);

    await expectLedgerConsistent('重复平仓后（钱不多发）');
  });
});

// ── quote ───────────────────────────────────────────────────────────────────

describe('GET /quote', () => {
  it('透传展示行情，并带上手续费与最小投入（页面文案据此渲染，别写死）', async () => {
    await makeCoreUser(100);
    vi.mocked(getCachedQuotes).mockResolvedValue({
      ok: true,
      quotes: [
        { symbol: 'BTCUSDT', price: 81236.25, changePercent: 1.8, quotedAt: nowForDb(), ageMs: 500, stale: false, source: 'stream' },
      ],
    });

    const res = await quote();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.quotes[0].display).toBe('BTC');
    expect(data.quotes[0].stale).toBe(false);
    // 来源要如实透出去 —— 它是排障时唯一能看出「流这一刻活没活着」的地方（页面不渲染）
    expect(data.quotes[0].source).toBe('stream');
    expect(data.quotes[0].age_ms).toBe(500);
    expect(data.fee_rate).toBe(0.0002);
    expect(data.min_stake).toBe(1);
  });

  it('行情不可用时如实回报 ok:false + 空数组，绝不编一个价', async () => {
    await makeCoreUser(100);
    vi.mocked(getCachedQuotes).mockResolvedValue({ ok: false, quotes: [] });

    const data = await (await quote()).json();
    expect(data.ok).toBe(false);
    expect(data.quotes).toEqual([]);
  });
});

describe('GET /candles', () => {
  it('透传六元组，并回报标的短名与周期', async () => {
    await makeCoreUser(100);
    mockCandles.mockResolvedValue([
      [1_700_000_000_000, 80000, 80100, 79900, 80050, 12],
      [1_700_003_600_000, 80050, 80200, 80000, 80150, 9],
    ]);

    const res = await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT&interval=4h'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.display).toBe('BTC');
    expect(data.interval).toBe('4h');
    // 六元组原样过去（页面按索引读：0=时间 1=开 2=高 3=低 4=收 5=量）
    expect(data.candles[0]).toEqual([1_700_000_000_000, 80000, 80100, 79900, 80050, 12]);
    // 周期真的要传给行情层 —— 传丢了就是「点 4h 画出 1h」，且不报错
    expect(mockCandles.mock.calls[0][1]).toBe('4h');
  });

  it('不带 interval → 用默认档', async () => {
    await makeCoreUser(100);
    await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT'));
    expect(mockCandles.mock.calls[0][1]).toBe('1h');
  });

  it('★ 非法周期 → 400，**不静默退回默认档**', async () => {
    await makeCoreUser(100);
    for (const bad of ['1w', '1M', 'nope']) {
      const res = await candles(makeReq(`/api/fish/trade/candles?symbol=BTCUSDT&interval=${bad}`));
      expect(res.status, `${bad} 应 400`).toBe(400);
    }
    // 退回默认档会让「我点的是 4h、画出来是 1h」活下来 —— 一次都不许打行情层
    expect(mockCandles, '被拒的请求不该去打行情源').not.toHaveBeenCalled();
  });

  it('非法标的 / 缺标的 → 400', async () => {
    await makeCoreUser(100);
    expect((await candles(makeReq('/api/fish/trade/candles?interval=1h'))).status).toBe(400);
    expect(
      (await candles(makeReq('/api/fish/trade/candles?symbol=DOGEUSDT&interval=1h'))).status
    ).toBe(400);
    expect(mockCandles).not.toHaveBeenCalled();
  });

  it('一根 K 线都没有时 ok:false（页面据此显示「K 线暂不可用」+ 重试），而不是 500', async () => {
    await makeCoreUser(100);
    mockCandles.mockResolvedValue([]);

    const res = await candles(makeReq('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.candles).toEqual([]);
  });
});

// ── 失败路径：要么全成、要么全不成 ──────────────────────────────────────────

describe('写路径失败 → 零痕迹', () => {
  it('★ 行情源挂了 → 503「行情暂不可用」，且绝不退回展示缓存', async () => {
    const u = await makeCoreUser(100);
    mockQuote.mockRejectedValue(new MarketPriceError('行情源不可达'));

    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 40 }));

    expect(res.status, '取不到价就拒单 —— 不降级、不编价').toBe(503);
    expect((await res.json()).message).toContain('行情暂不可用');
    expect(getCachedQuotes, '成交价只能现取：读缓存价就是无风险套利').not.toHaveBeenCalled();

    expect(await balanceOf(u.id)).toBe(100);
    expect(await prisma.marketPosition.count({ where: { userId: u.id } })).toBe(0);

    await expectLedgerConsistent('取价失败被 503 拒后');
  });

  it('★ 买入：记账之后事务失败 → 500，钱与持仓都不留', async () => {
    const u = await makeCoreUser(100);
    failAfterPostEntry.on = true;

    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 40 }));

    expect(res.status, '本地事务失败就是真故障（没有远端了，没有 503 那一档）').toBe(500);
    expect(await balanceOf(u.id), '扣款随事务一起回滚').toBe(100);
    expect(await prisma.marketPosition.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id, type: MARKET_BUY_TYPE } })).toBe(0);

    await expectLedgerConsistent('开仓事务失败回滚后');
  });

  it('★ 卖出：结算事务失败 → 500，仓位仍是 open、钱不动', async () => {
    const u = await makeCoreUser(100);
    const open = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100 }));
    const { position } = await open.json();
    priceIs(88000);

    failAfterPostEntry.on = true;
    const res = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));

    expect(res.status).toBe(500);
    const row = await prisma.marketPosition.findUniqueOrThrow({ where: { id: position.id } });
    expect(row.status, '状态翻转也在同一个事务里 —— 一起回滚').toBe('open');
    expect(row.payoutUnits).toBeNull();
    expect(row.exitPrice).toBeNull();
    expect(await balanceOf(u.id), '钱还压在仓位里').toBe(0);

    await expectLedgerConsistent('平仓事务失败回滚后');
  });
});

// ── 杠杆（接口形状）──────────────────────────────────────────────────────────
//
// 【这个文件只钉「接口形状与档位」，算术在这里不重复】10 倍仓该到手多少由
// tests/service/market-service.test.ts 与 tests/unit/market-math.test.ts 负责。
// 这里要证明的是另一件事：**杠杆没有开出第六个入口**、也没动档位与禁言那五处判定
//（它是 buy 的一个参数），以及响应里那几个字段如实回给了调用方。

describe('杠杆：接口形状', () => {
  it('买入带 leverage → 响应回倍数与爆仓价，仓位按倍数落库', async () => {
    const u = await makeCoreUser(100);
    const res = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100, leverage: 10 })
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.position.leverage).toBe(10);
    // 80000 × (1 − 1/10) —— 开仓那一刻算出来写死的那一个数
    expect(data.position.liquidation_price).toBe(72000);
    // 投入仍然是 100（名义本金是算出来的，不进库也不进余额）
    expect(data.position.stake).toBe(100);
    expect(data.balance).toBe(0);

    const row = await prisma.marketPosition.findUniqueOrThrow({ where: { id: data.position.id } });
    expect(row.leverage).toBe(10);
    expect(row.liquidationPrice).toBe(72000);
    expect(row.stakeUnits).toBe(1_000_000);

    await expectLedgerConsistent('10 倍开仓之后');
  });

  it('**不传 leverage = 1 倍**（存量 bot 与客户端一个字都不用改）', async () => {
    await makeCoreUser(100);
    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 30 }));
    const data = await res.json();
    expect(data.position.leverage).toBe(1);
    expect(data.position.liquidation_price).toBe(0);
  });

  it('不在白名单的杠杆 → 400，文案把可选档位念出来', async () => {
    await makeCoreUser(100);
    for (const bad of [4, 100, 'xxx']) {
      const res = await buy(
        makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10, leverage: bad })
      );
      expect(res.status, `leverage=${String(bad)}`).toBe(400);
      const data = await res.json();
      expect(data.message).toContain('1 / 2 / 3 / 5 / 10');
    }
    expect(await prisma.marketPosition.count()).toBe(0);
  });

  it('★ 强平引擎没在跑 → 杠杆买入 503，而 1 倍照旧 200', async () => {
    await makeCoreUser(100);
    __setLiquidationRunning(false);

    const lev = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100, leverage: 10 })
    );
    expect(lev.status).toBe(503);
    expect((await lev.json()).message).toContain('杠杆');

    // 1 倍不受影响 —— 它永远碰不到爆仓价，不需要引擎
    const plain = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100 }));
    expect(plain.status).toBe(200);

    __setLiquidationRunning(true);
  });

  it('★ 爆仓之后卖出 → 200 但是 **liquidated: true**，文案不是「已卖出」', async () => {
    await makeCoreUser(100);
    const open = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100, leverage: 10 })
    );
    const { position } = await open.json();

    priceIs(71999); // 跌穿 72000
    expect(await sweepLiquidations()).toBe(1);

    const res = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.liquidated).toBe(true);
    expect(data.message).toContain('爆仓');
    expect(data.message).not.toContain('已卖出');
    expect(data.payout).toBe(0);
    expect(data.exit_price).toBe(72000); // 结算价是那条线，不是触发价 71999
    expect(data.replayed).toBe(true);

    await expectLedgerConsistent('爆仓后卖出');
  });

  it('禁言用户：**买不了杠杆仓**（同 1 倍那扇门），但手上的杠杆仓照旧卖得掉', async () => {
    // 禁言只挡 buy（see sell/route.ts 头部）—— 加杠杆没有新开一扇门，
    // 但这条值得钉：它是「别把禁言变成锁仓」在杠杆上的落点。
    const u = await makeCoreUser(100);
    const open = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100, leverage: 10 })
    );
    const { position } = await open.json();

    await prisma.user.update({ where: { id: u.id }, data: { isBanned: true, banUntil: null } });

    const blocked = await buy(
      makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 1, leverage: 10 })
    );
    expect(blocked.status).toBe(403);

    priceIs(80800);
    const sold = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(sold.status, '禁言不该把已开的杠杆仓锁死').toBe(200);
  });
});
