// fish-admin.ts —— 管理员手动发/扣小鱼干（CLI `fish grant|deduct` 的底层）。
//
// 【为什么必须测】这是**人工改余额**的路径，且没有网页入口、只在服务器上跑 ——
// 出错时没有用户会替你发现，只会在某次对账时冒出来。四条不变式：
//   1. 扣减必须原子（单条带谓词的 UPDATE：`driedFish >= need`），不能把余额扣成负数
//   2. 余额与流水在**同一个事务**里提交 —— 不存在「改了余额没写流水」的中间态，
//      因此也不存在需要事后撤销的半笔账
//   3. 发 / 扣都**不登记幂等记录**：这两条路径的键带随机后缀，每跑一次就是一笔新的，
//      登记没有去重价值（判据见 src/lib/fish-idempotency.ts 头部）；只有群发补偿
//      （键由 batchId + userId + amount 派生）才登记
//   4. 两种 type 不许混：`admin_grant` 是「管理员手动给」，`system_compensate` 是
//      「系统补偿」，流水页上它们是两件事
//
// 【账目自洽】凡改过余额的用例末尾都调 expectLedgerConsistent()：余额 == 流水之和
// （账户搬进站内后没有第二个存储可供核对了，内部一致性就是唯一的证明）。
// 夹具里那个有余额的用户一律用 `makeFishUser()` 造 —— 它的余额**经由记账内核**
// 进入（与线上同构），直接塞 users.driedFish 会让不变式从第一个用例起就不成立。

import { describe, it, expect, beforeEach } from 'vitest';

import { adminGrantFish, adminDeductFish, grantFish, FishBusinessError } from '@/lib/fish-admin';
import { unitsToFish } from '@/lib/fish-units';
import { resetDb, prisma } from '../helpers/db';
import { expectLedgerConsistent, makeFishUser } from '../helpers/fish-ledger';

beforeEach(async () => {
  await resetDb();
});

/**
 * 记下当前最大流水 id。
 *
 * 【为什么需要它】`makeFishUser` 给夹具用户写的那笔开户流水是 **admin_grant** ——
 * 与本文件被测操作同一种 type，按 type 过滤分不开「夹具」与「本次操作」。
 * 于是「这次写了几条流水」一律按 id 数：进测试时记个标记，之后只数 id 更大的。
 */
async function txMark(): Promise<number> {
  const last = await prisma.fishTransaction.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return last?.id ?? 0;
}

/** 本次操作（标记之后）新写的流水条数。 */
function txCountSince(mark: number, userId: string): Promise<number> {
  return prisma.fishTransaction.count({ where: { userId, id: { gt: mark } } });
}

async function snapshot(userId: string) {
  const [u, ledgerRows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } }),
    prisma.accountSyncLedger.count(), // 全表的幂等登记行 —— 发 / 扣都不该写（见文件头第 3 条）
  ]);
  return {
    driedFish: u ? unitsToFish(u.driedFish) : 0, // 存储单位 → 鱼干
    ledgerRows,
  };
}

describe('adminGrantFish：赠送', () => {
  it('余额增加、写 admin_grant 流水、返回新余额', async () => {
    const u = await makeFishUser(10);
    const mark = await txMark();

    const balance = await adminGrantFish(u.id, 5, '测试赠送');
    expect(balance, '返回值是**变更后**的余额，不是增量').toBe(15);

    const t = await prisma.fishTransaction.findFirstOrThrow({
      where: { userId: u.id, description: '测试赠送' },
    });
    expect(t.type).toBe('admin_grant');
    expect(unitsToFish(t.amount), '赠送记正数（存储单位换回鱼干）').toBe(5);
    expect(t.createdAt, 'createdAt 落 NULL 会让流水页排序失效').not.toBeNull();
    // 10 → 15 说明是**加**上去的（不是把余额赋值成 5），且一次赠送只落一条流水
    expect(await snapshot(u.id)).toMatchObject({ driedFish: 15 });
    expect(await txCountSince(mark, u.id), '一次赠送写且仅写一条流水').toBe(1);
    await expectLedgerConsistent('管理员赠送之后');
  });

  it('参数非法（0 / 负数 / 小数 / NaN）→ FishBusinessError 且无副作用', async () => {
    const u = await makeFishUser(10);
    const mark = await txMark();

    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(adminGrantFish(u.id, bad), `amount=${bad}`).rejects.toThrow(FishBusinessError);
    }

    expect(await snapshot(u.id), '参数就不合法，什么都不该发生').toEqual({
      driedFish: 10,
      ledgerRows: 0,
    });
    expect(await txCountSince(mark, u.id)).toBe(0);
    await expectLedgerConsistent('非法入参被拒之后');
  });
});

