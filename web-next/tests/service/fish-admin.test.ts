// fish-admin.ts —— 管理员手动发/扣小鱼干（CLI `fish grant|deduct` 的底层）。
//
// 【为什么必须测】这是**人工改余额**的路径，且没有网页入口、只在服务器上跑 ——
// 出错时没有用户会替你发现，只会在某次对账时冒出来。三条不变式：
//   1. fail-closed：远端失败 → 本地零痕迹（不能「本地改了余额但远端没记账」）
//   2. 扣减必须原子（WHERE driedFish >= amount），不能把余额扣成负数
//   3. 生产漏配账户服务 → 拒绝执行（不能 fail-OPEN 静默只改本地）

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

import { adminGrantFish, adminDeductFish, FishBusinessError } from '@/lib/fish-admin';
import { AccountServiceError, SYSTEM_USER_ID } from '@/lib/account-client';
import { resetDb, makeUser, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
  mockEnabled.mockReset();
  mockTransfer.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function enableRemote() {
  mockEnabled.mockReturnValue(true);
  mockTransfer.mockResolvedValue({ ok: true });
}

async function snapshot(userId: string) {
  const [u, txns] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } }),
    prisma.fishTransaction.count({ where: { userId } }),
  ]);
  return { driedFish: u?.driedFish ?? 0, txns };
}

describe('adminGrantFish：赠送', () => {
  it('余额增加、写 admin_grant 流水、返回新余额', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 10 });

    const balance = await adminGrantFish(u.id, 5, '测试赠送');
    expect(balance).toBe(15);

    const s = await snapshot(u.id);
    expect(s.driedFish).toBe(15);
    expect(s.txns).toBe(1);
    const t = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(t.type).toBe('admin_grant');
    expect(t.amount, '赠送记正数').toBe(5);
    expect(t.description).toBe('测试赠送');
    expect(t.createdAt, 'createdAt 落 NULL 会让流水页排序失效').not.toBeNull();
  });

  it('远端 transfer：系统账户 → 用户，entryType=admin_grant', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 0 });
    await adminGrantFish(u.id, 3);

    const arg = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fromUserId, '发放必须从系统账户出').toBe(SYSTEM_USER_ID);
    expect(arg.toUserId).toBe(u.id);
    expect(arg.amount).toBe(3);
    expect(arg.entryType).toBe('admin_grant');
    expect(String(arg.idempotencyKey), '幂等键格式对齐 Flask cli-grant-{id}-{ts}-{amount}').toMatch(
      new RegExp(`^cli-grant-${u.id}-\\d+-3$`)
    );
  });

  it('参数非法（0 / 负数 / 小数 / NaN）→ FishBusinessError 且无副作用', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 10 });
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(adminGrantFish(u.id, bad), `amount=${bad}`).rejects.toThrow(FishBusinessError);
    }
    expect(await snapshot(u.id)).toEqual({ driedFish: 10, txns: 0 });
    expect(mockTransfer, '参数就不合法，不该打远端').not.toHaveBeenCalled();
  });
});

describe('adminDeductFish：扣减', () => {
  it('余额减少、写 admin_deduct 流水（负数）', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 10 });

    const balance = await adminDeductFish(u.id, 4, '测试扣减');
    expect(balance).toBe(6);

    const t = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(t.type).toBe('admin_deduct');
    expect(t.amount, '扣减记负数（对齐 feed 的记法）').toBe(-4);
  });

  it('★ 余额不足 → 拒绝，余额不变、无流水、不打远端', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 3 });

    await expect(adminDeductFish(u.id, 4)).rejects.toThrow(FishBusinessError);
    expect(await snapshot(u.id), '余额被扣成负数或留下了流水').toEqual({ driedFish: 3, txns: 0 });
    expect(mockTransfer, '本地都没扣成，不该打远端').not.toHaveBeenCalled();
  });

  it('边界：恰好扣光放行，多扣 1 拒绝', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 5 });
    expect(await adminDeductFish(u.id, 5), '恰好扣光应放行').toBe(0);
    await expect(adminDeductFish(u.id, 1), '已经是 0 了，再扣必须拒绝').rejects.toThrow(
      FishBusinessError
    );
  });

  it('★ 并发扣减不会超扣（原子 WHERE driedFish >= amount）', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 10 });

    // 5 笔并发各扣 4（合计 20 > 余额 10）→ 最多只能成功 2 笔
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => adminDeductFish(u.id, 4))
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    const s = await snapshot(u.id);
    expect(s.driedFish, '余额被扣成负数 —— 原子扣减失效').toBeGreaterThanOrEqual(0);
    expect(s.driedFish).toBe(10 - ok * 4);
    expect(s.txns, '成功几笔就该有几条流水').toBe(ok);
  });

  it('远端 transfer：用户 → 系统账户（扣减方向相反）', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 10 });
    await adminDeductFish(u.id, 2);

    const arg = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fromUserId, '扣减是从用户账户转出').toBe(u.id);
    expect(arg.toUserId).toBe(SYSTEM_USER_ID);
    expect(arg.entryType).toBe('admin_deduct');
  });
});

describe('★ fail-closed：远端失败 → 本地零痕迹', () => {
  const FAILURES: Array<[string, unknown]> = [
    ['AccountServiceError(503)', new AccountServiceError('远端不可达', 503)],
    ['普通 Error', new Error('boom')],
    ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ];

  for (const [name, err] of FAILURES) {
    it(`grant 时 ${name} → 余额与流水无变化`, async () => {
      mockEnabled.mockReturnValue(true);
      mockTransfer.mockRejectedValue(err);
      const u = await makeUser({ driedFish: 7 });

      await expect(adminGrantFish(u.id, 5)).rejects.toThrow();
      expect(await snapshot(u.id), `${name} 后本地留下痕迹 = 本地发了鱼但远端没记账`).toEqual({
        driedFish: 7,
        txns: 0,
      });
    });

    it(`deduct 时 ${name} → 余额与流水无变化`, async () => {
      mockEnabled.mockReturnValue(true);
      mockTransfer.mockRejectedValue(err);
      const u = await makeUser({ driedFish: 7 });

      await expect(adminDeductFish(u.id, 5)).rejects.toThrow();
      expect(await snapshot(u.id), `${name} 后本地留下痕迹 = 本地扣了鱼但远端没记账`).toEqual({
        driedFish: 7,
        txns: 0,
      });
    });
  }
});

describe('未配置账户服务', () => {
  it('开发环境 → dev fallback：仅写本地 + 告警', async () => {
    mockEnabled.mockReturnValue(false);
    vi.stubEnv('NODE_ENV', 'development');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = await makeUser({ driedFish: 0 });

    expect(await adminGrantFish(u.id, 5)).toBe(5);
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(warn, 'dev fallback 必须留告警').toHaveBeenCalled();
    warn.mockRestore();
  });

  it('★ 生产环境 → 拒绝执行（不能 fail-OPEN）', async () => {
    mockEnabled.mockReturnValue(false);
    vi.stubEnv('NODE_ENV', 'production');
    const u = await makeUser({ driedFish: 10 });

    await expect(adminGrantFish(u.id, 5), '生产漏配账户服务时静默只改本地 = 账目分叉').rejects.toThrow(
      AccountServiceError
    );
    await expect(adminDeductFish(u.id, 5)).rejects.toThrow(AccountServiceError);

    expect(await snapshot(u.id)).toEqual({ driedFish: 10, txns: 0 });
  });
});
