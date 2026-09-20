// 练手盘三个接口的**鉴权分叉与档位**。
//
// 【为什么单独一个文件】这里打的是真实 route handler，重点在「页面与接口必须同档」：
// core+ 这一档在页面（/fish/trade）、buy、sell、quote 四处各判一次，任何一处漏判
// 都是一扇绕开档位的门 —— 而功能照常工作、测试照常绿。service 层的钱怎么走由
// tests/service/market-*.test.ts 负责，这个文件不重复测那些。
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

const { mockQuote } = vi.hoisted(() => ({
  mockQuote: vi.fn<(symbol: string) => Promise<unknown>>(),
}));

vi.mock('@/lib/market-price', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/market-price')>();
  return { ...actual, fetchQuote: mockQuote, getCachedQuotes: vi.fn() };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { createSessionToken } from '@/lib/session';
import { nowForDb } from '@/lib/db-time';
import { unitsToFish } from '@/lib/fish-units';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { MarketPriceError, getCachedQuotes } from '@/lib/market-price';
import { MARKET_BUY_TYPE } from '@/lib/market-service';
import { POST as buy } from '@/app/api/fish/trade/buy/route';
import { POST as sell } from '@/app/api/fish/trade/sell/route';
import { GET as quote } from '@/app/api/fish/trade/quote/route';

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── 档位（页面与接口必须同档）────────────────────────────────────────────────

describe('档位：三处各判一次', () => {
  it('未登录 → 401（三个接口都一样）', async () => {
    for (const [name, res] of [
      ['buy', await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }))],
      ['sell', await sell(makeReq('/api/fish/trade/sell', { position_id: 'x' }))],
      ['quote', await quote()],
    ] as const) {
      expect(res.status, `${name} 应 401`).toBe(401);
    }
  });

  it('★ 普通用户（role=user）→ 403，三个接口都一样', async () => {
    const u = await makeFishUser(100, { role: 'user' });
    session.token = await createSessionToken({ uid: u.id, sv: 0 });

    for (const [name, res] of [
      ['buy', await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }))],
      ['sell', await sell(makeReq('/api/fish/trade/sell', { position_id: 'x' }))],
      ['quote', await quote()],
    ] as const) {
      expect(res.status, `${name} 应 403 —— 漏判就是绕开档位的门`).toBe(403);
    }
    // 而且真的没扣钱
    expect(await balanceOf(u.id)).toBe(100);

    await expectLedgerConsistent('普通用户被 403 拒后');
  });

  it('禁言用户 → 403', async () => {
    const u = await makeCoreUser(100);
    await prisma.user.update({ where: { id: u.id }, data: { isBanned: true, banUntil: null } });
    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 10 }));
    expect(res.status).toBe(403);
    expect(mockQuote, '被禁言的请求不该去打行情源').not.toHaveBeenCalled();
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
    expect(data.payout).toBe(109.89);
    expect(data.profit).toBeCloseTo(9.89, 10);
    expect(data.balance).toBe(109.89);

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
    expect(await balanceOf(u.id), '第二次结算没有再加一次钱').toBe(109.89);

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
        { symbol: 'BTCUSDT', price: 81236.25, changePercent: 1.8, quotedAt: nowForDb(), ageMs: 500, stale: false },
      ],
    });

    const res = await quote();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.quotes[0].display).toBe('BTC');
    expect(data.quotes[0].stale).toBe(false);
    expect(data.fee_rate).toBe(0.001);
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
