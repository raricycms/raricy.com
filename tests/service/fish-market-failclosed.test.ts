// fish-market-service —— 转账的 fail-closed 远端同步（第五条鱼干写路径）。
//
// 【为什么单独一个文件】需要 vi.mock 掉 account-client 才测得了「远端失败」，
// 而 fish-market-service.test.ts 跑的是真实模块 + dev fallback 的本地语义。
// 混在一起会互相干扰（mock 是全模块级的）。
//
// 【核心不变式】**远端失败 → 本地必须零痕迹**（对用户等价于回滚 + 503）。
// 最危险的失败模式是「本地已扣/已加鱼干但远端没记账」—— 两个账户的本地余额与
// 远端复式账本从此分叉，且完全静默。另外两个必须钉住的点：
//   · HTTP 调用在 SQLite 事务**外**（在事务里会占满写锁 → 并发写 database is locked）；
//   · 接收者已经把收到的鱼干花掉时，补偿**绝不部分撤销**（宁可 failed + 重放）。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。只 mock 远端账户服务的三个出口。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockEnabled, mockDecrypt, mockTransfer } = vi.hoisted(() => ({
  mockEnabled: vi.fn<() => boolean>(),
  mockDecrypt: vi.fn<() => string>(),
  mockTransfer: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/account-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-client')>();
  return {
    ...actual,
    accountServiceEnabled: mockEnabled,
    decryptApiKey: mockDecrypt,
    accountClient: { ...actual.accountClient, transfer: mockTransfer },
  };
});

import { transferFish } from '@/lib/fish-market-service';
import { AccountServiceError, makeClientIdempotencyKey } from '@/lib/account-client';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { nowForDb } from '@/lib/db-time';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  vi.clearAllMocks();
  mockEnabled.mockReturnValue(false); // 默认 dev fallback（同 tests/setup.ts 的真实环境）
  mockDecrypt.mockReturnValue('decrypted-api-key');
  mockTransfer.mockResolvedValue({ transaction_id: 'remote-1' });
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
  mockDecrypt.mockReturnValue('decrypted-api-key');
  mockTransfer.mockResolvedValue({ transaction_id: 'remote-1' });
}

/** 造一个带账户 Key 的用户（远端模式下发送者必须有 Key）。 */
async function makeUserWithKey(driedFish: number) {
  const u = await makeUser({ driedFish });
  await prisma.user.update({
    where: { id: u.id },
    data: { fishApiKeyEncrypted: 'fernet-blob-placeholder' },
  });
  return u;
}

/** 双方的全部本地痕迹 —— 用于断言「零痕迹」/「回原值」。 */
async function snapshot(senderId: string, recipientId: string) {
  const [sender, recipient, txCount, ledger] = await Promise.all([
    prisma.user.findUnique({ where: { id: senderId }, select: { driedFish: true } }),
    prisma.user.findUnique({ where: { id: recipientId }, select: { driedFish: true } }),
    prisma.fishTransaction.count(),
    prisma.accountSyncLedger.findMany({
      select: { idempotencyKey: true, operation: true, status: true, attempts: true },
    }),
  ]);
  return {
    sender: sender ? unitsToFish(sender.driedFish) : null,
    recipient: recipient ? unitsToFish(recipient.driedFish) : null,
    txCount,
    ledger,
  };
}

const balanceOf = async (id: string) =>
  unitsToFish(
    (await prisma.user.findUnique({ where: { id }, select: { driedFish: true } }))?.driedFish ?? 0
  );

/** 手动花掉接收者的余额（模拟「收到的钱已被转走 / 投喂掉」）。 */
async function spendAll(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { driedFish: 0 } });
}

/** 远端被调用时的入参（默认第 1 次调用）。 */
function transferArg(callIndex = 0) {
  const arg = mockTransfer.mock.calls[callIndex]?.[0] as {
    fromUserId: string;
    toUserId: string;
    amount: number;
    entryType: string;
    apiKey: string;
    description: string;
    idempotencyKey: string;
  };
  return arg;
}

