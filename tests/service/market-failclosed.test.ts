// market-service —— 练手盘的 fail-closed 远端同步。
//
// 【为什么单独一个文件】需要 vi.mock 掉 account-client 与 market-price 才测得了
// 「远端失败」，而 market-service.test.ts 跑的是真实模块 + dev fallback 的本地语义。
// 混在一起会互相干扰（mock 是全模块级的）。
//
// 【核心不变式】**远端失败 → 本地必须零痕迹**（对用户等价于回滚 + 503）。
// 最危险的失败模式是「本地已经扣了/加了鱼干但远端没记账」—— 本地余额与远端复式
// 账本从此分叉，且完全静默。三个必须钉住的点：
//   · HTTP 调用在 SQLite 事务**外**（在事务里会占满写锁 → 并发写 database is locked）
//   · 开仓补偿**无条件**退回（数学上不可能变负），平仓补偿**条件**扣回（可能已花掉）
//   · 补偿也失败时账本留 failed + ACCOUNT_RECONCILE_REQUIRED，交给 sync-retry
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。只 mock 远端账户服务与行情源两个出口。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  return { ...actual, fetchQuote: mockQuote };
});

import { openPosition, closePosition } from '@/lib/market-service';
import { AccountServiceError } from '@/lib/account-client';
import { nowForDb } from '@/lib/db-time';
import { unitsToFish } from '@/lib/fish-units';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 远端「已配置且一切正常」。 */
function enableRemote() {
  mockEnabled.mockReturnValue(true);
  mockTransfer.mockResolvedValue({ transaction_id: 'remote-1' });
}

/** 行情源正常返回。 */
function priceIs(p: number) {
  mockQuote.mockResolvedValue({
    symbol: 'BTCUSDT',
    price: p,
    changePercent: null,
    quotedAt: nowForDb(),
  });
}

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

const ledgerRows = () => prisma.accountSyncLedger.findMany({ orderBy: { id: 'asc' } });
/** 只看某个 operation 的账本行 —— 开仓与平仓各留一条，不筛会把两条混在一起。 */
const ledgerOf = (operation: string) =>
  prisma.accountSyncLedger.findMany({ where: { operation }, orderBy: { id: 'asc' } });

describe('开仓 —— 远端失败', () => {
  it('★ 零痕迹：余额退回、无流水、无持仓、无账本行', async () => {
    enableRemote();
    priceIs(80000);
    mockTransfer.mockRejectedValue(new AccountServiceError('远端炸了', 503));
    const user = await makeUser({ driedFish: 100 });

    await expect(
      openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 })
    ).rejects.toBeInstanceOf(AccountServiceError);

    expect(await balanceOf(user.id), '钱必须原样退回').toBe(100);
    expect(await prisma.fishTransaction.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.marketPosition.count({ where: { userId: user.id } })).toBe(0);
    expect(await ledgerRows(), '补偿成功 = 账本行删掉，用户可以用同键重试').toHaveLength(0);
  });

  it('远端成功时：流水与持仓都在，账本行 synced，entry_type = market_buy', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });

    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 });
    expect(r.ok).toBe(true);

    expect(mockTransfer).toHaveBeenCalledTimes(1);
    const sent = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.entryType).toBe('market_buy');
    // 买入方向：用户 → 系统水池
    expect(sent.fromUserId).toBe(user.id);
    expect(sent.toUserId).toBe('raricy-blog-system');
    expect(sent.amount).toBe(40);
    expect(String(sent.idempotencyKey).length, '远端幂等键上限 64 字符').toBeLessThanOrEqual(64);

    expect(await prisma.marketPosition.count({ where: { userId: user.id } })).toBe(1);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('synced');
    expect(ledger[0].operation).toBe('market_buy');
  });

  it('账本 payload 里**没有密钥**（重放时按 userId 重新解密/走系统 Key）', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });
    await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 });

    const payload = (await ledgerRows())[0].payload;
    expect(payload).not.toMatch(/api[_-]?key/i);
    expect(payload).not.toMatch(/bearer/i);
  });
});

