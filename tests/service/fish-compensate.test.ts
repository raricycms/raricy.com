// fish-compensate.ts —— 全站群发补偿（CLI `fish compensate` 的底层）。
//
// 【为什么必须测】它是唯一一条**一次改全站每个人余额**的路径，而且没有网页入口、
// 只在服务器上跑。四条不变式：
//   1. 逐人原子：某一位失败，只回滚这一位，不能连累已发放的人
//   2. 续跑不重复发放：同一个 batchId 重跑，已 synced 的人必须原样跳过
//      —— 这条最关键：漏了它就是「本地加了余额、远端被幂等去重没加」，两边记账分叉
//   3. 幂等键与 Flask 逐字节同构（迁移前跑了一半的批次，换个实现也能续上）
//   4. 账本里有 pending/failed 的人不许重发（该走 fish sync-retry）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

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

import {
  compensateAllUsers,
  compensateIdempotencyKey,
  makeBatchId,
  MAX_CONSECUTIVE_FAILURES,
} from '@/lib/fish-compensate';
import { FishBusinessError } from '@/lib/fish-admin';
import { AccountServiceError, SYSTEM_USER_ID } from '@/lib/account-client';
import { unitsToFish } from '@/lib/fish-units';
import { resetDb, makeUser, prisma } from '../helpers/db';

// 限频只是为了让真实远端的 QPS 好看；用例里 1ms 一位，别把测试拖成秒级。
const FAST = 1000;

