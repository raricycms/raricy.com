// fish-compensate.ts —— 全站群发补偿（CLI `fish compensate` 的底层）。
//
// 【为什么必须测】它是唯一一条**一次改全站每个人余额**的路径，而且没有网页入口、
// 只在服务器上跑。四条不变式：
//   1. 逐人原子：某一位失败，只回滚这一位，不能连累已发放的人
//   2. 续跑不重复发放：同一个 batchId 重跑，已发放的人必须原样跳过
//      —— 这条最关键：漏了它就是给同一批人发第二遍钱，而重跑恰恰是这功能的用法
//   3. 幂等键逐字节固定（迁移前跑了一半的批次，换个实现也能续上）
//   4. 账本里**非 synced** 的行不许重发：那是迁移前遗留的欠账（本地已提交、当年
//      远端那半笔状态不明），重发会在本地实打实地叠加一笔
//   5. **只发 core+** —— 非核心账号没有鱼干赚取渠道，补偿不能成为例外（见下方专项）
//
// 【账目自洽】凡发过钱的用例末尾都调 expectLedgerConsistent()：余额 == 流水之和
// （账户搬进站内后没有第二个存储可供核对了，内部一致性就是唯一的证明）。
// 本文件的用户一律 0 起步、余额全部来自发放路径，所以不需要 makeFishUser 那套
// 「给夹具余额找来源」的处理。
//
// 【DB】真实 SQLite（tests/.tmp/test-<pid>-<rand>.db），不 mock 任何东西 ——
// 这条路径上没有远端（账户微服务已搬进站内，见 docs/architecture.md §6.3.1）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  compensateAllUsers,
  compensateIdempotencyKey,
  makeBatchId,
  planCompensation,
} from '@/lib/fish-compensate';
import { FishBusinessError } from '@/lib/fish-admin';
import { unitsToFish } from '@/lib/fish-units';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';

beforeEach(async () => {
  await resetDb();
});

async function balanceOf(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}

async function ledgerRow(idempotencyKey: string) {
  return prisma.accountSyncLedger.findUnique({ where: { idempotencyKey } });
}

/** 某位用户拿到的补偿流水条数（按 type 数，不数他名下所有流水）。 */
function compensateTxCount(userId: string): Promise<number> {
  return prisma.fishTransaction.count({ where: { userId, type: 'system_compensate' } });
}

/**
 * 造 n 个**补偿对象**用户（core+），返回他们。
 *
 * 顺序与补偿的处理顺序无关，断言一律用集合语义。
 * 角色必须是 core+：补偿只发 core / admin / owner，默认的 `user` 会被整个跳过 ——
 * 那正是「非 core+ 一分不发」这条规则要的效果，见文件末尾的专项用例。
 */
async function makeUsers(n: number) {
  const users = [];
  for (let i = 0; i < n; i++) users.push(await makeUser({ driedFish: 0, role: 'core' }));
  return users;
}

