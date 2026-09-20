// fish-market-service.ts —— 鱼干市场转账的**本地语义**。
//
// 【这里没有替身可打】账目与业务数据现在在**同一个 SQLite 文件**里：扣款、两条流水、
// 幂等记录在**一个事务**里一起提交，因此不存在「本地已提交、账目还没记」的中间态，
// 也就不需要补偿事务（那套 outbox 随站外的账户微服务一起删掉了）。
// 本文件跑真实模块 + 真实库，覆盖：余额与流水的形态、入参校验、并发防超扣、限频、
// 收款人搜索，以及**客户端幂等键的对外契约**（同键重放 / 同键换参数 / 无键不登记）。
//
// 【钱对不对由不变式收口】每个跑过写路径的用例末尾都调 expectLedgerConsistent()。
// 账户搬进站内之后没有第二个存储可以核对了 ——「余额 == 流水之和、且没有负数余额」
// 这条内部一致性就是唯一的证明（见 tests/helpers/fish-ledger.ts）。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import {
  transferFish,
  searchTransferTargets,
  makeOrderKeyBase,
  ORDER_RE,
  TRANSFER_OUT_TYPE,
  TRANSFER_IN_TYPE,
  TRANSFER_NOTE_MAX,
} from '@/lib/fish-market-service';
import {
  CLIENT_KEY_RE,
  makeClientIdempotencyKey,
  makeTransferId,
  makeTransferIdempotencyKey,
} from '@/lib/fish-idempotency';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';

