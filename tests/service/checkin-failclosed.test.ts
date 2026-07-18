// checkin-service —— 签到发鱼干的 fail-closed 远端同步。
//
// 【为什么单独一个文件】需要 vi.mock 掉 account-client，而
// tests/service/checkin-service.test.ts 测的是本地语义（UTC+8 边界/唯一约束/运势），
// 用真实模块跑 dev fallback 分支。两者混在一起会互相干扰。
//
// 【为什么这块必须测】签到是发钱路径。曾经 checkin-service **完全没接账户微服务**
// （0 处调用，只有一行「本切片仅写本地 DB」的注释），而 Flask 的 claim_fortune 是
// 接了 fail-closed 的。后果：签到发的鱼只进本地库、远端账户毫不知情 ——
// 账目从切换第一天起就开始分叉，且完全静默。
//
// fail-closed 的核心不变式：**远端失败 → 本地必须零痕迹**。
// 「本地已发鱼但远端没记账」是这里最危险的失败模式。

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

import { doCheckin, todayUtc8 } from '@/lib/checkin-service';
import { AccountServiceError, SYSTEM_USER_ID } from '@/lib/account-client';
import { resetDb, makeUser, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
  mockEnabled.mockReset();
  mockTransfer.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** 远端已配置且一切正常。 */
function enableRemote() {
  mockEnabled.mockReturnValue(true);
  mockTransfer.mockResolvedValue({ ok: true });
}

/** 该用户当前的全部本地痕迹 —— 用于断言「零痕迹」。 */
async function snapshot(userId: string) {
  const [u, checkins, txns] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true, totalFortune: true } }),
    prisma.dailyCheckIn.count({ where: { userId } }),
    prisma.fishTransaction.count({ where: { userId } }),
  ]);
  return { driedFish: u?.driedFish ?? 0, totalFortune: u?.totalFortune ?? 0, checkins, txns };
}