describe('adminDeductFish：扣减', () => {
  it('余额减少、写 admin_deduct 流水（负数）', async () => {
    const u = await makeFishUser(10);
    const mark = await txMark();

    const balance = await adminDeductFish(u.id, 4, '测试扣减');
    expect(balance, '返回值是**变更后**的余额').toBe(6);

    const t = await prisma.fishTransaction.findFirstOrThrow({
      where: { userId: u.id, description: '测试扣减' },
    });
    expect(t.type).toBe('admin_deduct');
    expect(unitsToFish(t.amount), '扣减记负数（与 feed 同一种记法；存储单位换回鱼干）').toBe(-4);
    expect(await txCountSince(mark, u.id), '一次扣减写且仅写一条流水').toBe(1);
    await expectLedgerConsistent('管理员扣减之后');
  });

  it('★ 余额不足 → 拒绝，余额不变、无流水', async () => {
    const u = await makeFishUser(3);
    const mark = await txMark();

    const err = await adminDeductFish(u.id, 4).catch((e) => e);
    expect(err, '记账内核抛的 InsufficientFishError 在这层转成业务错误').toBeInstanceOf(
      FishBusinessError
    );
    expect((err as Error).message, 'CLI 直接把这句话报给运维').toBe('小鱼干不足');
    expect(await snapshot(u.id), '余额被扣成负数或留下了流水').toEqual({
      driedFish: 3,
      ledgerRows: 0,
    });
    expect(await txCountSince(mark, u.id)).toBe(0);
    await expectLedgerConsistent('余额不足被拒之后');
  });

  it('边界：恰好扣光放行，多扣 1 拒绝', async () => {
    const u = await makeFishUser(5);
    expect(await adminDeductFish(u.id, 5), '恰好扣光应放行').toBe(0);
    await expect(adminDeductFish(u.id, 1), '已经是 0 了，再扣必须拒绝').rejects.toThrow(
      FishBusinessError
    );
    await expectLedgerConsistent('扣光之后再扣被拒之后');
  });

  it('★ 并发扣减不会超扣（原子 WHERE driedFish >= need）', async () => {
    const u = await makeFishUser(10);
    const mark = await txMark();

    // 5 笔并发各扣 4（合计 20 > 余额 10）→ 最多只能成功 2 笔
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => adminDeductFish(u.id, 4))
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    expect((await snapshot(u.id)).driedFish, '余额被扣成负数 —— 原子扣减失效').toBe(10 - ok * 4);
    expect(await txCountSince(mark, u.id), '成功几笔就该有几条流水').toBe(ok);
    await expectLedgerConsistent('并发扣减之后');
  });
});