// ── 远端正常 ────────────────────────────────────────────────────────────────

describe('远端正常：转账一次远端调用，参数与账本一致', () => {
  it('调用 transfer：发送者 → 接收者，entryType=transfer，键与账本行同一个', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferFish(sender.id, recipient.id, 7.5, '买鱼');

    expect(res.ok).toBe(true);
    expect(mockTransfer, '转账只该有一次远端调用（没有 feed 的两步退款结构）').toHaveBeenCalledTimes(1);

    const arg = transferArg();
    expect(arg.fromUserId).toBe(sender.id);
    expect(arg.toUserId).toBe(recipient.id);
    expect(arg.amount, '远端收的是鱼干业务单位，不是 0.1 单位').toBe(7.5);
    expect(arg.entryType).toBe('transfer');
    expect(arg.apiKey, '用发送者自己的 Key 扣款').toBe('decrypted-api-key');
    expect(arg.description).toContain(recipient.username);

    const ledger = await prisma.accountSyncLedger.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].operation).toBe('transfer');
    expect(ledger[0].status).toBe('synced');
    expect(ledger[0].idempotencyKey, '账本键 = 发往远端的键').toBe(arg.idempotencyKey);
    // 密钥绝不入账本（重放时按 userId 重新解密）
    expect(ledger[0].payload).not.toContain('decrypted-api-key');

    expect(await balanceOf(sender.id)).toBe(92.5);
    expect(await balanceOf(recipient.id)).toBe(7.5);
  });

  it('HTTP 在事务外：远端被调用时，本地写入与账本行**已经提交**（且账本仍是 pending）', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    let seen: { balance: number; ledgerStatus?: string } | null = null;
    mockTransfer.mockImplementation(async () => {
      // 用同一个 client 读库：若远端调用在事务内，这里读到的仍是**提交前**的状态
      // （余额未变、账本行不可见）。这条断言就是「HTTP 绝不进 SQLite 事务」的证据。
      const [u, rows] = await Promise.all([
        prisma.user.findUnique({ where: { id: sender.id }, select: { driedFish: true } }),
        prisma.accountSyncLedger.findMany(),
      ]);
      seen = { balance: unitsToFish(u?.driedFish ?? 0), ledgerStatus: rows[0]?.status };
      return {};
    });

    await transferFish(sender.id, recipient.id, 10);

    expect(seen).not.toBeNull();
    expect(seen!.balance, '远端调用时本地扣款已提交（写锁已释放）').toBe(90);
    expect(seen!.ledgerStatus, '账本行已提交且处于 pending').toBe('pending');
  });

  it('给接收者发一条「鱼干转账」通知（actor = 发送者）', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    await transferFish(sender.id, recipient.id, 3);

    const notes = await prisma.notification.findMany({ where: { recipientId: recipient.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].action).toBe('鱼干转账');
    expect(notes[0].actorId).toBe(sender.id);
    expect(notes[0].detail).toContain('3');
  });
});

// ── fail-closed：远端失败 → 零痕迹 ──────────────────────────────────────────