describe('远端正常：签到成功且远端被正确调用', () => {
  it('调用 transfer：系统账户 → 用户，金额 = 运势值，幂等键 checkin-{userId}-{date}', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 0 });

    const r = await doCheckin(u.id, 0);
    expect(r.alreadyChecked).toBe(false);
    if (r.alreadyChecked || 'invalidChoice' in r) return;

    expect(mockTransfer).toHaveBeenCalledTimes(1);
    const arg = mockTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fromUserId, '发放必须从系统账户出').toBe(SYSTEM_USER_ID);
    expect(arg.toUserId).toBe(u.id);
    expect(arg.amount, '远端金额必须与本地发的鱼干一致').toBe(r.fortuneValue);
    expect(arg.entryType).toBe('checkin');
    expect(
      arg.idempotencyKey,
      '幂等键决定重复提交会不会重复发放 —— 必须按 用户+日期 唯一'
    ).toBe(`checkin-${u.id}-${todayUtc8()}`);
    expect(arg.description).toBe(`每日签到（运势值 ${r.fortuneValue}）`);

    // 本地也确实发了
    const s = await snapshot(u.id);
    expect(s.driedFish).toBe(r.fortuneValue);
    expect(s.checkins).toBe(1);
    expect(s.txns).toBe(1);
  });

  it('★ 远端同步发生在本地 commit 之前（不是提交后补偿）', async () => {
    enableRemote();
    const u = await makeUser({ driedFish: 0 });

    // 在 transfer 回调里用**独立连接**读库：若此时已能看到签到记录，
    // 说明本地先提交了 —— 那就不是 fail-closed，而是「先扣款后对账」。
    let seenDuringTransfer: number | null = null;
    mockTransfer.mockImplementation(async () => {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT COUNT(*) AS n FROM daily_checkins WHERE user_id = ?`,
        u.id
      );
      seenDuringTransfer = Number(rows[0].n);
      return { ok: true };
    });

    await doCheckin(u.id, 0);
    expect(
      seenDuringTransfer,
      '远端调用时本地事务已提交 → 远端失败就回滚不掉了，fail-closed 名存实亡'
    ).toBe(0);
  });
});

describe('★ 远端失败 → 本地零痕迹（fail-closed 的核心）', () => {
  const FAILURES: Array<[string, unknown]> = [
    ['AccountServiceError(503)', new AccountServiceError('远端不可达', 503)],
    ['AccountServiceError(500)', new AccountServiceError('远端内部错误', 500)],
    ['普通 Error', new Error('boom')],
    ['网络中断 AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ];

  for (const [name, err] of FAILURES) {
    it(`${name} → 抛错，且余额/签到记录/流水全部无变化`, async () => {
      mockEnabled.mockReturnValue(true);
      mockTransfer.mockRejectedValue(err);
      const u = await makeUser({ driedFish: 10, totalFortune: 3 });
      const before = await snapshot(u.id);

      await expect(doCheckin(u.id, 0), '远端失败必须抛错，不能静默成功').rejects.toThrow();

      const after = await snapshot(u.id);
      expect(after, `${name} 后本地留下了痕迹 —— 本地发了鱼但远端没记账`).toEqual(before);
      expect(after.driedFish).toBe(10);
      expect(after.totalFortune).toBe(3);
      expect(after.checkins).toBe(0);
      expect(after.txns).toBe(0);
    });
  }

  it('远端失败后重试成功 → 只记一次账（不会因为第一次失败而漏/重）', async () => {
    mockEnabled.mockReturnValue(true);
    mockTransfer.mockRejectedValueOnce(new AccountServiceError('临时故障', 503));
    const u = await makeUser({ driedFish: 0 });

    await expect(doCheckin(u.id, 0)).rejects.toThrow();
    expect(await snapshot(u.id)).toMatchObject({ checkins: 0, txns: 0, driedFish: 0 });

    // 重试
    mockTransfer.mockResolvedValue({ ok: true });
    const r = await doCheckin(u.id, 0);
    expect(r.alreadyChecked).toBe(false);

    const s = await snapshot(u.id);
    expect(s.checkins, '重试后应恰好一条签到记录').toBe(1);
    expect(s.txns, '重试后应恰好一条流水').toBe(1);
  });

  it('普通异常被包装成 AccountServiceError(503)（对齐 Flask 的兜底分支）', async () => {
    mockEnabled.mockReturnValue(true);
    mockTransfer.mockRejectedValue(new Error('unexpected'));
    const u = await makeUser();

    await expect(doCheckin(u.id, 0)).rejects.toThrow(AccountServiceError);
  });
});

describe('未配置账户服务时的行为', () => {
  it('开发环境 → dev fallback：仅写本地并告警，签到成功', async () => {
    mockEnabled.mockReturnValue(false);
    vi.stubEnv('NODE_ENV', 'development');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = await makeUser({ driedFish: 0 });

    const r = await doCheckin(u.id, 0);
    expect(r.alreadyChecked).toBe(false);
    expect(mockTransfer, 'dev fallback 不该打远端').not.toHaveBeenCalled();
    expect(warn, 'dev fallback 必须留下告警，不能悄无声息').toHaveBeenCalled();
    expect((await snapshot(u.id)).checkins).toBe(1);
    warn.mockRestore();
  });

  it('★ 生产环境 → 拒绝签到（不能 fail-OPEN）', async () => {
    mockEnabled.mockReturnValue(false);
    vi.stubEnv('NODE_ENV', 'production');
    const u = await makeUser({ driedFish: 0 });

    // 漏配 ACCOUNT_SERVICE_INTERNAL_TOKEN 时若静默放行，签到会只发本地鱼干、
    // 远端毫无记账，账目从第一天就分叉，且只留一条 console.warn —— 与 fail-closed 相反。
    await expect(
      doCheckin(u.id, 0),
      '生产环境漏配账户服务时静默发鱼 = fail-OPEN'
    ).rejects.toThrow(AccountServiceError);

    expect(await snapshot(u.id)).toMatchObject({ checkins: 0, txns: 0, driedFish: 0 });
  });
});