describe('平仓 —— 远端失败', () => {
  it('★ 仓位翻回 open、钱退回、无卖出流水、无账本行', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });
    const o = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(await balanceOf(user.id)).toBe(0); // 全投进去了

    priceIs(88000);
    mockTransfer.mockRejectedValue(new AccountServiceError('远端炸了', 503));
    await expect(
      closePosition({ userId: user.id, positionId: o.position.id })
    ).rejects.toBeInstanceOf(AccountServiceError);

    expect(await balanceOf(user.id), '平仓款必须收回').toBe(0);
    expect(
      await prisma.fishTransaction.count({ where: { userId: user.id, type: 'market_sell' } })
    ).toBe(0);

    const pos = await prisma.marketPosition.findUnique({ where: { id: o.position.id } });
    expect(pos?.status, '仓位必须原样回到 open').toBe('open');
    expect(pos?.exitPrice, '半截行：状态 open 却带着平仓价').toBeNull();
    expect(pos?.exitQuoteAt).toBeNull();
    expect(pos?.payoutUnits).toBeNull();
    expect(pos?.closeTxId).toBeNull();
    expect(pos?.closedAt).toBeNull();

    // 开仓那条 synced 的还在；平仓这条补偿成功 = 删掉，用户可以用同一个仓位重试
    expect(await ledgerOf('market_sell')).toHaveLength(0);
  });

  it('远端成功时：entry_type = market_sell，方向是系统水池 → 用户', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });
    const o = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    mockTransfer.mockClear();

    priceIs(88000);
    const r = await closePosition({ userId: user.id, positionId: o.position.id });
    expect(r.ok).toBe(true);

    const sent = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.entryType).toBe('market_sell');
    expect(sent.fromUserId).toBe('raricy-blog-system');
    expect(sent.toUserId).toBe(user.id);
    expect(sent.amount).toBe(109.8);

    // 开仓那条也在库里（synced），所以按 operation 筛
    const ledger = await ledgerOf('market_sell');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('synced');
  });

  it('实发为 0 时不调远端、不登记账本（没有钱动过）', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 10 });
    const o = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 1 });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    mockTransfer.mockClear();

    priceIs(8000); // −90% → 实发 0
    const r = await closePosition({ userId: user.id, positionId: o.position.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payout).toBe(0);

    expect(mockTransfer, '实发 0 = 没有转账，不该打远端').not.toHaveBeenCalled();
    expect(await ledgerRows(), '开仓那条已经 synced 留在库里；平仓不该新增').toHaveLength(1);
  });
});

describe('补偿也失败（最坏情况）', () => {
  it('★ 平仓款已被花掉 → 补偿扣不回来 → 账本 failed + 绝不部分撤销', async () => {
    enableRemote();
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });
    const o = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 100 });
    expect(o.ok).toBe(true);
    if (!o.ok) return;

    // 远端调用时把余额抽干，再让远端失败 —— 于是 Phase 3 的条件扣回必然失败。
    // （真实场景：用户在平仓与补偿之间的那一瞬又把鱼干转走了。）
    priceIs(88000);
    mockTransfer.mockImplementation(async () => {
      await prisma.user.update({ where: { id: user.id }, data: { driedFish: 0 } });
      throw new AccountServiceError('远端炸了', 503);
    });

    await expect(
      closePosition({ userId: user.id, positionId: o.position.id })
    ).rejects.toBeInstanceOf(AccountServiceError);

    // 补偿失败 → 整个补偿事务回滚 → 仓位保持 closed（那笔平仓在本地已成立）
    const pos = await prisma.marketPosition.findUnique({ where: { id: o.position.id } });
    expect(pos?.status, '补偿回滚 ⇒ 仓位停在 closed，交给 sync-retry 正向重放').toBe('closed');

    const ledger = await ledgerOf('market_sell');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].lastError).toBeTruthy();

    // 结构化日志：告警系统按这个关键字捞
    const errLog = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join('\n');
    expect(errLog).toContain('ACCOUNT_RECONCILE_REQUIRED');
  });
});

describe('dev fallback（远端未配置）', () => {
  it('不登记账本行 —— 登记了就是一堆永远同步不出去的 pending', async () => {
    mockEnabled.mockReturnValue(false);
    priceIs(80000);
    const user = await makeUser({ driedFish: 100 });

    const r = await openPosition({ userId: user.id, symbolRaw: 'BTCUSDT', amount: 40 });
    expect(r.ok).toBe(true);
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(0);
    expect(await prisma.marketPosition.count({ where: { userId: user.id } })).toBe(1);
  });
});
