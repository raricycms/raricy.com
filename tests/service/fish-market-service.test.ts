// fish-market-service.ts —— 鱼干市场转账的**本地语义**（dev fallback 分支）。
//
// 【与 fish-market-failclosed.test.ts 的分工】那边 mock 掉 account-client，专测
// fail-closed（远端失败零痕迹 / 补偿 / 账本）；本文件跑**真实模块 + dev fallback**：
// 余额、两条流水的形态、入参校验、并发防超扣、限频、收款人搜索 —— 这些与远端无关。
// 混在一个文件里会互相干扰（mock 是全模块级的）。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。远端账户服务未配置
// （tests/setup.ts 把 ACCOUNT_SERVICE_INTERNAL_TOKEN 置空）→ accountServiceEnabled() 恒 false。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  transferFish,
  searchTransferTargets,
  makeOrderKeyBase,
  ORDER_RE,
  TRANSFER_OUT_TYPE,
  TRANSFER_IN_TYPE,
  TRANSFER_NOTE_MAX,
} from '@/lib/fish-market-service';
import { CLIENT_KEY_RE } from '@/lib/fish-idempotency';
import { makeTransferIdempotencyKey } from '@/lib/account-client';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { __resetRateLimitStore, RULES } from '@/lib/rate-limit';

beforeEach(async () => {
  await resetDb();
  // 限频桶是**进程内** Map（不随 DB 清空）：不清的话，用例之间会互相吃额度，
  // 表现为「明明只转了几笔却 429」。
  __resetRateLimitStore();
  // dev fallback 每次转账都会 warn 一行，别刷测试输出
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 发送者 + 接收者的标准场景。 */
async function scene(senderFish = 100, recipientFish = 0) {
  const sender = await makeUser({ driedFish: senderFish });
  const recipient = await makeUser({ driedFish: recipientFish });
  return { sender, recipient };
}

/** 某用户的鱼干流水（正序）。 */
async function txnsOf(userId: string) {
  return prisma.fishTransaction.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

describe('transferFish —— 成功路径（dev fallback）', () => {
  it('余额一增一减、两条流水成对、返回值带转账后余额', async () => {
    const { sender, recipient } = await scene(100, 5);

    const res = await transferFish(sender.id, recipient.id, 12.5);

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.amount).toBe(12.5);
    expect(res.balance, '发送者转账后余额').toBe(87.5);
    expect(res.recipient).toEqual({ id: recipient.id, username: recipient.username });

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
  });

  it('最小额 0.1 可转（1 位小数是允许的，别把下限写成 1）', async () => {
    const { sender, recipient } = await scene(1, 0);

    const res = await transferFish(sender.id, recipient.id, 0.1);

    expect(res.ok).toBe(true);
    expect(await balanceOf(sender.id)).toBe(0.9);
    expect(await balanceOf(recipient.id)).toBe(0.1);
  });

  it('留言同时进双方流水的描述', async () => {
    const { sender, recipient } = await scene(10, 0);

    const res = await transferFish(sender.id, recipient.id, 1, '  请你喝鱼汤  ');
    expect(res.ok).toBe(true);

    const [out] = await txnsOf(sender.id);
    const [inn] = await txnsOf(recipient.id);
    expect(out.description).toBe(`转给「${recipient.username}」：请你喝鱼汤`);
    expect(inn.description).toBe(`收到「${sender.username}」的转账：请你喝鱼汤`);
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
  });

  it('本笔的单号 = sha256(幂等键) 前 16 位（重放能重现同一个值，靠的就是这个）', async () => {
    const { sender, recipient } = await scene(100, 0);

    // dev fallback 不去重，所以同键会真的成交两笔 —— 但两笔的键相同 ⇒ 单号必然相同。
    // 这正是「派生而非随机」的可观测后果：重放同一个键回报的一定是原单的单号。
    await transferFish(sender.id, recipient.id, 10, null, { clientIdempotencyKey: 'same-key-1' });
    await transferFish(sender.id, recipient.id, 10, null, { clientIdempotencyKey: 'same-key-1' });

    const rows = await txnsOf(sender.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].transferId).toBe(rows[1].transferId);
  });

  it('两笔不同的转账拿到不同的单号', async () => {
    const { sender, recipient } = await scene(100, 0);
    await transferFish(sender.id, recipient.id, 10);
    await transferFish(sender.id, recipient.id, 20);

    const rows = await txnsOf(sender.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].transferId).not.toBe(rows[1].transferId);
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

  it('超过 1 位小数（0.05）→ 400，而**不是** 503（fishToUnits fail-loud 的边界转换）', async () => {
    const { sender, recipient } = await scene(100, 0);

    const res = await transferFish(sender.id, recipient.id, 0.05);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code, '必须在 service 内转成 400 文案，否则冒泡成 503').toBe(400);
    expect(res.message).toContain('1 位小数');
    expect(await balanceOf(sender.id)).toBe(100);
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
    expect(await prisma.fishTransaction.count()).toBe(0);
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
    const txCountAfterQuota = await prisma.fishTransaction.count();

    const res = await transferFish(sender.id, recipient.id, 0.1);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(429);
    expect(await balanceOf(sender.id)).toBe(balanceAfterQuota);
    expect(await prisma.fishTransaction.count()).toBe(txCountAfterQuota);
  });
});

describe('客户端幂等键（dev fallback 下的已知边界）', () => {
  it('dev fallback **不去重**：没有账本行可查，同键两笔都会成交', async () => {
    // 【为什么断言这个「坏」行为】幂等去重靠账本行（唯一键 + payload 比对），
    // 而账本只在远端同步启用时登记（dev fallback 刻意不登记，免得积一堆永远
    // 同步不出去的 pending）。所以这条限制必须**写在用例里**，而不是让人
    // 在本地测试时踩到「幂等键不生效」却查不出原因。
    // 生产不会出现这个状态：未配账户服务时 assertRemoteRequiredInProduction
    // 直接 503，fail-closed（见 fish-market-failclosed.test.ts 的 prod 守卫用例）。
    const { sender, recipient } = await scene(100, 0);

    const a = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'wd-dev-1',
    });
    const b = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'wd-dev-1',
    });

    expect(a.ok && b.ok).toBe(true);
    expect(await balanceOf(sender.id)).toBe(80);
    expect(await prisma.accountSyncLedger.count(), 'dev fallback 不登记账本').toBe(0);
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
    const key = makeTransferIdempotencyKey(
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174001',
      fishToUnits(999999.9),
      'deadbeef'
    );
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('同参数 + 同 nonce 是确定性的（重放要用同一个键）', () => {
    const args = ['u-1', 'u-2', 100, 'aaaa1111'] as const;
    expect(makeTransferIdempotencyKey(...args)).toBe(makeTransferIdempotencyKey(...args));
  });

  it('nonce 不同 → 键不同（两笔同额转账不能被远端当重放静默吞掉）', () => {
    const a = makeTransferIdempotencyKey('u-1', 'u-2', 100, 'aaaa1111');
    const b = makeTransferIdempotencyKey('u-1', 'u-2', 100, 'bbbb2222');
    expect(a).not.toBe(b);
  });
});