describe('远端失败 → 抛错且本地零痕迹', () => {
  it.each([
    // [场景, 造错, 期望 service 抛出的状态码]
    // 远端自己的状态码会被原样保留（与 feed / checkin 同款），路由层再统一映射成 503 ——
    // 所以这里断言的是「原样」，不是「一律 503」。
    ['远端 503', () => new AccountServiceError('账户服务不可达', 503), 503],
    ['远端 500', () => new AccountServiceError('账户服务内部错误', 500), 500],
    ['普通 Error（超时等被包成 503）', () => new Error('fetch timeout'), 503],
  ])('%s', async (_label, makeErr, expectedStatus) => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 5 });
    const before = await snapshot(sender.id, recipient.id);
    mockTransfer.mockRejectedValue(makeErr());

    const err = await transferFish(sender.id, recipient.id, 10).catch((e) => e);

    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as AccountServiceError).status).toBe(expectedStatus);

    const after = await snapshot(sender.id, recipient.id);
    expect(after.sender, '发送者余额必须回原值').toBe(before.sender);
    expect(after.recipient, '接收者余额必须回原值').toBe(before.recipient);
    expect(after.txCount, '两条流水都必须被删掉').toBe(0);
    expect(after.ledger, '账本行被删除 → 用户重试时可重建').toHaveLength(0);
  });

  it('失败后重试：拿到不同的键、恰好一次成交、账本 synced', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    mockTransfer.mockRejectedValueOnce(new AccountServiceError('账户服务不可达', 503));
    await expect(transferFish(sender.id, recipient.id, 10)).rejects.toBeInstanceOf(AccountServiceError);

    const firstKey = transferArg().idempotencyKey;
    mockTransfer.mockResolvedValue({ transaction_id: 'remote-2' });
    const res = await transferFish(sender.id, recipient.id, 10);
    expect(res.ok).toBe(true);

    expect(mockTransfer).toHaveBeenCalledTimes(2);
    expect(
      transferArg(1).idempotencyKey,
      '重试必须是新键（每次点击都是独立一笔，复用旧键会被远端静默去重）'
    ).not.toBe(firstKey);
    expect(await balanceOf(sender.id)).toBe(90);
    expect(await balanceOf(recipient.id)).toBe(10);
    expect(await prisma.fishTransaction.count()).toBe(2);
    const ledger = await prisma.accountSyncLedger.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('synced');
  });
});

// ── 客户端幂等键（站外脚本 / 收银台的「安全重试」）──────────────────────────
//
// 【为什么在这个文件里测】幂等去重靠的是**账本行**（唯一键 + payload 比对），
// 而账本只在远端同步启用时才登记 —— 所以这一节的用例必须让远端处于启用态。
// dev fallback 下的行为（不去重）在 fish-market-service.test.ts 里单独钉住。