beforeEach(async () => {
  await resetDb();
  mockEnabled.mockReset();
  mockTransfer.mockReset();
  mockEnabled.mockReturnValue(true);
  mockTransfer.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function balanceOf(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}

async function ledgerRow(idempotencyKey: string) {
  return prisma.accountSyncLedger.findUnique({ where: { idempotencyKey } });
}

/** 造 n 个用户，返回他们（顺序与补偿的处理顺序无关，断言一律用集合语义）。 */
async function makeUsers(n: number) {
  const users = [];
  for (let i = 0; i < n; i++) users.push(await makeUser({ driedFish: 0 }));
  return users;
}

describe('compensateIdempotencyKey：与 Flask 同构', () => {
  it('键 = comp-{sha256(compensate-batch-user-amount)[:16]}', () => {
    // 手算一份「Flask 会算出的」键，验证逐字节一致 —— 这是跨实现续跑的前提。
    const expected =
      'comp-' +
      createHash('sha256')
        .update('compensate-abc123-user-1-10')
        .digest('hex')
        .slice(0, 16);
    expect(compensateIdempotencyKey('abc123', 'user-1', 10)).toBe(expected);
  });

  it('确定性：同批次同用户同金额 → 同键；换任一项 → 换键', () => {
    const a = compensateIdempotencyKey('b1', 'u1', 5);
    expect(compensateIdempotencyKey('b1', 'u1', 5)).toBe(a);
    expect(compensateIdempotencyKey('b2', 'u1', 5)).not.toBe(a);
    expect(compensateIdempotencyKey('b1', 'u2', 5)).not.toBe(a);
    expect(compensateIdempotencyKey('b1', 'u1', 6)).not.toBe(a);
  });

  it('makeBatchId 是 12 位 hex（对齐 Flask uuid4().hex[:12]）', () => {
    expect(makeBatchId()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('compensateAllUsers：正常发放', () => {
  it('每位用户都 +amount、写 system_compensate 流水、账本留 synced 行', async () => {
    const users = await makeUsers(3);

    const r = await compensateAllUsers({
      amount: 7,
      description: '故障补偿',
      batchId: 'batch-1',
      rate: FAST,
    });

    expect(r).toMatchObject({ total: 3, succeeded: 3, skipped: 0, aborted: false });
    for (const u of users) {
      expect(await balanceOf(u.id), `${u.username} 余额`).toBe(7);
      const t = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
      expect(t.type, '流水类型要和「管理员手动赠送」区分开').toBe('system_compensate');
      expect(t.description).toBe('故障补偿');
      expect(unitsToFish(t.amount)).toBe(7);

      const row = await ledgerRow(compensateIdempotencyKey('batch-1', u.id, 7));
      expect(row?.status, '账本行必须留 synced，续跑靠它认人').toBe('synced');
      expect(row?.operation).toBe('compensate');
    }
  });

  it('远端 transfer：系统账户 → 用户，entryType=system_compensate', async () => {
    const [u] = await makeUsers(1);
    await compensateAllUsers({ amount: 3, batchId: 'batch-1', rate: FAST });

    expect(mockTransfer).toHaveBeenCalledTimes(1);
    const arg = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fromUserId, '补偿必须从系统账户出').toBe(SYSTEM_USER_ID);
    expect(arg.toUserId).toBe(u.id);
    expect(arg.amount).toBe(3);
    expect(arg.entryType).toBe('system_compensate');
    expect(arg.idempotencyKey).toBe(compensateIdempotencyKey('batch-1', u.id, 3));
  });

  it('被禁言的用户照样发（补偿是系统行为，与个人状态无关）', async () => {
    const banned = await makeUser({ driedFish: 0, isBanned: true, banReason: '测试' });
    const r = await compensateAllUsers({ amount: 4, batchId: 'batch-1', rate: FAST });

    expect(r.succeeded).toBe(1);
    expect(await balanceOf(banned.id)).toBe(4);
  });

  it('库里没有用户 → total=0，不打远端', async () => {
    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });
    expect(r.total).toBe(0);
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('dry-run：给出目标数，但一分钱不动', async () => {
    const users = await makeUsers(2);
    const r = await compensateAllUsers({ amount: 9, batchId: 'batch-1', rate: FAST, dryRun: true });

    expect(r).toMatchObject({ total: 2, succeeded: 0, dryRun: true });
    expect(mockTransfer).not.toHaveBeenCalled();
    for (const u of users) expect(await balanceOf(u.id)).toBe(0);
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });
});

describe('★ 续跑：同一个 batchId 重跑不重复发放', () => {
  it('已 synced 的用户被跳过，余额不再增加、远端不再调用', async () => {
    const users = await makeUsers(3);

    const first = await compensateAllUsers({ amount: 6, batchId: 'batch-1', rate: FAST });
    expect(first.succeeded).toBe(3);

    // 第二次：模拟「跑到一半崩了，运维拿同一个批次 ID 续跑」
    mockTransfer.mockClear();
    const second = await compensateAllUsers({ amount: 6, batchId: 'batch-1', rate: FAST });

    expect(second, '重跑时这 3 位都该被判为已完成').toMatchObject({
      total: 3,
      succeeded: 0,
      skipped: 3,
      failed: [],
    });
    expect(mockTransfer, '已发放的人不该再打一次远端').not.toHaveBeenCalled();
    for (const u of users) {
      expect(await balanceOf(u.id), `${u.username} 余额被重复发放了 —— 本地翻倍而远端被幂等去重`).toBe(6);
      expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(1);
    }
  });

  it('换了 batchId 就是新的一批，正常再发一次', async () => {
    const [u] = await makeUsers(1);
    await compensateAllUsers({ amount: 6, batchId: 'batch-1', rate: FAST });
    const second = await compensateAllUsers({ amount: 6, batchId: 'batch-2', rate: FAST });

    expect(second).toMatchObject({ succeeded: 1, skipped: 0 });
    expect(await balanceOf(u.id), '新批次是独立的一笔，本就该再发').toBe(12);
  });

  it('断点续跑：新用户加进来后，老用户跳过、新用户拿到', async () => {
    const [a] = await makeUsers(1);
    await compensateAllUsers({ amount: 6, batchId: 'batch-1', rate: FAST });

    const b = await makeUser({ driedFish: 0 });
    const r = await compensateAllUsers({ amount: 6, batchId: 'batch-1', rate: FAST });

    expect(r).toMatchObject({ total: 2, succeeded: 1, skipped: 1 });
    expect(await balanceOf(a.id)).toBe(6);
    expect(await balanceOf(b.id), '续跑新覆盖到的人应当拿到').toBe(6);
  });
});

describe('★ 逐人原子：一位失败不连累其他人', () => {
  it('单人失败 → 该用户零痕迹，其余照常发放', async () => {
    const users = await makeUsers(3);
    const victim = users[1];

    mockTransfer.mockImplementation(async (input: unknown) => {
      const { toUserId } = input as { toUserId: string };
      if (toUserId === victim.id) throw new AccountServiceError('远端炸了', 503);
      return { ok: true };
    });

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

    expect(r.succeeded).toBe(2);
    expect(r.failed.map((f) => f.username)).toEqual([victim.username]);

    expect(await balanceOf(victim.id), '失败者的本地写入必须被补偿撤销').toBe(0);
    expect(await prisma.fishTransaction.count({ where: { userId: victim.id } })).toBe(0);
    expect(
      await ledgerRow(compensateIdempotencyKey('batch-1', victim.id, 5)),
      '补偿成功 = 账本行被删掉，续跑时它会被当成「还没发」重新尝试'
    ).toBeNull();

    for (const ok of [users[0], users[2]]) {
      expect(await balanceOf(ok.id), '别人不该被连累').toBe(5);
    }
  });

  it('失败的那一位在续跑时会被补上（键没被占住）', async () => {
    const users = await makeUsers(2);
    const victim = users[0];
    let poisoned = true;

    mockTransfer.mockImplementation(async (input: unknown) => {
      const { toUserId } = input as { toUserId: string };
      if (poisoned && toUserId === victim.id) throw new AccountServiceError('远端炸了', 503);
      return { ok: true };
    });

    await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });
    expect(await balanceOf(victim.id)).toBe(0);

    poisoned = false; // 远端恢复
    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

    expect(r).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(await balanceOf(victim.id)).toBe(5);
  });
});

describe('★ 中止条件', () => {
  it(`连续失败满 ${MAX_CONSECUTIVE_FAILURES} 位即中止，不把剩下的人挨个刷成失败`, async () => {
    const users = await makeUsers(MAX_CONSECUTIVE_FAILURES + 4);
    mockTransfer.mockRejectedValue(new AccountServiceError('远端整体挂了', 503));

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

    expect(r.aborted).toBe(true);
    expect(r.abortReason).toContain('整体不可用');
    expect(r.succeeded).toBe(0);
    expect(r.failed).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(mockTransfer, '中止后不该再打远端').toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);

    for (const u of users) expect(await balanceOf(u.id), '全部回滚，谁都不该拿到').toBe(0);
  });

  it('429 立即中止（不等到连续失败阈值）', async () => {
    await makeUsers(MAX_CONSECUTIVE_FAILURES + 4);
    mockTransfer.mockRejectedValue(new AccountServiceError('too many requests', 429));

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

    expect(r.aborted).toBe(true);
    expect(r.abortReason).toContain('429');
    expect(r.failed).toHaveLength(1);
    expect(mockTransfer).toHaveBeenCalledTimes(1);
  });

  it('失败是零星的不是连续的 → 不中止，继续发完', async () => {
    const users = await makeUsers(4);
    // 第 1、3 位失败，中间隔着成功 —— 连续计数会被成功重置
    const doomed = new Set([users[0].id, users[2].id]);
    mockTransfer.mockImplementation(async (input: unknown) => {
      const { toUserId } = input as { toUserId: string };
      if (doomed.has(toUserId)) throw new AccountServiceError('偶发', 503);
      return { ok: true };
    });

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

    expect(r.aborted).toBe(false);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toHaveLength(2);
  });
});

describe('★ 账本里 pending / failed 的用户不许重发', () => {
  for (const status of ['pending', 'failed'] as const) {
    it(`${status} → 跳过并记进 blocked，余额不动`, async () => {
      const users = await makeUsers(2);
      const stuck = users[0];
      const key = compensateIdempotencyKey('batch-1', stuck.id, 5);

      // 手造一行「本地已提交、远端未落地」的残留（真实场景：崩在这中间）
      await prisma.accountSyncLedger.create({
        data: {
          idempotencyKey: key,
          operation: 'compensate',
          payload: JSON.stringify({ userId: stuck.id, amount: 5, description: 'x' }),
          status,
          attempts: 1,
        },
      });

      const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: FAST });

      expect(r.blocked).toEqual([{ username: stuck.username, status }]);
      expect(r.succeeded, '另一位该正常发放').toBe(1);
      expect(await balanceOf(stuck.id), '重发会在本地叠加而远端去重不加 —— 必须拦住').toBe(0);
      expect(await balanceOf(users[1].id)).toBe(5);
    });
  }
});

describe('参数校验', () => {
  it('amount 非正整数 → FishBusinessError，无副作用', async () => {
    await makeUsers(1);
    for (const bad of [0, -1, 2.5, NaN]) {
      await expect(
        compensateAllUsers({ amount: bad, batchId: 'batch-1', rate: FAST }),
        `amount=${bad}`
      ).rejects.toThrow(FishBusinessError);
    }
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(await prisma.accountSyncLedger.count()).toBe(0);
  });

  it('rate 非正数 → FishBusinessError', async () => {
    await makeUsers(1);
    await expect(
      compensateAllUsers({ amount: 5, batchId: 'batch-1', rate: 0 })
    ).rejects.toThrow(FishBusinessError);
  });
});