describe('★ 幂等登记', () => {
  it('grant 与 deduct 都不登记（键带随机后缀 → 登记只会把表撑大）', async () => {
    const u = await makeFishUser(0);
    const mark = await txMark();

    await adminGrantFish(u.id, 5, '第一次');
    await adminGrantFish(u.id, 5, '第二次');
    await adminDeductFish(u.id, 3);

    expect(
      await prisma.accountSyncLedger.count(),
      '登记行只服务于**确定的键**（转账 / 群发补偿）。这两条路径每次都是新的一笔，' +
        '登记没有去重价值，还会把「表里有什么」这件事搅浑'
    ).toBe(0);
    // 也就意味着：同样的参数再跑一次**就是再发一笔**，不会被静默去重
    expect(await snapshot(u.id)).toMatchObject({ driedFish: 7 });
    expect(await txCountSince(mark, u.id)).toBe(3);
    await expectLedgerConsistent('多次发扣之后');
  });

  it('★ 给了确定的键才登记：同键重放被唯一约束挡下，且整笔回滚（钱不会被发第二遍）', async () => {
    // 这是「登记与发放必须同一个事务」那条纪律的实测：撞键时失败发生在
    // addFish 之后（登记是同一事务里的第二条写入），若两者分开提交，
    // 就会出现「余额加了、键没占住」—— 下次重放再发一笔。
    const u = await makeFishUser(0);
    const key = 'comp-batch-1-user-1-5'; // 补偿那种**确定的**键

    await grantFish({
      userId: u.id,
      amount: 5,
      description: '第一次',
      operation: 'compensate',
      idempotencyKey: key,
    });
    await expect(
      grantFish({
        userId: u.id,
        amount: 5,
        description: '第二次',
        operation: 'compensate',
        idempotencyKey: key,
      }),
      '同键重放必须被挡下（唯一约束），而不是再发一笔'
    ).rejects.toThrow();

    expect((await snapshot(u.id)).driedFish).toBe(5);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(1);
    expect(await prisma.accountSyncLedger.count()).toBe(1);
    await expectLedgerConsistent('同键重放被拒之后');
  });

  it('两种 type 不许混：admin_grant ≠ system_compensate（补偿不冒充管理员手动赠送）', async () => {
    const u = await makeFishUser(0);

    await adminGrantFish(u.id, 5, '手动赠送');
    await grantFish({
      userId: u.id,
      amount: 5,
      description: '系统补偿',
      operation: 'compensate',
    });

    const rows = await prisma.fishTransaction.findMany({
      where: { userId: u.id },
      orderBy: { id: 'asc' },
      select: { type: true },
    });
    expect(
      rows.map((t) => t.type),
      '流水页上「系统补偿」与「管理员手动赠送」是两件能被分开的事'
    ).toEqual(['admin_grant', 'system_compensate']);
    await expectLedgerConsistent('两条发放路径各写一笔之后');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 这里原有三组用例，测的都是**站外账户微服务时代的机制**，随那台服务一起消失：
//
//   · 「fail-closed：远端失败 → 本地零痕迹」（AccountServiceError / 普通 Error /
//     AbortError 三种远端故障）—— 当年本地事务要先提交、再在事务外调远端，所以
//     必须证明远端失败时本地写入被补偿撤销。现在余额与流水同库同事务，
//     **没有「本地成了、远端没成」这个中间态可言**，那三种故障注入也就无处可注。
//     性质本身（失败不留半笔）仍然成立，且已被上面的用例直接覆盖：
//     余额不足 / 参数非法 / 并发失败 —— 每一条都断言了零痕迹 + 账目自洽。
//   · 「未配置账户服务 → 开发环境 fallback / 生产环境拒绝执行」—— 账户服务不在站外了，
//     没有「配不配置」这回事，也就没有 fail-open 的口子要堵。
//     顺带：当年那条「生产环境必须拒绝」的用例是**唯一**读 NODE_ENV 的测试夹具，
//     它删掉之后本文件不再需要 vi.stubEnv / vi.unstubAllEnvs。
//   · 「远端 transfer：系统账户 → 用户」「远端 transfer：用户 → 系统账户」——
//     系统账户（余额无限的那个户头）是远端那侧的账务概念；本地没有也不该有它的行，
//     所以「发从系统账户出、扣回系统账户」这件事在本地无从断言。
//     本地要钉的是流水 type 与方向，上面都钉了。
// ─────────────────────────────────────────────────────────────────────────────
