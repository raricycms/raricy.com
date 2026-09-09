// fish-sync.ts replayPendingSyncs —— 重放宽限期必须与账本 createdAt 同钟。
//
// 【为什么单独一个文件】需要 vi.mock 掉 account-client（executeSync 会真发 HTTP），
// 而其它 fish 相关用例跑的是本地语义分支。混在一起会互相干扰。
//
// 【背景（真修过的 bug）】账本 createdAt 走 nowForDb()（UTC+8 墙上时间贴 Z，
// 见 src/lib/db-time.ts）。若重放查询用真实 Date.now() 算 cutoff，宽限期会被
// 悄悄拉成「8 小时 + olderThanMs」—— 进程在「已提交/未同步」之间崩溃后，
// `npm run cli -- fish sync-retry` 8 小时内扫不到该重放的行，看着像空转。
// 这里两条用例从两侧钉住它：够老的行必须被扫到，太新的行必须不被扫到。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockTransfer } = vi.hoisted(() => ({
  mockTransfer: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/account-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-client')>();
  return {
    ...actual,
    accountClient: { ...actual.accountClient, transfer: mockTransfer },
  };
});

import { replayPendingSyncs } from '@/lib/fish-sync';
import { nowForDb } from '@/lib/db-time';
import { resetDb, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
  mockTransfer.mockReset();
  mockTransfer.mockResolvedValue(undefined);
});

/**
 * 造一条账本行，createdAt 按「UTC+8 墙上时间」回拨 minutesAgo 分钟
 * （与 recordPendingSync 的写入口径一致）。
 */
async function makeLedgerRow(key: string, minutesAgo: number, status = 'pending') {
  const at = new Date(nowForDb().getTime() - minutesAgo * 60 * 1000);
  await prisma.accountSyncLedger.create({
    data: {
      idempotencyKey: key,
      operation: 'checkin',
      payload: JSON.stringify({
        toUserId: 'u-1',
        amount: 1,
        description: '签到',
        date: '2026-07-16',
        fortuneValue: 3,
      }),
      status,
      createdAt: at,
      updatedAt: at,
    },
  });
}

describe('replayPendingSyncs —— 宽限期与账本同钟（UTC+8 墙上时间）', () => {
  it('【回归】2 分钟前的 pending 行必须被扫到并结算（旧实现要等 8 小时）', async () => {
    await makeLedgerRow('k-old', 2);

    const res = await replayPendingSyncs();

    expect(res.total, '2 分钟前已过 60s 宽限期，必须进入重放集').toBe(1);
    expect(res.synced).toBe(1);
    expect(mockTransfer).toHaveBeenCalledTimes(1);

    const row = await prisma.accountSyncLedger.findUnique({ where: { idempotencyKey: 'k-old' } });
    expect(row?.status).toBe('synced');
    expect(row?.lastError).toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it('10 秒前的行仍在宽限期内，不该被扫到（避免与进行中的写路径赛跑）', async () => {
    await makeLedgerRow('k-fresh', 1 / 6); // 10 秒

    const res = await replayPendingSyncs();

    expect(res.total).toBe(0);
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('重放范围是 pending + failed；compensated / synced 不在其列', async () => {
    await makeLedgerRow('k-failed', 5, 'failed');
    await makeLedgerRow('k-compensated', 5, 'compensated');
    await makeLedgerRow('k-synced', 5, 'synced');

    const res = await replayPendingSyncs();

    expect(res.total).toBe(1);
    expect(mockTransfer).toHaveBeenCalledTimes(1);
  });

  it('olderThanMs 覆盖默认 60s 宽限（30 秒前的行传 0 时立刻可重放）', async () => {
    await makeLedgerRow('k-half-minute', 0.5);

    expect((await replayPendingSyncs()).total, '默认宽限 60s：30 秒前的行不扫').toBe(0);
    expect((await replayPendingSyncs({ olderThanMs: 0 })).total, '显式 0 宽限：必须扫到').toBe(1);
  });

  it('远端失败时行保持可重放状态并记下 lastError', async () => {
    await makeLedgerRow('k-fail-remote', 5);
    mockTransfer.mockRejectedValue(new Error('远端 502'));

    const res = await replayPendingSyncs();

    expect(res.stillFailing).toBe(1);
    const row = await prisma.accountSyncLedger.findUnique({
      where: { idempotencyKey: 'k-fail-remote' },
    });
    expect(row?.status, '不落 failed 也能下次继续重放').toBe('pending');
    expect(row?.lastError).toContain('502');
  });
});