describe('客户端幂等键', () => {
  it('★ 同键 + 同参数重发 → 不重复转账，返回 duplicated', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    const first = await transferFish(sender.id, recipient.id, 10, '订单 42', {
      clientIdempotencyKey: 'wd-0001',
    });
    expect(first.ok).toBe(true);

    const second = await transferFish(sender.id, recipient.id, 10, '订单 42', {
      clientIdempotencyKey: 'wd-0001',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicated, '第二次必须是「重放」而不是新转账').toBe(true);
    expect(second.balance, '余额 = 只扣了一次').toBe(90);
    // 重放回报的必须是**原单**的单号 —— 它是从同一个幂等键派生的，所以不需要
    // 额外存一份就能重现。付款方拿着这个号来对账，拿到的得是同一笔。
    expect(first.ok && second.transferId, '重放的单号必须与原单一致').toBe(
      first.ok ? first.transferId : ''
    );

    expect(mockTransfer, '远端只该被调用一次').toHaveBeenCalledTimes(1);
    expect(await balanceOf(sender.id)).toBe(90);
    expect(await balanceOf(recipient.id)).toBe(10);
    expect(await prisma.fishTransaction.count()).toBe(2);
    expect(await prisma.accountSyncLedger.count()).toBe(1);
  });

  it('同键 + 换了金额 / 收款人 / 留言 → 409，绝不静默改单', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const other = await makeUser({ driedFish: 0 });
    const recipient = await makeUser({ driedFish: 0 });

    const first = await transferFish(sender.id, recipient.id, 10, '订单 42', {
      clientIdempotencyKey: 'wd-0002',
    });
    expect(first.ok).toBe(true);

    const cases: [string, () => Promise<{ ok: boolean; code?: number }>][] = [
      ['金额不同', () => transferFish(sender.id, recipient.id, 11, '订单 42', { clientIdempotencyKey: 'wd-0002' })],
      ['收款人不同', () => transferFish(sender.id, other.id, 10, '订单 42', { clientIdempotencyKey: 'wd-0002' })],
      ['留言不同', () => transferFish(sender.id, recipient.id, 10, '订单 43', { clientIdempotencyKey: 'wd-0002' })],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      expect(res.ok, `${label}：必须拒绝`).toBe(false);
      expect(res.code, label).toBe(409);
    }

    expect(mockTransfer).toHaveBeenCalledTimes(1);
    expect(await balanceOf(sender.id)).toBe(90);
  });

  it('幂等键格式非法 → 400（长度 / 字符集）', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    for (const bad of ['has space', 'a'.repeat(49), '斜杠/不行', '']) {
      const res = await transferFish(sender.id, recipient.id, 10, null, {
        clientIdempotencyKey: bad,
      });
      // 空串 = 没给键 → 走随机键（正常转账）；其余非法 → 400
      if (bad === '') {
        expect(res.ok).toBe(true);
        continue;
      }
      expect(res.ok, `键「${bad}」应被拒`).toBe(false);
      if (!res.ok) expect(res.code).toBe(400);
    }
    expect(mockTransfer).toHaveBeenCalledTimes(1);
  });

  it('失败后用同一个键重试是安全的（补偿已释放该键）', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    mockTransfer.mockRejectedValueOnce(new AccountServiceError('账户服务不可达', 503));
    await expect(
      transferFish(sender.id, recipient.id, 10, null, { clientIdempotencyKey: 'wd-0003' })
    ).rejects.toBeInstanceOf(AccountServiceError);
    // 补偿成功后账本行被删（释放了幂等键），此时余额已回原值
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await prisma.accountSyncLedger.count()).toBe(0);

    mockTransfer.mockResolvedValue({ transaction_id: 'remote-ok' });
    const retry = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'wd-0003',
    });

    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.duplicated, '这仍是第一次成交，不是重放').toBeFalsy();
    expect(await balanceOf(sender.id)).toBe(90);
    expect(await prisma.fishTransaction.count()).toBe(2);
  });

  it('上一笔还没成交（pending）→ 409 提示用同一个键重试', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    // 手工造一个 pending 行（模拟「已提交、远端未回」或正在处理中）
    await prisma.accountSyncLedger.create({
      data: {
        idempotencyKey: makeClientIdempotencyKey(sender.id, 'wd-0004'),
        operation: 'transfer',
        payload: JSON.stringify({
          fromUserId: sender.id,
          toUserId: recipient.id,
          amount: 10,
          description: `转给「${recipient.username}」`,
        }),
        status: 'pending',
        createdAt: nowForDb(),
        updatedAt: nowForDb(),
      },
    });

    const res = await transferFish(sender.id, recipient.id, 10, null, {
      clientIdempotencyKey: 'wd-0004',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    expect(res.message).toContain('同一个键');
    expect(mockTransfer, 'pending 说明还没成交，绝不能再来一笔').not.toHaveBeenCalled();
    expect(await balanceOf(sender.id)).toBe(100);
  });

  it('不同用户用同一个客户端键互不影响（键里混了发送者哈希）', async () => {
    enableRemote();
    const a = await makeUserWithKey(100);
    const b = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    const ra = await transferFish(a.id, recipient.id, 5, null, { clientIdempotencyKey: 'order-1' });
    const rb = await transferFish(b.id, recipient.id, 5, null, { clientIdempotencyKey: 'order-1' });

    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok) expect(ra.duplicated).toBeFalsy();
    if (rb.ok) expect(rb.duplicated).toBeFalsy();
    expect(mockTransfer).toHaveBeenCalledTimes(2);
    expect(await balanceOf(a.id)).toBe(95);
    expect(await balanceOf(b.id)).toBe(95);
  });
});

// ── 补偿事务 ────────────────────────────────────────────────────────────────

