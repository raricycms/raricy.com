// fish-ledger.ts（测试助手）自身的测试。
//
// 【为什么「测助手的测试」在这里是必需的】
// 账户服务搬进站内之后，`users.driedFish` 是**唯一**的真源 —— 没有第二个存储可以核对。
// 那条不变式（每人余额 == 他所有流水之和）成了账目正确性的**全部**证据，于是它被
// 几十个用例调用。**如果助手本身有 bug（比如恒返回空数组），那几十个用例会一起静默
// 变成空转** —— 一片绿，而什么都没验。
//
// 这个文件的职责就是钉住「助手真的抓得住撕裂」：手工把余额改坏，断言它报错。
// 没有这几条，`expectLedgerConsistent` 与一行 `expect(true).toBe(true)` 无从区分。
//
// 【别用真实写路径来构造撕裂】它们是原子的，构造不出来。这里**故意**绕过
// postEntry 直接改 users.driedFish —— 正是要模拟「将来有人绕过记账内核」这一幕。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  auditLedger,
  expectLedgerConsistent,
  makeFishUser,
} from '../helpers/fish-ledger';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { postEntry, addFish } from '@/lib/fish-service';

beforeEach(async () => {
  await resetDb();
  // 助手失败时会打很长的说明，这里要断言「它抛了」，不需要把说明刷到屏幕上。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** 直接改余额、不写流水（模拟「将来有人绕过记账内核」）。 */
async function corruptBalance(userId: string, units: number) {
  await prisma.user.update({ where: { id: userId }, data: { driedFish: units } });
}

describe('makeFishUser：让余额有来源', () => {
  it('造出来的用户余额与流水一致（这是它能跑绝对不变式的原因）', async () => {
    const u = await makeFishUser(100);

    const rows = await prisma.fishTransaction.findMany({ where: { userId: u.id } });
    expect(rows, '余额必须有一条配套流水').toHaveLength(1);
    expect(rows[0].amount).toBe(fishToUnits(100));

    await expectLedgerConsistent('makeFishUser 造出来之后');
  });

  it('amount = 0 时不留流水（没来源问题，因为余额本来就是 0）', async () => {
    const u = await makeFishUser(0);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(0);
    await expectLedgerConsistent('makeFishUser(0)');
  });

  it('opts 能透传给 makeUser（用户名、角色等）', async () => {
    const u = await makeFishUser(5, { username: '带名字的用户', role: 'core' });
    expect(u.username).toBe('带名字的用户');
    expect(u.role).toBe('core');
    await expectLedgerConsistent('带 opts 的 makeFishUser');
  });

  it('★ makeUser({driedFish: N}) 造的是「无来源的余额」，助手必须报出来', async () => {
    // 这条同时是**文档**：它把「为什么不能这么造夹具」钉成了可执行的断言。
    // 谁哪天图省事把夹具改回 makeUser，就会看到这条与其它用例一起红。
    const u = await makeUser({ driedFish: 42 });

    const r = await auditLedger();
    expect(r.mismatches, '无来源的余额必须被报出来').toHaveLength(1);
    expect(r.mismatches[0].balance).toBe(fishToUnits(42));
    expect(r.mismatches[0].ledgerSum).toBe(0);

    await expect(expectLedgerConsistent('直接塞 driedFish 的夹具')).rejects.toThrow(/账目撕裂/);
  });
});

describe('助手在账目自洽时保持安静', () => {
  it('空库：没有用户也没有流水', async () => {
    const r = await auditLedger();
    expect(r.mismatches).toEqual([]);
    expect(r.negatives).toEqual([]);
    expect(r.userCount).toBe(0);
    expect(r.txCount).toBe(0);
    await expectLedgerConsistent('空库');
  });

  it('走真实内核写过账之后仍然自洽（余额与流水是同一次写入的两面）', async () => {
    const u = await makeFishUser(10);
    await prisma.$transaction((tx) =>
      postEntry(tx, { userId: u.id, units: -fishToUnits(3), type: 'admin_deduct' })
    );
    await prisma.$transaction((tx) =>
      addFish(tx, { userId: u.id, amount: 1.5, type: 'checkin' })
    );

    const r = await auditLedger();
    expect(r.userCount).toBe(1);
    expect(r.txCount).toBe(3); // 夹具那条 + 扣 3 + 加 1.5
    expect(r.mismatches).toEqual([]);
    await expectLedgerConsistent('扣 3 又加 1.5 之后');
  });

  it('余额为 0 且没有任何流水（注册默认值）不算撕裂', async () => {
    await makeUser({ driedFish: 0 });
    await expectLedgerConsistent('全新用户');
  });
});

describe('★ 助手真的抓得住撕裂（没有这几条，它就是空转的）', () => {
  it('余额被改高而流水没跟上 → 报差值为正', async () => {
    const u = await makeFishUser(5);

    await corruptBalance(u.id, fishToUnits(15));

    const r = await auditLedger();
    expect(r.mismatches, '必须报出一条撕裂').toHaveLength(1);
    expect(r.mismatches[0].userId).toBe(u.id);
    expect(r.mismatches[0].balance).toBe(fishToUnits(15));
    expect(r.mismatches[0].ledgerSum).toBe(fishToUnits(5));
    expect(r.mismatches[0].diff).toBe(fishToUnits(10));

    await expect(expectLedgerConsistent('故意改坏余额')).rejects.toThrow(/账目撕裂/);
  });

  it('流水写了而余额没动 → 差值为负（两个方向都要抓）', async () => {
    const u = await makeUser({ driedFish: 0 });
    // 只插流水、不碰余额（正是 postEntry 里「改了余额但漏写流水」的镜像）。
    await prisma.fishTransaction.create({
      data: {
        userId: u.id,
        amount: fishToUnits(7),
        type: 'admin_grant',
        createdAt: new Date(),
      },
    });

    const r = await auditLedger();
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].diff).toBe(-fishToUnits(7));
    await expect(expectLedgerConsistent('只写流水没动余额')).rejects.toThrow(/账目撕裂/);
  });

  it('负数余额被单独报出来（出账谓词失效的唯一征兆）', async () => {
    const u = await makeFishUser(1);
    // 余额与流水**自洽**（流水也改成 -5 鱼干），所以 mismatches 是空的 ——
    // 它只能靠 negatives 这一组抓。这两组查的是不同的东西，不能合并。
    await prisma.fishTransaction.updateMany({
      where: { userId: u.id },
      data: { amount: -fishToUnits(5) },
    });
    await corruptBalance(u.id, -fishToUnits(5));

    const r = await auditLedger();
    expect(r.mismatches, '余额与流水对得上，所以这里不该报').toEqual([]);
    expect(r.negatives, '但余额是负的，必须报').toHaveLength(1);
    expect(r.negatives[0].balance).toBe(-fishToUnits(5));

    await expect(expectLedgerConsistent('负余额')).rejects.toThrow(/负数余额/);
  });

  it('多个用户只报坏的那一个（别把好的也一起报出来）', async () => {
    const good = await makeFishUser(3);
    const bad = await makeFishUser(3);
    await corruptBalance(bad.id, fishToUnits(9));

    const r = await auditLedger();
    expect(r.mismatches.map((m) => m.userId)).toEqual([bad.id]);
    expect(r.userCount, '两个用户都在扫描范围内（不是把好的筛掉了）').toBe(2);
    // 注意要重读：makeFishUser 的返回值是**建行那一刻**的对象，postEntry 在那之后发生。
    const reread = await prisma.user.findUniqueOrThrow({ where: { id: good.id } });
    expect(reread.driedFish).toBe(fishToUnits(3));
  });
});

describe('报错信息要能直接定位（出问题时不该还要二分排查）', () => {
  it('带去重的场景描述、用户名、三个数字', async () => {
    const u = await makeFishUser(2, { username: '账目坏掉的家伙' });
    await corruptBalance(u.id, fishToUnits(9.9));

    await expect(expectLedgerConsistent('转账成功后')).rejects.toThrow(/转账成功后/);
    await expect(expectLedgerConsistent()).rejects.toThrow(new RegExp(u.username));
    // 数字按**鱼干**显示（存储单位会大 10 倍，读的人会以为差了一个量级）
    await expect(expectLedgerConsistent()).rejects.toThrow(/余额=9\.9 流水和=2 差=7\.9/);
  });

  it('没给场景描述时也不崩（context 是可选的）', async () => {
    const u = await makeFishUser(1);
    await corruptBalance(u.id, 0);
    // 断言它报的是撕裂，而不是「TypeError: context is undefined」
    await expect(expectLedgerConsistent()).rejects.toThrow(/账目撕裂/);
  });

  it('报错里点名提示「是不是夹具直接塞了 driedFish」', async () => {
    await makeUser({ driedFish: 7 });
    await expect(expectLedgerConsistent()).rejects.toThrow(/makeFishUser/);
  });
});
