// 练手盘三个接口的**鉴权分叉与档位**。
//
// 【为什么单独一个文件】这里打的是真实 route handler，重点在「页面与接口必须同档」：
// core+ 这一档在页面（/fish/trade）、buy、sell、quote 四处各判一次，任何一处漏判
// 都是一扇绕开档位的门 —— 而功能照常工作、测试照常绿。service 层的钱怎么走由
// tests/service/market-*.test.ts 负责，这个文件不重复测那些。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。远端账户服务与行情源都打桩。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

const { mockEnabled, mockTransfer } = vi.hoisted(() => ({
  mockEnabled: vi.fn<() => boolean>(),
  mockTransfer: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/account-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-client')>();
  return {
    ...actual,
    accountServiceEnabled: mockEnabled,
    accountClient: { ...actual.accountClient, transfer: mockTransfer },
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
import { createSessionToken } from '@/lib/session';
import { nowForDb } from '@/lib/db-time';
import { unitsToFish } from '@/lib/fish-units';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { AccountServiceError } from '@/lib/account-client';
import { getCachedQuotes } from '@/lib/market-price';
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

/** 造一个 core+ 且已登录的用户。 */
async function makeCoreUser(driedFish = 100, role: 'core' | 'admin' | 'owner' = 'core') {
  const u = await makeUser({ driedFish, role });
  session.token = await createSessionToken({ uid: u.id, sv: 0 });
  return u;
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined;
  vi.clearAllMocks();
  mockEnabled.mockReturnValue(false); // dev fallback
  mockTransfer.mockResolvedValue({ transaction_id: 'r1' });
  mockQuote.mockResolvedValue({
    symbol: 'BTCUSDT', price: 80000, changePercent: null, quotedAt: nowForDb(),
  });
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
    const u = await makeUser({ driedFish: 100, role: 'user' });
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

    mockQuote.mockResolvedValue({
      symbol: 'BTCUSDT', price: 88000, changePercent: null, quotedAt: nowForDb(),
    });
    const res = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.payout).toBe(109.8);
    expect(data.profit).toBeCloseTo(9.8, 10);
    expect(data.balance).toBe(109.8);
  });

  it('重复卖出 → 200 但标记 replayed，钱不多发', async () => {
    await makeCoreUser(100);
    const open = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 100 }));
    const { position } = await open.json();
    mockQuote.mockResolvedValue({
      symbol: 'BTCUSDT', price: 88000, changePercent: null, quotedAt: nowForDb(),
    });

    await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    const again = await sell(makeReq('/api/fish/trade/sell', { position_id: position.id }));
    expect(again.status).toBe(200);
    expect((await again.json()).replayed).toBe(true);
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

// ── 远端失败 ────────────────────────────────────────────────────────────────

describe('远端同步失败 → 503（本地已补偿回滚）', () => {
  it('买入：503，且零痕迹', async () => {
    mockEnabled.mockReturnValue(true);
    mockTransfer.mockRejectedValue(new AccountServiceError('远端炸了', 503));
    const u = await makeCoreUser(100);

    const res = await buy(makeReq('/api/fish/trade/buy', { symbol: 'BTCUSDT', amount: 40 }));
    expect(res.status).toBe(503);
    expect((await res.json()).message).toContain('鱼干服务');

    expect(await balanceOf(u.id)).toBe(100);
    expect(await prisma.marketPosition.count({ where: { userId: u.id } })).toBe(0);
  });
});