beforeEach(async () => {
  await resetDb();
  // 限频桶是**进程内** Map（不随 DB 清空）：不清的话，用例之间会互相吃额度，
  // 表现为「明明只转了几笔却 429」。
  __resetRateLimitStore();
  // 转账成功后会给收款人发一条通知，通知失败只 warn（不影响转账结果）——
  // 打桩免得偶发失败把测试输出刷满。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * 发送者 + 接收者的标准场景。
 *
 * 余额一律用 makeFishUser 造：它让余额**经由记账内核**进入（一条 admin_grant 流水），
 * 与线上同构 —— 而 expectLedgerConsistent 断的是「余额 == 该用户所有流水之和」，
 * 直接 `makeUser({ driedFish: N })` 塞出来的无来源余额在它眼里就是一条撕裂的账。
 */
async function scene(senderFish = 100, recipientFish = 0) {
  const sender = await makeFishUser(senderFish);
  const recipient = await makeFishUser(recipientFish);
  return { sender, recipient };
}

/**
 * 某用户的**转账**流水（正序）。
 *
 * 按 type 过滤而不是数该用户的全部流水：夹具给的初始余额也是一条流水
 *（makeFishUser 的 admin_grant），它不属于任何一次转账动作。
 */
async function txnsOf(userId: string) {
  return prisma.fishTransaction.findMany({
    where: { userId, type: { in: [TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE] } },
    orderBy: { id: 'asc' },
  });
}

/** 全库**转账**流水的条数（一出一进算两条）—— 夹具的初始余额那条不算。 */
const transferTxCount = () =>
  prisma.fishTransaction.count({
    where: { type: { in: [TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE] } },
  });

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

describe('transferFish —— 成功路径', () => {
  it('余额一增一减、两条流水成对、返回值带转账后余额', async () => {
    const { sender, recipient } = await scene(100, 5);

    const res = await transferFish(sender.id, recipient.id, 12.5);

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.amount).toBe(12.5);
    expect(res.balance, '发送者转账后余额').toBe(87.5);
    expect(res.recipient).toEqual({ id: recipient.id, username: recipient.username, frame_url: null });

    expect(await balanceOf(sender.id)).toBe(87.5);
    expect(await balanceOf(recipient.id)).toBe(17.5);

    const out = await txnsOf(sender.id);
    const inn = await txnsOf(recipient.id);
    expect(out).toHaveLength(1);
    expect(inn).toHaveLength(1);

    expect(out[0].amount, '支出为负（存储单位 = 0.1 鱼干）').toBe(-fishToUnits(12.5));
    expect(out[0].type).toBe(TRANSFER_OUT_TYPE);
    expect(out[0].relatedUserId).toBe(recipient.id);
    expect(out[0].description).toContain(recipient.username);

    expect(inn[0].amount).toBe(fishToUnits(12.5));
    expect(inn[0].type).toBe(TRANSFER_IN_TYPE);
    expect(inn[0].relatedUserId).toBe(sender.id);
    expect(inn[0].description).toContain(sender.username);

    // 两条流水金额之和恒为 0（钱只是换了口袋）
    expect(out[0].amount + inn[0].amount).toBe(0);

    // createdAt 必须被显式写入：schema 里没有 @default(now())，漏写就是 NULL，
    // 流水倒序会乱、按区间的统计会静默失效（静态守卫抓不到「忘了写」）。
    expect(out[0].createdAt).not.toBeNull();
    expect(inn[0].createdAt).not.toBeNull();

    await expectLedgerConsistent('转账 12.5 成功后');
  });

  it('最小额 0.0001 可转，且 0.1 这样的中间值也没问题（转账没有下限）', async () => {
    // 转账**没有** MIN_STAKE 那类下限（那是练手盘特有的），所以存储层的最小刻度
    // 就是能转的最小额。别把下限写成 1 —— 也别写成 0.1，那会跟着存储精度一起过期。
    const { sender, recipient } = await scene(1, 0);

    const res = await transferFish(sender.id, recipient.id, 0.0001);
    expect(res.ok).toBe(true);
    expect(await balanceOf(sender.id)).toBe(0.9999);
    expect(await balanceOf(recipient.id)).toBe(0.0001);

    const res2 = await transferFish(sender.id, recipient.id, 0.1);
    expect(res2.ok).toBe(true);
    expect(await balanceOf(recipient.id)).toBe(0.1001);

    await expectLedgerConsistent('转账最小额成功后');
  });

  it('留言同时进双方流水的描述', async () => {
    const { sender, recipient } = await scene(10, 0);

    const res = await transferFish(sender.id, recipient.id, 1, '  请你喝鱼汤  ');
    expect(res.ok).toBe(true);

    const [out] = await txnsOf(sender.id);
    const [inn] = await txnsOf(recipient.id);
    expect(out.description).toBe(`转给「${recipient.username}」：请你喝鱼汤`);
    expect(inn.description).toBe(`收到「${sender.username}」的转账：请你喝鱼汤`);

    await expectLedgerConsistent('带留言的转账成功后');
  });
});

describe('transferFish —— 共享单号 transfer_id', () => {
  it('两条流水带**同一个**非空单号（这是这一列存在的全部意义）', async () => {
    const { sender, recipient } = await scene(100, 0);
    const res = await transferFish(sender.id, recipient.id, 10);

    expect(res.ok).toBe(true);
    const [out] = await txnsOf(sender.id);
    const [inn] = await txnsOf(recipient.id);

    expect(out.transferId).toBeTruthy();
    expect(inn.transferId).toBe(out.transferId);
    // 返回值里的单号也必须与落库的一致 —— 它是收银台回执与 API 响应的来源
    expect(res.ok && res.transferId).toBe(out.transferId);

    await expectLedgerConsistent('转账后（校验共享单号）');
  });

  it('同键重放只成交一笔，且回报的是**原单**的单号', async () => {
    const { sender, recipient } = await scene(100, 0);

    // 单号由幂等键派生（不是随机 + 存一份），所以「重放同一个键回报同一个单号」
    // 是结构性成立的 —— 这里同时钉住派生值与重放回报值。
    const first = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'same-key-1',
    });
    const replay = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'same-key-1',
    });

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.duplicated, '第二次没有转账').toBe(true);

    const expectedId = makeTransferId(makeClientIdempotencyKey(sender.id, 'same-key-1'));
    expect(first.transferId).toBe(expectedId);
    expect(replay.transferId, '重放回报原单的单号，不是一个新值').toBe(expectedId);

    // 钱只动了一次：两条流水（一出一进），不是四条
    expect(await txnsOf(sender.id)).toHaveLength(1);
    expect(await txnsOf(recipient.id)).toHaveLength(1);
    expect(await balanceOf(sender.id)).toBe(90);

    await expectLedgerConsistent('同键重放后（只成交一笔）');
  });

  it('两笔不同的转账拿到不同的单号', async () => {
    const { sender, recipient } = await scene(100, 0);
    await transferFish(sender.id, recipient.id, 10);
    await transferFish(sender.id, recipient.id, 20);

    const rows = await txnsOf(sender.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].transferId).not.toBe(rows[1].transferId);

    await expectLedgerConsistent('两笔不同转账后');
  });

  it('单号是 16 位十六进制（口径写进用例，免得将来换实现时无声改变对外形状）', async () => {
    const { sender, recipient } = await scene(100, 0);
    await transferFish(sender.id, recipient.id, 10);
    const [row] = await txnsOf(sender.id);
    expect(row.transferId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('收银台 order 参数的幂等键基', () => {
  it('同一收款人 + 同一订单号 → 同一个键（刷新页面重付会被认成同一笔）', () => {
    expect(makeOrderKeyBase('u_a', 'order-1')).toBe(makeOrderKeyBase('u_a', 'order-1'));
  });

  it('★ 同一个付款人给**两家不同商户**用同一个订单号串 → 键必须不同', () => {
    // 不把收款人混进键的话，这里两条会相等 → 第二家商户直接 409、用户付不出去。
    expect(makeOrderKeyBase('u_merchant_a', 'order-1')).not.toBe(
      makeOrderKeyBase('u_merchant_b', 'order-1')
    );
  });

  it('最长订单号产出的键仍在 CLIENT_KEY_RE 的 48 字上限内', () => {
    const longest = 'a'.repeat(32);
    expect(ORDER_RE.test(longest)).toBe(true);
    const key = makeOrderKeyBase('u_merchant', longest);
    expect(CLIENT_KEY_RE.test(key), `键超长: ${key} (${key.length})`).toBe(true);
  });

  it('ORDER_RE 收下的任何值都产得出合法键（长度与字符集都不越界）', () => {
    for (const order of ['a', 'order-20260915-0007', '_._:.-', 'x'.repeat(32), 'ABC123']) {
      expect(ORDER_RE.test(order)).toBe(true);
      expect(CLIENT_KEY_RE.test(makeOrderKeyBase('u_m', order))).toBe(true);
    }
  });

  it('ORDER_RE 拒绝会破坏键的值：空格、斜杠、超长、非 ASCII', () => {
    for (const bad of ['has space', 'a/b', 'x'.repeat(33), '订单号', '', 'a\nb', 'a+b']) {
      expect(ORDER_RE.test(bad), `不该通过: ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('transferFish —— 入参校验（一律零副作用）', () => {
  it.each([
    ['0', 0],
    ['负数', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('金额 %s → 400，双方余额与流水都不动', async (_label, amount) => {
    const { sender, recipient } = await scene(100, 0);

    const res = await transferFish(sender.id, recipient.id, amount);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(400);
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await balanceOf(recipient.id)).toBe(0);
    expect(await txnsOf(sender.id)).toHaveLength(0);
  });

  it('超过 4 位小数（0.00005）→ 400，而**不是** 500（fishToUnits fail-loud 的边界转换）', async () => {
    const { sender, recipient } = await scene(100, 0);

    const res = await transferFish(sender.id, recipient.id, 0.00005);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code, '必须在 service 内转成 400 文案，否则冒泡成 500').toBe(400);
    expect(res.message).toContain('4 位小数');
    expect(await balanceOf(sender.id)).toBe(100);
  });

  it('0.05 现在**转得出去**了（旧粒度下它是 400 的那一档）', async () => {
    // 精度从 0.1 抬到 0.0001 的直接后果：原先被 fishToUnits 拒掉的 2 位小数成了合法输入。
    // 这是**有意的行为变更**，不是回归 —— 钉住它，免得下次有人按「0.05 该报 400」改回去。
    const { sender, recipient } = await scene(100, 0);

    const res = await transferFish(sender.id, recipient.id, 0.05);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await balanceOf(sender.id)).toBe(99.95);
    expect(await balanceOf(recipient.id)).toBe(0.05);
  });

  it('不能给自己转账 → 400', async () => {
    const { sender } = await scene(100, 0);

    const res = await transferFish(sender.id, sender.id, 1);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(400);
    expect(res.message).toContain('自己');
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await txnsOf(sender.id)).toHaveLength(0);
  });

  it('收款人不存在 → 404（且不产生任何写入）', async () => {
    const { sender } = await scene(100, 0);

    const res = await transferFish(sender.id, 'no-such-user', 1);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(404);
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await txnsOf(sender.id)).toHaveLength(0);
  });

  it('发送者不存在 → 404', async () => {
    const { recipient } = await scene(0, 0);
    const res = await transferFish('no-such-sender', recipient.id, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(404);
  });

  it(`留言超过 ${TRANSFER_NOTE_MAX} 字 → 400`, async () => {
    const { sender, recipient } = await scene(100, 0);

    const res = await transferFish(sender.id, recipient.id, 1, 'あ'.repeat(TRANSFER_NOTE_MAX + 1));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(400);
    expect(await txnsOf(sender.id)).toHaveLength(0);
  });

  it('余额不足 → 400，接收者分文不动', async () => {
    const { sender, recipient } = await scene(1, 0);

    const res = await transferFish(sender.id, recipient.id, 1.5);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(400);
    expect(res.message).toContain('不足');
    expect(await balanceOf(sender.id)).toBe(1);
    expect(await balanceOf(recipient.id)).toBe(0);

    // 出账走的条件写（`driedFish >= need`）：没扣成就不该留下任何流水 ——
    // 负数余额与「流水有、余额没动」都在这一条里。
    await expectLedgerConsistent('余额不足被拒后');
  });
});

describe('transferFish —— 并发', () => {
  it('并发两笔「转出全部」只成一笔，余额不为负', async () => {
    const { sender, recipient } = await scene(50, 0);

    const [a, b] = await Promise.all([
      transferFish(sender.id, recipient.id, 50),
      transferFish(sender.id, recipient.id, 50),
    ]);

    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount, 'SQLite 写锁 + 条件扣减：同一笔余额只能被花一次').toBe(1);
    expect(await balanceOf(sender.id)).toBe(0);
    expect(await balanceOf(recipient.id), '不能凭空多出鱼干').toBe(50);

    await expectLedgerConsistent('并发两笔转出全部后');
  });

  it('并发多笔小额：成功笔数 × 金额 ≤ 初始余额', async () => {
    const { sender, recipient } = await scene(10, 0);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => transferFish(sender.id, recipient.id, 3))
    );

    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(3); // 3 × 3 = 9 ≤ 10，第 4 笔起余额不足
    expect(await balanceOf(sender.id)).toBe(1);
    expect(await balanceOf(recipient.id)).toBe(9);

    await expectLedgerConsistent('并发多笔小额后');
  });
});

describe('transferFish —— 限频（唯一有配额的鱼干写路径）', () => {
  it(`超过小时配额（${RULES.transferHourly.limit}）→ 429，且不产生任何写入`, async () => {
    const { sender, recipient } = await scene(100, 0);
    const limit = RULES.transferHourly.limit;

    for (let i = 0; i < limit; i++) {
      const r = await transferFish(sender.id, recipient.id, 0.1);
      expect(r.ok, `第 ${i + 1} 笔应当成功`).toBe(true);
    }
    const balanceAfterQuota = await balanceOf(sender.id);
    const txCountAfterQuota = await transferTxCount();

    const res = await transferFish(sender.id, recipient.id, 0.1);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(429);
    expect(await balanceOf(sender.id)).toBe(balanceAfterQuota);
    expect(await transferTxCount()).toBe(txCountAfterQuota);

    await expectLedgerConsistent('打满小时配额后');
  });
});

// ── 客户端幂等键：**对外契约**（站外脚本超时后唯一的自救手段）────────────────
//
// 记录写在**业务写入的同一个事务**里，所以「钱动了但键没记」（同键重放变成第二笔
// 转账）与「键占了但钱没动」在结构上都不可能。新写入的行 status 恒为 'synced' ——
// 登记与转账同事务提交，提交成功就是已生效。

describe('客户端幂等键 —— 对外契约', () => {
  it('★ 同键 + 同参数重发 → 原结果 + duplicated，钱只动一次、账本一行', async () => {
    const { sender, recipient } = await scene(100, 0);

    const first = await transferFish(sender.id, recipient.id, 7, '货款', {
      clientIdempotencyKey: 'wd-0001',
    });
    const again = await transferFish(sender.id, recipient.id, 7, '货款', {
      clientIdempotencyKey: 'wd-0001',
    });

    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicated, '第二次必须如实回报「已成交」而不是再转一笔').toBe(true);
    expect(again.amount).toBe(7);
    expect(again.transferId).toBe(first.transferId);
    expect(await balanceOf(sender.id)).toBe(93);
    expect(await balanceOf(recipient.id)).toBe(7);

    // 账本：有且只有一行，键是派生的那个
    const rows = await prisma.accountSyncLedger.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(makeClientIdempotencyKey(sender.id, 'wd-0001'));
    expect(rows[0].operation).toBe('transfer');
    expect(rows[0].status, '与业务写入同事务提交 ⇒ 提交成功即已生效').toBe('synced');
    // payload 是「同键换参数」判定的依据，形状不能漂
    expect(JSON.parse(rows[0].payload)).toEqual({
      fromUserId: sender.id,
      toUserId: recipient.id,
      amount: 7,
      description: `转给「${recipient.username}」：货款`,
    });

    await expectLedgerConsistent('同键重放后（钱只动一次）');
  });

  it('★ 同键换参数（金额不同）→ 409，不静默改单、不产生第二笔', async () => {
    const { sender, recipient } = await scene(100, 0);

    const first = await transferFish(sender.id, recipient.id, 7, null, {
      clientIdempotencyKey: 'wd-0002',
    });
    expect(first.ok).toBe(true);

    const res = await transferFish(sender.id, recipient.id, 8, null, {
      clientIdempotencyKey: 'wd-0002',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    expect(await balanceOf(sender.id), '只有第一笔成交').toBe(93);
    expect(await txnsOf(sender.id)).toHaveLength(1);
    expect(await txnsOf(recipient.id)).toHaveLength(1);
    expect(await prisma.accountSyncLedger.count()).toBe(1);

    await expectLedgerConsistent('同键换参数被 409 拒后');
  });

  it('★ 同键换收款人 → 409（键跟着「这笔业务」走，不跟着「这次请求」走）', async () => {
    const { sender, recipient } = await scene(100, 0);
    const other = await makeUser({ driedFish: 0 });

    await transferFish(sender.id, recipient.id, 7, null, { clientIdempotencyKey: 'wd-0003' });
    const res = await transferFish(sender.id, other.id, 7, null, {
      clientIdempotencyKey: 'wd-0003',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    expect(await balanceOf(other.id)).toBe(0);

    await expectLedgerConsistent('同键换收款人被 409 拒后');
  });

  it('不带客户端键 → 随机键、**一行账本都不写**（判据：键是确定的才登记）', async () => {
    // 随机键每次都不一样，登记行没有任何去重价值，只会把表撑大、把「表里有什么」
    // 这件事搅浑。判据与理由见 src/lib/fish-idempotency.ts 头部。
    const { sender, recipient } = await scene(100, 0);

    const a = await transferFish(sender.id, recipient.id, 5);
    const b = await transferFish(sender.id, recipient.id, 5);

    expect(a.ok && b.ok).toBe(true);
    // 「不带键 ⇒ 重试就是再转一笔」：两笔都真的成交了
    expect(await balanceOf(sender.id)).toBe(90);
    expect(await txnsOf(sender.id)).toHaveLength(2);
    expect(await txnsOf(recipient.id)).toHaveLength(2);
    expect(await prisma.accountSyncLedger.count(), '随机键不登记').toBe(0);

    await expectLedgerConsistent('两笔无键转账后');
  });

  it('★ 遗留 status=pending 的行 → 409（绝不把「不确定」当已成交回报）', async () => {
    // 新写入的行一律是 synced，所以这个分支只为**迁移前的遗留行**服务（当年记录会停在
    // pending：本地已提交、远端没同步）。对它们的正确动作是人工查证，
    // 绝不是回一句「转账成功」—— 那会让调用方以为自己那笔已经落地。
    const { sender, recipient } = await scene(100, 0);
    const clientKey = 'wd-legacy-1';
    const description = `转给「${recipient.username}」`;
    const now = nowForDb();
    await prisma.accountSyncLedger.create({
      data: {
        idempotencyKey: makeClientIdempotencyKey(sender.id, clientKey),
        operation: 'transfer',
        // payload 与本笔请求**完全一致** —— 只有状态是遗留的，这样才测得到那条分支
        payload: JSON.stringify({
          fromUserId: sender.id,
          toUserId: recipient.id,
          amount: 5,
          description,
        }),
        status: 'pending',
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      },
    });

    const res = await transferFish(sender.id, recipient.id, 5, null, {
      clientIdempotencyKey: clientKey,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    // 走的是「状态不是 synced」那条分支（payload 与本笔完全一致 ⇒ 不是参数不一致那条，
    // 否则这条用例会因为错误的原因通过）
    expect(res.message).toContain('状态异常');
    expect(await balanceOf(sender.id), '钱一分不动').toBe(100);
    expect(await txnsOf(sender.id)).toHaveLength(0);
    expect(await prisma.accountSyncLedger.count(), '不新增行、也不改动遗留行').toBe(1);

    await expectLedgerConsistent('遗留 pending 行被 409 拒后');
  });

  it('重放不消耗限频额度（否则超时重试会被自己的配额挡在门外）', async () => {
    const { sender, recipient } = await scene(100, 0);
    const first = await transferFish(sender.id, recipient.id, 0.1, null, {
      clientIdempotencyKey: 'wd-0004',
    });
    expect(first.ok).toBe(true);

    // 打满小时配额（上面那笔已经占了 1 次）
    for (let i = 0; i < RULES.transferHourly.limit - 1; i++) {
      const r = await transferFish(sender.id, recipient.id, 0.1);
      expect(r.ok, `第 ${i + 2} 笔应当成功`).toBe(true);
    }
    // 新的一笔已经被挡住……
    const blocked = await transferFish(sender.id, recipient.id, 0.1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(429);

    // ……但**同一笔的重放**照样能拿到原结果：幂等判定在限频之前。
    const replay = await transferFish(sender.id, recipient.id, 0.1, null, {
      clientIdempotencyKey: 'wd-0004',
    });
    expect(replay.ok, '调用方遇到超时就该能用同键重试').toBe(true);
    if (replay.ok) expect(replay.duplicated).toBe(true);

    await expectLedgerConsistent('打满配额后重放');
  });
});

describe('服务账号配额白名单', () => {
  it('白名单账号可以超过普通账号的小时上限（30 → 500）', async () => {
    const { sender, recipient } = await scene(100, 0);
    vi.stubEnv('FISH_SERVICE_ACCOUNTS', sender.id);

    // 普通账号在 30 笔后会 429（上面那条用例钉着），白名单账号这里转 35 笔应当全过
    for (let i = 0; i < 35; i++) {
      const r = await transferFish(sender.id, recipient.id, 0.1);
      expect(r.ok, `第 ${i + 1} 笔：白名单账号不该撞普通配额`).toBe(true);
    }
    expect(await balanceOf(recipient.id)).toBe(3.5);

    await expectLedgerConsistent('服务账号转 35 笔后');
  });

  it('白名单之外的账号不受影响（同一进程内仍按 30 笔/时 限）', async () => {
    const { sender, recipient } = await scene(100, 0);
    const other = await makeUser({ driedFish: 100 });
    vi.stubEnv('FISH_SERVICE_ACCOUNTS', other.id);

    for (let i = 0; i < RULES.transferHourly.limit; i++) {
      await transferFish(sender.id, recipient.id, 0.1);
    }
    const blocked = await transferFish(sender.id, recipient.id, 0.1);

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(429);
  });

  it('config 里的空白与空项被忽略（`a, , b` 不会把空串当成账号）', async () => {
    const { sender, recipient } = await scene(100, 0);
    vi.stubEnv('FISH_SERVICE_ACCOUNTS', ` , ${sender.id} , `);

    for (let i = 0; i < 32; i++) {
      const r = await transferFish(sender.id, recipient.id, 0.1);
      expect(r.ok, `第 ${i + 1} 笔`).toBe(true);
    }
  });
});

describe('searchTransferTargets', () => {
  it('按用户名包含匹配、排除自己、返回总数', async () => {
    const me = await makeUser({ username: 'fan_qie' });
    const a = await makeUser({ username: 'fan_qie_friend' });
    await makeUser({ username: 'other' });

    const { users, total } = await searchTransferTargets('fan_qie', me.id);

    expect(users.map((u) => u.id).sort()).toEqual([a.id]);
    expect(total).toBe(1);
  });

  it('空查询返回最近注册的一批（含任意角色，不限 core+）', async () => {
    const me = await makeUser({ username: 'me_self' });
    const plain = await makeUser({ username: 'plain_user', role: 'user' });
    const core = await makeUser({ username: 'core_user', role: 'core' });

    const { users, total } = await searchTransferTargets('', me.id, 50, 0);

    expect(total).toBe(2);
    expect(users.map((u) => u.id).sort()).toEqual([plain.id, core.id].sort());
    expect(users.map((u) => u.id)).not.toContain(me.id);
  });

  it('分页：limit/offset 生效，total 是全量', async () => {
    const me = await makeUser({ username: 'pager_me' });
    for (let i = 0; i < 5; i++) await makeUser({ username: `pager_${i}` });

    const page1 = await searchTransferTargets('pager', me.id, 2, 0);
    const page2 = await searchTransferTargets('pager', me.id, 2, 2);

    expect(page1.total).toBe(5);
    expect(page1.users).toHaveLength(2);
    expect(page2.users).toHaveLength(2);
    expect(page1.users.map((u) => u.id)).not.toEqual(page2.users.map((u) => u.id));
  });
});

describe('makeTransferIdempotencyKey', () => {
  it('长度 ≤ 64（用最长的合法输入：两个 36 字符 UUID）', () => {
    // 键的形状是**冻结**的：存量 account_sync_ledger 行与对外文档都照着它，
    // 换一代形状等于让老键与新键混进同一个命名空间。
    const key = makeTransferIdempotencyKey(
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174001',
      fishToUnits(999999.9),
      'deadbeef'
    );
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('同参数 + 同 nonce 是确定性的', () => {
    const args = ['u-1', 'u-2', 100, 'aaaa1111'] as const;
    expect(makeTransferIdempotencyKey(...args)).toBe(makeTransferIdempotencyKey(...args));
  });

  it('nonce 不同 → 键不同 ⇒ 两笔同额转账各有自己的单号', () => {
    // 秒级时间戳下不带 nonce，同一用户对同额的两次转账会算出同一个键 ⇒ 同一个单号，
    // 而单号是对账时认「同一笔」的唯一依据 —— 两笔真成交的转账共用一个句柄，
    // 收付双方就再也分不开它们了。
    const a = makeTransferIdempotencyKey('u-1', 'u-2', 100, 'aaaa1111');
    const b = makeTransferIdempotencyKey('u-1', 'u-2', 100, 'bbbb2222');
    expect(a).not.toBe(b);
    expect(makeTransferId(a)).not.toBe(makeTransferId(b));
  });
});