describe('补偿事务', () => {
  it('接收者没花掉 → 补偿成功：双方余额回原值、流水清空、账本行删除', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 5 });
    mockTransfer.mockRejectedValue(new AccountServiceError('账户服务不可达', 503));

    await expect(transferFish(sender.id, recipient.id, 10)).rejects.toBeInstanceOf(AccountServiceError);

    expect(await balanceOf(sender.id)).toBe(100);
    expect(await balanceOf(recipient.id)).toBe(5);
    expect(await prisma.fishTransaction.count()).toBe(0);
    expect(await prisma.accountSyncLedger.count()).toBe(0);
    expect(await prisma.notification.count(), '补偿路径绝不发通知').toBe(0);
  });

  it('接收者已花掉 → 补偿整体回滚（绝不部分撤销）+ 账本 failed + 对账日志', async () => {
    enableRemote();
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });
    mockTransfer.mockImplementation(async () => {
      // 远端失败前，接收者已经把刚收到的 10 条花掉了（投喂 / 又转给了别人）
      await spendAll(recipient.id);
      throw new AccountServiceError('账户服务不可达', 503);
    });

    const err = await transferFish(sender.id, recipient.id, 10).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);

    // 【为什么发送者的钱没退回来】补偿事务是原子的：退接收者失败 → 整个补偿回滚。
    // 部分撤销（退了发送者、没扣接收者）会**凭空造出鱼干**，比暂时分叉更糟。
    // 正确出路是账本 failed + `fish sync-retry` 正向重放收敛。
    expect(await balanceOf(sender.id), '发送者仍被扣（补偿没能整体完成）').toBe(90);
    expect(await balanceOf(recipient.id), '接收者余额不为负').toBe(0);
    expect(await prisma.fishTransaction.count(), '流水保持（重放后即为正确终局）').toBe(2);

    const ledger = await prisma.accountSyncLedger.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].lastError).toBeTruthy();

    const errLog = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(errLog).toContain('ACCOUNT_RECONCILE_REQUIRED');
  });
});

// ── fail-fast 与档位 ────────────────────────────────────────────────────────

describe('配置与档位守卫', () => {
  it('远端模式下发送者没有账户 Key → 503，且零本地写入', async () => {
    enableRemote();
    const sender = await makeUser({ driedFish: 100 }); // 故意不写 fishApiKeyEncrypted
    const recipient = await makeUser({ driedFish: 0 });

    const err = await transferFish(sender.id, recipient.id, 10).catch((e) => e);

    expect(err).toBeInstanceOf(AccountServiceError);
    expect(mockTransfer, 'fail-fast：连远端都不该调用').not.toHaveBeenCalled();
    const snap = await snapshot(sender.id, recipient.id);
    expect(snap.sender).toBe(100);
    expect(snap.recipient).toBe(0);
    expect(snap.txCount).toBe(0);
    expect(snap.ledger).toHaveLength(0);
  });

  it('解密失败 → 503，且零本地写入', async () => {
    enableRemote();
    mockDecrypt.mockImplementation(() => {
      throw new AccountServiceError('用户账户 Key 解密失败', 503);
    });
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    const err = await transferFish(sender.id, recipient.id, 10).catch((e) => e);

    expect(err).toBeInstanceOf(AccountServiceError);
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('生产漏配 ACCOUNT_SERVICE → 503 且零本地写入（绝不 fail-OPEN）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockEnabled.mockReturnValue(false); // 漏配 = 未配置
    const sender = await makeUserWithKey(100);
    const recipient = await makeUser({ driedFish: 0 });

    const err = await transferFish(sender.id, recipient.id, 10).catch((e) => e);

    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as AccountServiceError).status).toBe(503);
    expect(await balanceOf(sender.id)).toBe(100);
    expect(await prisma.fishTransaction.count()).toBe(0);
  });

  it('dev fallback：只写本地、不登记账本、发送者没有 Key 也能转', async () => {
    mockEnabled.mockReturnValue(false);
    const sender = await makeUser({ driedFish: 100 }); // 无 Key 也应放行
    const recipient = await makeUser({ driedFish: 0 });

    const res = await transferFish(sender.id, recipient.id, 10);

    expect(res.ok).toBe(true);
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(await balanceOf(sender.id)).toBe(90);
    expect(await balanceOf(recipient.id)).toBe(10);
    expect(await prisma.fishTransaction.count()).toBe(2);
    expect(await prisma.accountSyncLedger.count(), 'dev fallback 不登记账本').toBe(0);
  });
});