describe('compensateIdempotencyKey：格式逐字节固定', () => {
  it('键 = comp-{sha256(compensate-batch-user-amount)[:16]}', () => {
    // 手算一份期望键（不调被测函数），验证逐字节一致 —— 这是跨实现续跑的前提。
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

  it('makeBatchId 是 12 位 hex', () => {
    expect(makeBatchId()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('compensateAllUsers：正常发放', () => {
  it('每位用户都 +amount、写 system_compensate 流水、账本留 synced 行', async () => {
    const users = await makeUsers(3);

    const r = await compensateAllUsers({ amount: 7, description: '故障补偿', batchId: 'batch-1' });

    expect(r).toMatchObject({
      batchId: 'batch-1', // 批次 ID 原样回报 —— 续跑的人要拿它再跑一次
      total: 3,
      succeeded: 3,
      skipped: 0,
      blocked: [],
      failed: [],
    });
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
    await expectLedgerConsistent('群发补偿之后');
  });

  it('被禁言的用户照样发（补偿是系统行为，与个人状态无关）', async () => {
    // role 必须是 core+：那才是「被禁言照发」要证的 —— 禁言不是降权，
    // 它不该把人从发放对象里剔掉（详见「只发 core+」一组）
    const banned = await makeUser({ driedFish: 0, role: 'core', isBanned: true, banReason: '测试' });
    const r = await compensateAllUsers({ amount: 4, batchId: 'batch-1' });

    expect(r.succeeded).toBe(1);
    expect(await balanceOf(banned.id)).toBe(4);
    await expectLedgerConsistent('给被禁言者发放之后');
  });

  it('库里没有（core+ 的）用户 → total=0，什么行都不写', async () => {
    const plain = await makeUser({ driedFish: 0 }); // role=user，不在发放范围

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1' });

    expect(r.total).toBe(0);
    expect(r.succeeded).toBe(0);
    expect(await balanceOf(plain.id)).toBe(0);
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await expectLedgerConsistent('没有发放对象时');
  });

  it('dry-run：给出目标数，但一分钱不动', async () => {
    const users = await makeUsers(2);
    const r = await compensateAllUsers({ amount: 9, batchId: 'batch-1', dryRun: true });

    expect(r).toMatchObject({ total: 2, succeeded: 0, dryRun: true });
    for (const u of users) expect(await balanceOf(u.id)).toBe(0);
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await expectLedgerConsistent('dry-run 之后');
  });

  it('onProgress：每位用户处理完回调一次（dry-run 下一次都不调）', async () => {
    const users = await makeUsers(3);
    const seen: string[] = [];

    await compensateAllUsers({
      amount: 2,
      batchId: 'batch-1',
      onProgress: (done, total, username) => {
        // CLI 的打进度就靠它：少一次调用 = 少打一行进度（而这是跑几百人的命令，
        // 中途静默会让人以为卡死）
        expect(total).toBe(3);
        expect(done).toBe(seen.length + 1); // done 是「已完成数」，从 1 起
        seen.push(username);
      },
    });

    expect(seen.slice().sort()).toEqual(users.map((u) => u.username).sort());

    // dry-run 是只读预检：连进度都不该有（一行都没处理）
    const seenInDryRun: number[] = [];
    await compensateAllUsers({
      amount: 2,
      batchId: 'batch-2',
      dryRun: true,
      onProgress: (done) => seenInDryRun.push(done),
    });
    expect(seenInDryRun).toEqual([]);
  });
});

describe('★ 续跑：同一个 batchId 重跑不重复发放', () => {
  it('已 synced 的用户被跳过，余额不再增加、也不再多写流水', async () => {
    const users = await makeUsers(3);

    const first = await compensateAllUsers({ amount: 6, batchId: 'batch-1' });
    expect(first.succeeded).toBe(3);

    // 第二次：模拟「跑到一半崩了，运维拿同一个批次 ID 续跑」
    const second = await compensateAllUsers({ amount: 6, batchId: 'batch-1' });

    expect(second, '重跑时这 3 位都该被判为已完成').toMatchObject({
      total: 3,
      succeeded: 0,
      skipped: 3,
      blocked: [],
      failed: [],
    });
    for (const u of users) {
      expect(await balanceOf(u.id), `${u.username} 余额被重复发放了`).toBe(6);
      expect(
        await compensateTxCount(u.id),
        '跳过的人必须一条流水都不多写 —— 「跳过」这个判定要真的落到钱上'
      ).toBe(1);
    }
    // 登记行还是原来那三行：没有新增、也没有被重写
    expect(await prisma.accountSyncLedger.count()).toBe(3);
    await expectLedgerConsistent('同批次续跑之后');
  });

  it('换了 batchId 就是新的一批，正常再发一次', async () => {
    const [u] = await makeUsers(1);
    await compensateAllUsers({ amount: 6, batchId: 'batch-1' });
    const second = await compensateAllUsers({ amount: 6, batchId: 'batch-2' });

    expect(second).toMatchObject({ succeeded: 1, skipped: 0 });
    expect(await balanceOf(u.id), '新批次是独立的一笔，本就该再发').toBe(12);
    expect(await compensateTxCount(u.id)).toBe(2);
    await expectLedgerConsistent('两个批次之后');
  });

  it('断点续跑：新用户加进来后，老用户跳过、新用户拿到', async () => {
    const [a] = await makeUsers(1);
    await compensateAllUsers({ amount: 6, batchId: 'batch-1' });

    const b = await makeUser({ driedFish: 0, role: 'core' });
    const r = await compensateAllUsers({ amount: 6, batchId: 'batch-1' });

    expect(r).toMatchObject({ total: 2, succeeded: 1, skipped: 1 });
    expect(await balanceOf(a.id)).toBe(6);
    expect(await balanceOf(b.id), '续跑新覆盖到的人应当拿到').toBe(6);
    await expectLedgerConsistent('覆盖集合变了之后续跑');
  });

  it('planCompensation 带 batchId：预检出「会跳过几位 / 卡住几位」（确认屏靠它）', async () => {
    await makeUsers(1);
    await compensateAllUsers({ amount: 6, batchId: 'batch-1' });
    const b = await makeUser({ driedFish: 0, role: 'core' });

    const p = await planCompensation({ amount: 6, batchId: 'batch-1' });
    expect(p).toMatchObject({ total: 2, alreadyDone: 1, blocked: 0, amount: 6, totalFish: 12 });

    // 给 b 造一行迁移前遗留的 pending（下一组用例详述）：预检要把它算成「卡住」
    await prisma.accountSyncLedger.create({
      data: {
        idempotencyKey: compensateIdempotencyKey('batch-1', b.id, 6),
        operation: 'compensate',
        payload: JSON.stringify({ userId: b.id, amount: 6 }),
        status: 'pending',
        attempts: 1,
      },
    });
    expect(await planCompensation({ amount: 6, batchId: 'batch-1' })).toMatchObject({
      alreadyDone: 1,
      blocked: 1,
    });
    // 预检**不写库**：账本里还是「原批次那行 + 手造这行」
    expect(await prisma.accountSyncLedger.count()).toBe(2);
    await expectLedgerConsistent('只读预检之后');
  });
});

describe('★ 逐人原子：一位失败不连累其他人', () => {
  /**
   * 让 victim 在「轮到他之前」消失 —— 于是轮到他的那一刻，入账写不到用户行，
   * 他那一笔事务整体失败。
   *
   * 注入点：每位用户先按幂等键点查一次账本（prisma.accountSyncLedger.findUnique），
   * 借这次 **awaited** 的读把用户删掉。（onProgress 是同步回调，塞不进 await，
   * 所以不用它来安排这个时点。）
   */
  function vanishOnNthLookup(victimId: string, nth: number) {
    const real = prisma.accountSyncLedger.findUnique.bind(prisma.accountSyncLedger);
    let calls = 0;
    vi.spyOn(prisma.accountSyncLedger, 'findUnique').mockImplementation((async (args: unknown) => {
      calls++;
      if (calls === nth) await prisma.user.delete({ where: { id: victimId } });
      return real(args as never);
    }) as never);
  }

  it('单人失败 → 他一个都不发，其余照常发放', async () => {
    const users = await makeUsers(3);
    const victim = users[1];
    vanishOnNthLookup(victim.id, 2); // 第 1 次点查是 users[0] 的，第 2 次是 victim 的

    const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1' });

    expect(r.succeeded).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.blocked).toEqual([]);
    expect(r.failed.map((f) => f.username)).toEqual([victim.username]);

    // 失败者**绝不能留下登记行** —— 这是最要命的一条：键被占住，续跑就会把他
    // 当成「已发放」跳过，那笔钱永远发不出去（余额没加、键却占死了）。
    // （他的用户行已经被删掉，所以「余额为 0」无从断言 —— 能且必须钉的是这个键。）
    expect(
      await ledgerRow(compensateIdempotencyKey('batch-1', victim.id, 5)),
      '失败 = 整笔回滚，键也得跟着没写进去'
    ).toBeNull();
    expect(await prisma.fishTransaction.count({ where: { userId: victim.id } })).toBe(0);

    for (const ok of [users[0], users[2]]) {
      expect(await balanceOf(ok.id), '别人不该被连累').toBe(5);
      expect(await compensateTxCount(ok.id)).toBe(1);
    }
    await expectLedgerConsistent('一位用户失败之后');
  });

  it('失败的那一位在续跑时会被补上（键没被占住）', async () => {
    const users = await makeUsers(2);
    const victim = users[0];
    vanishOnNthLookup(victim.id, 1); // 第 1 次点查就是 victim 的

    const first = await compensateAllUsers({ amount: 5, batchId: 'batch-1' });
    expect(first.failed.map((f) => f.username)).toEqual([victim.username]);
    expect(first.succeeded).toBe(1);

    // 账号回来了（真实场景：删除是误操作，恢复之后再续跑）
    const restored = await makeUser({ id: victim.id, username: victim.username, role: 'core' });

    const second = await compensateAllUsers({ amount: 5, batchId: 'batch-1' });
    expect(second).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(await balanceOf(restored.id), '没发成功的人必须被补上').toBe(5);
    await expectLedgerConsistent('续跑补发之后');
  });
});

describe('★ 账本里非 synced 的遗留行不许重发', () => {
  for (const status of ['pending', 'failed'] as const) {
    it(`${status} → 记进 blocked，一位都不发（余额不动）`, async () => {
      const users = await makeUsers(2);
      const stuck = users[0];
      const key = compensateIdempotencyKey('batch-1', stuck.id, 5);

      // 手造一行**迁移前遗留**的登记行。新写入的行一律是 synced（登记与发放同事务
      // 提交），所以非 synced 只可能来自当年那套 outbox：本地已提交、远端那半笔
      // 状态不明。用它构造场景，正是要证明现在会挡住重发而不是再发一笔。
      await prisma.accountSyncLedger.create({
        data: {
          idempotencyKey: key,
          operation: 'compensate',
          payload: JSON.stringify({ userId: stuck.id, amount: 5, description: 'x' }),
          status,
          attempts: 1,
        },
      });

      const r = await compensateAllUsers({ amount: 5, batchId: 'batch-1' });

      expect(r.blocked).toEqual([{ username: stuck.username, status }]);
      expect(r.succeeded, '另一位该正常发放').toBe(1);
      expect(
        await balanceOf(stuck.id),
        '重发会在本地实打实叠加一笔，而当年那半笔到底落地没有无从得知 —— 必须拦住'
      ).toBe(0);
      expect(await prisma.fishTransaction.count({ where: { userId: stuck.id } })).toBe(0);
      expect(await balanceOf(users[1].id)).toBe(5);
      await expectLedgerConsistent('遗留行挡住重发之后');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 发放对象 = core+（core / admin / owner）
//
// 【为什么必须钉】这是全站唯一一条「一次改很多人余额」的路径。鱼干的赚取渠道
// （签到翻牌、投喂分成）全在 core 门槛之后，一旦补偿把 `user` 也纳进来，就等于
// 给未认证账号开了「注册即领鱼干」的口子 —— 而且是在服务器上静默发生的。
// 反向的那半（core 照发、禁言照发）同样要钉：收紧不能误伤。
// ─────────────────────────────────────────────────────────────────────────────
describe('★ 只发 core+', () => {
  it('role=user 一分不发', async () => {
    const plain = await makeUser({ driedFish: 0 }); // 默认 role='user'
    const core = await makeUser({ driedFish: 0, role: 'core' });

    const r = await compensateAllUsers({ amount: 7, batchId: 'batch-1' });

    expect(r.total, '目标集合里不该有 role=user').toBe(1);
    expect(await balanceOf(plain.id), '非核心账号不该从补偿里拿到鱼干').toBe(0);
    expect(await balanceOf(core.id)).toBe(7);
    // 连一条流水都不该为它写 —— 少写一行就是少一次记错账的机会
    expect(await prisma.fishTransaction.count()).toBe(1);
    expect(await prisma.accountSyncLedger.count()).toBe(1);
    await expectLedgerConsistent('跳过非核心账号之后');
  });

  it('admin / owner 同样在发放范围内', async () => {
    const admin = await makeUser({ driedFish: 0, role: 'admin' });
    const owner = await makeUser({ driedFish: 0, role: 'owner' });

    const r = await compensateAllUsers({ amount: 3, batchId: 'batch-1' });

    expect(r.total).toBe(2);
    expect(await balanceOf(admin.id)).toBe(3);
    expect(await balanceOf(owner.id)).toBe(3);
    await expectLedgerConsistent('给 admin / owner 发放之后');
  });

  it('planCompensation 与实发集合一致（预检屏上的数就是真会发的人数）', async () => {
    await makeUser({ driedFish: 0 }); // user
    await makeUser({ driedFish: 0, role: 'core' });
    await makeUser({ driedFish: 0, role: 'owner' });

    const p = await planCompensation({ amount: 5 });
    expect(p.total, '确认屏把 role=user 也算进去的话，运维会以为要发给三个人').toBe(2);
    expect(p.totalFish).toBe(10);
  });
});

describe('参数校验', () => {
  it('amount 非正整数 → FishBusinessError，无副作用', async () => {
    await makeUsers(1);
    for (const bad of [0, -1, 2.5, NaN]) {
      await expect(
        compensateAllUsers({ amount: bad, batchId: 'batch-1' }),
        `amount=${bad}`
      ).rejects.toThrow(FishBusinessError);
    }
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await expectLedgerConsistent('非法入参被拒之后');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 这里原有三组用例，测的都是**站外账户微服务时代的机制**，随那台服务一起消失：
//
//   · 「限频（rate）」—— 当年逐人之间要 sleep，纯粹为了让那台远端的 QPS 好看。
//     现在发放是本地事务，没有需要讨好的对端；`rate` 参数已从
//     CompensateOptions / CompensatePlan 里删掉，连 `estimatedMs` 一起。
//   · 「连续失败 N 位即中止」「429 立即中止」—— 中止条件是照着**远端整体不可用**
//     设计的（失败会成片出现，继续打只会把队列刷爆）。本地没有远端可打，也就没有
//     「整体不可用」这个故障形态：单笔失败只可能是这个用户自己的事（行没了、库报错），
//     继续把剩下的人跑完才是对的。`aborted` / `abortReason` /
//     MAX_CONSECUTIVE_FAILURES 随之删除。
//   · 「远端 transfer：系统账户 → 用户，entryType=system_compensate」—— 那一跳没了。
//     本地要钉的是流水的 type（`system_compensate`，与 admin_grant 区分开）与
//     幂等键逐字节固定，上面都钉了。
//   · 「rate 非正数 → FishBusinessError」—— 被校验的那个参数本身没了。
// ─────────────────────────────────────────────────────────────────────────────
