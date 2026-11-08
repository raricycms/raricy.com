// fish-webhook-service.ts —— 收款回调的 outbox、投递与重试。
//
// 【为什么要起一个真 HTTP 接收端】签名 header、正文形状、超时行为这些东西，
// mock 掉 postWebhook 就全测不到了 —— 而那正是商户要照着实现的部分。
// 接收端起在 127.0.0.1 上，投递时带 allowPrivate（**仅供测试**的开关，
// 生产调用方不传，见 fish-webhook-service.deliverWebhook 的签名）。
//
// 【与转账的接口在哪】转账成功路径在**同一个事务**里写两条流水 + 一条 outbox 行
//（src/lib/fish-transfer-service.ts:408-421），本文件钉「投递行随调用方事务回滚」与
// 回调自身的生命周期；「真实转账会写出 outbox 行」的断言在
// tests/service/fish-market-service.test.ts 的带回调地址用例里。
// （本文件头原先指向的 fish-market-failclosed.test.ts 并不存在 —— R3-318。）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  signWebhook,
  enqueueTransferWebhook,
  deliverWebhook,
  drainWebhookDeliveries,
  upsertWebhookEndpoint,
  rotateWebhookSecret,
  disableWebhookEndpoint,
  getWebhookEndpoint,
  listRecentDeliveries,
  WEBHOOK_EVENT_TRANSFER_RECEIVED,
  WEBHOOK_MAX_ATTEMPTS,
  inspectWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  rekeyWebhookSecrets,
} from '@/lib/fish-webhook-service';
import { openSecret, sealSecret } from '@/lib/secret-box';
import { nowForDb } from '@/lib/db-time';
import { createHmac } from 'node:crypto';

process.env.FISH_ENCRYPTION_KEY = 'webhook-test-key';

/** 一个可编程的接收端：记下每次请求的 header 与正文，按 statusQueue 顺序回状态码。 */
interface Receiver {
  url: string;
  hits: { headers: http.IncomingHttpHeaders; body: string }[];
  statusQueue: number[];
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const hits: Receiver['hits'] = [];
  const statusQueue: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      const status = statusQueue.shift() ?? 200;
      res.writeHead(status).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/fish/callback`,
    hits,
    statusQueue,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let receiver: Receiver | null = null;
afterEach(async () => {
  if (receiver) await receiver.close();
  receiver = null;
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** 登记一个指向本地接收端的地址（带测试开关）。 */
async function registerReceiver(userId: string): Promise<string> {
  receiver = await startReceiver();
  const res = await upsertWebhookEndpoint(userId, receiver.url, { allowPrivate: true });
  if (!res.ok) throw new Error(`登记失败: ${res.message}`);
  return res.secret ?? '';
}

/** 在事务里写一条投递行（模拟转账 Phase 1 的 1.5 步）。 */
async function enqueue(userId: string, transferId = 'tid-1') {
  const sender = await makeUser();
  return prisma.$transaction((tx) =>
    enqueueTransferWebhook({
      tx,
      recipientId: userId,
      recipientUsername: 'merchant',
      senderId: sender.id,
      senderUsername: sender.username,
      amount: 1.5,
      note: 'order-1',
      transferId,
      balanceAfter: 42.5,
    })
  );
}

describe('签名', () => {
  it('★ 已知向量：签的是 `${timestamp}.${body}`；时间戳或密钥任一变化签名就不同', () => {
    // 硬编码的期望值 —— 改了签名方案这里就红。商户那边照这个实现才能对上。
    const sig = signWebhook('topsecret', 1700000000, '{"a":1}');
    const expected = createHmac('sha256', 'topsecret')
      .update('1700000000.{"a":1}')
      .digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhook('topsecret', 1700000001, '{"a":1}'), '时间戳挡住重放').not.toBe(sig);
    expect(signWebhook('other', 1700000000, '{"a":1}'), '密钥是商户身份的根').not.toBe(sig);
  });
});

describe('地址配置', () => {
  it('首次登记返回密钥，且密钥**加密落库**（不是明文）', async () => {
    const u = await makeUser();
    receiver = await startReceiver();
    const res = await upsertWebhookEndpoint(u.id, receiver.url, { allowPrivate: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const row = await prisma.fishWebhookEndpoint.findUniqueOrThrow({ where: { userId: u.id } });
    expect(row.secretEncrypted).not.toContain(res.secret!);
    expect(openSecret(row.secretEncrypted, 'webhook-test-key')).toBe(res.secret);
  });

  it('改地址**不换密钥**（否则商户写好的验签代码会突然失效）', async () => {
    const u = await makeUser();
    const secret = await registerReceiver(u.id);
    const again = await upsertWebhookEndpoint(u.id, receiver!.url, { allowPrivate: true });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.secret).toBeNull();

    const row = await prisma.fishWebhookEndpoint.findUniqueOrThrow({ where: { userId: u.id } });
    expect(openSecret(row.secretEncrypted, 'webhook-test-key')).toBe(secret);
  });

  it('★ 私网地址在登记时就被拒（不落库）—— 含映射 IPv6 形态', async () => {
    const hosts = [
      '169.254.169.254',
      '[::ffff:127.0.0.1]',
      '[::ffff:a00:1]',
      '[0:0:0:0:0:ffff:a9fe:a9fe]',
    ];
    for (const host of hosts) {
      const u = await makeUser();
      const res = await upsertWebhookEndpoint(u.id, `https://${host}/cb`);
      expect(res.ok, host).toBe(false);
      if (res.ok) continue;
      expect(res.message).toContain('内网');
    }
    expect(await prisma.fishWebhookEndpoint.count(), '一个都不该落库').toBe(0);
  });

  it('换密钥后旧密钥立刻失效', async () => {
    const u = await makeUser();
    const old = await registerReceiver(u.id);
    const rotated = await rotateWebhookSecret(u.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.secret).not.toBe(old);

    const row = await prisma.fishWebhookEndpoint.findUniqueOrThrow({ where: { userId: u.id } });
    expect(openSecret(row.secretEncrypted, 'webhook-test-key')).toBe(rotated.secret);
  });

  it('停用是软停：置 disabledAt，记录仍在', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    expect(await disableWebhookEndpoint(u.id)).toBe(true);

    const view = await getWebhookEndpoint(u.id);
    expect(view?.disabledAt).not.toBeNull();
    expect(await prisma.fishWebhookEndpoint.count(), '不物删').toBe(1);
  });

  it('没登记地址时 rotate 明确报错，不是静默成功', async () => {
    const u = await makeUser();
    const res = await rotateWebhookSecret(u.id);
    expect(res.ok).toBe(false);
  });
});

describe('outbox 写入', () => {
  it('登记了地址 → 写一行 pending（正文含 transfer_id/金额/余额）；没登记 → 什么都不写', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);

    const id = await enqueue(u.id, 'tid-abc');
    expect(id).not.toBeNull();

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.event).toBe(WEBHOOK_EVENT_TRANSFER_RECEIVED);

    const body = JSON.parse(row.payload);
    expect(body).toMatchObject({
      event: WEBHOOK_EVENT_TRANSFER_RECEIVED,
      transfer_id: 'tid-abc',
      amount: 1.5,
      note: 'order-1',
      balance_after: 42.5,
    });
    expect(body.to.username).toBe('merchant');
    // delivery_id 与落库的那个一致（商户按它去重）
    expect(body.delivery_id).toBe(row.deliveryId);

    const noAddr = await makeUser();
    expect(await enqueue(noAddr.id), '没登记地址 → 不写').toBeNull();
    expect(await prisma.fishWebhookDelivery.count()).toBe(1);
  });

  it('★ 投递行写在调用方事务里：事务回滚 → 一行都不留（R3-318）', async () => {
    // 转账路径靠这条性质保证「钱回滚了，回调绝不会还在路上」。若 enqueue 偷用全局
    // prisma（而不是调用方 tx），回滚后这里会剩一行 → 红。
    const u = await makeUser();
    await registerReceiver(u.id);
    const sender = await makeUser();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueTransferWebhook({
          tx,
          recipientId: u.id,
          recipientUsername: 'merchant',
          senderId: sender.id,
          senderUsername: sender.username,
          amount: 1.5,
          note: 'rollback',
          transferId: 'tid-rollback',
          balanceAfter: 0,
        });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(await prisma.fishWebhookDelivery.count(), '事务回滚后 outbox 行必须一起消失').toBe(0);
  });

  it('★ 地址已停用 → 不再产生新的投递行（但历史记录留着）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    await enqueue(u.id, 'tid-before');
    await disableWebhookEndpoint(u.id);

    expect(await enqueue(u.id, 'tid-after')).toBeNull();
    expect(await prisma.fishWebhookDelivery.count(), '历史那条还在').toBe(1);
  });
});

describe('投递', () => {
  it('已存入库的映射回环地址在投递时被拒，TCP 连接数为零', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const u = await makeUser();
      // 模拟修复前已存在的配置；实际投递不传任何放宽策略的测试开关。
      await prisma.fishWebhookEndpoint.create({
        data: {
          userId: u.id,
          url: `https://[::ffff:127.0.0.1]:${port}/cb`,
          secretEncrypted: sealWebhookSecret('legacy-endpoint-test-secret'),
        },
      });
      const id = (await enqueue(u.id))!;
      expect(await deliverWebhook(id)).toBe('retry');
      const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.lastError).toContain('内网');
      expect(row.lastStatusCode).toBeNull();
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('★ 成功：收到 200 → delivered，header 与正文都对得上', async () => {
    const u = await makeUser();
    const secret = await registerReceiver(u.id);
    const id = (await enqueue(u.id, 'tid-ok'))!;

    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('delivered');

    expect(receiver!.hits).toHaveLength(1);
    const hit = receiver!.hits[0];
    expect(hit.headers['x-raricy-event']).toBe(WEBHOOK_EVENT_TRANSFER_RECEIVED);
    expect(hit.headers['x-raricy-delivery']).toBeTruthy();
    expect(hit.headers['content-type']).toContain('application/json');

    // 商户侧验签：按文档说的 `timestamp.body` 重算，必须一致
    const ts = hit.headers['x-raricy-timestamp'] as string;
    const expectSig = `v1=${signWebhook(secret, Number(ts), hit.body)}`;
    expect(hit.headers['x-raricy-signature']).toBe(expectSig);

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('delivered');
    expect(row.lastStatusCode).toBe(200);
    expect(row.deliveredAt).not.toBeNull();

    // 端点健康状态被更新
    const ep = await getWebhookEndpoint(u.id);
    expect(ep?.consecutiveFailures).toBe(0);
    expect(ep?.lastSuccessAt).not.toBeNull();
  });

  it('★ 商户返回 500 → 留在 pending 并排下一次（不判死、不丢）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    receiver!.statusQueue.push(500);
    const id = (await enqueue(u.id))!;
    // 取「投递前」的库钟：nextAttemptAt 与 nowForDb() 是**同一把钟**，两把钟相减才能
    // 暴露退避。旧写法 `nextAttemptAt > Date.now()+5s` 恒真（库钟比真实 UTC 快 8h），
    // 把退避整体删掉也不会红（R3-317）。
    const beforeMs = nowForDb().getTime();

    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('retry');

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastStatusCode).toBe(500);
    expect(row.lastError).toContain('500');
    // 退避：BACKOFF_MS[0] = 10s（fish-webhook-service.ts:47）；区间取
    // [10s, 10s+5s] —— 上界只吸收测试机变慢，不吸收「退避被删/被改成 0」。
    const delay = row.nextAttemptAt.getTime() - beforeMs;
    expect(delay, '第 1 次失败后必须排到 ~10 秒后（删掉退避这里会变成 ~0）').toBeGreaterThanOrEqual(
      10_000
    );
    expect(delay, `退避偏差过大：实际 ${delay}ms`).toBeLessThan(15_000);

    const ep = await getWebhookEndpoint(u.id);
    expect(ep?.consecutiveFailures).toBe(1);
    expect(ep?.lastFailureAt).not.toBeNull();
  });

  it('连不上（端口没人听）→ 也是 retry，记下错误', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    await receiver!.close();
    receiver = null;
    const id = (await enqueue(u.id))!;

    const outcome = await deliverWebhook(id, { allowPrivate: true });
    expect(outcome).toBe('retry');
    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.lastError).toBeTruthy();
  });

  it(`★ 重试 ${WEBHOOK_MAX_ATTEMPTS} 次仍失败 → dead，并打一条可 grep 的死信日志`, async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    // 每一次都回 503
    receiver!.statusQueue.push(...Array(WEBHOOK_MAX_ATTEMPTS).fill(503));

    let outcome = 'retry';
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      outcome = await deliverWebhook(id, { allowPrivate: true });
    }
    expect(outcome).toBe('dead');

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(await prisma.fishWebhookDelivery.count(), '判死也不物删').toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DEAD_LETTER'));
  });

  it('★ 已 delivered 的再投 → skipped；并发同投两次只有一次真的发出去（条件 UPDATE）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    await deliverWebhook(id, { allowPrivate: true });
    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('skipped');
    expect(receiver!.hits, '不会重复发').toHaveLength(1);

    const id2 = (await enqueue(u.id, 'tid-2'))!;
    const results = await Promise.all([
      deliverWebhook(id2, { allowPrivate: true }),
      deliverWebhook(id2, { allowPrivate: true }),
    ]);
    expect(results.filter((r) => r === 'delivered')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(1);
    expect(receiver!.hits, '商户只该收到一条新回调').toHaveLength(2);
  });

  it('★ 地址在投递时**重新**校验 SSRF（登记后改指向私网也拦得住）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    // 模拟商户把域名改指向内网（这里直接改库里的 url）
    await prisma.fishWebhookEndpoint.update({
      where: { userId: u.id },
      data: { url: 'https://169.254.169.254/latest/meta-data' },
    });

    // 注意这里**不传** allowPrivate —— 传了就等于把 SSRF 校验整个关掉，
    // 那正是这条用例要验的东西（生产调用方也从不传）。
    const outcome = await deliverWebhook(id);
    expect(outcome).toBe('retry');
    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.lastError).toContain('内网');
    expect(receiver!.hits, '一个包都不该发出去').toHaveLength(0);
  });

  it('地址被停用后 → 判死而不是无限重试到一个不存在的端点', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    await prisma.fishWebhookEndpoint.update({
      where: { userId: u.id },
      data: { disabledAt: new Date() },
    });

    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('dead');
  });
});

describe('drain', () => {
  it('★ 宽限期内的 pending 不捞（躲开「转账已提交、远端还没结算」的窗口）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    await enqueue(u.id);

    const r = await drainWebhookDeliveries({ allowPrivate: true }); // 默认宽限期 60s
    expect(r.scanned).toBe(0);
    expect(receiver!.hits).toHaveLength(0);
  });

  it('olderThanMs:0 时立刻捞（CLI 手动推动用）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    await enqueue(u.id);

    const r = await drainWebhookDeliveries({ olderThanMs: 0, allowPrivate: true, ignoreBackoff: true });
    expect(r.scanned).toBe(1);
    expect(r.delivered).toBe(1);
    expect(receiver!.hits).toHaveLength(1);
  });

  it('★ 回收租约：卡在 sending 太久的行会被重新排队', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    // 手工造一个「领了但没落结果」的行（updatedAt 推到很久以前）
    await prisma.fishWebhookDelivery.update({
      where: { id },
      data: { status: 'sending', attempts: 1, updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const r = await drainWebhookDeliveries({ allowPrivate: true });
    expect(r.reclaimed).toBe(1);

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('pending');
  });

  it('backoff 未到的行不捞（除非 ignoreBackoff）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    // ⚠️ 必须用 nowForDb() 而不是 Date.now()：本库时间戳是「UTC+8 墙上时间贴 Z」，
    // 用真实时钟算出来的「一小时后」在库里比 nowForDb() **早 8 小时**，
    // 于是行会被当成「早就到期了」而捞走 —— 这条用例第一次就是这么写错的。
    await prisma.fishWebhookDelivery.update({
      where: { id },
      data: { nextAttemptAt: new Date(nowForDb().getTime() + 60 * 60_000) },
    });

    expect((await drainWebhookDeliveries({ olderThanMs: 0, allowPrivate: true })).scanned).toBe(0);
    expect(
      (await drainWebhookDeliveries({ olderThanMs: 0, allowPrivate: true, ignoreBackoff: true })).scanned
    ).toBe(1);
  });
});

describe('投递记录查询', () => {
  it('只列自己的，且**不返回 payload**', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await registerReceiver(a.id);
    await enqueue(a.id, 'tid-a');

    const rows = await listRecentDeliveries(a.id);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('payload');
    expect(await listRecentDeliveries(b.id)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 迁移期：把存量密文从 SECRET_KEY 搬到 FISH_ENCRYPTION_KEY
//
// 这一组钉的是「解耦」本身，判据见 fish-webhook-service 的「回调签名密钥的钥匙」：
// 旧密文解得开（回退）、搬得动、搬完幂等、缺目标钥匙时**写路径响亮失败**
//（而不是悄悄退回旧钥匙 —— 那会让这个耦合自己长回来）。
// ─────────────────────────────────────────────────────────────────────────────
describe('迁移期：两把钥匙', () => {
  const LEGACY_KEY = process.env.SECRET_KEY as string;

  /** 直接写一行「旧钥匙封的」密文 —— 等价于这次迁移之前的存量行。 */
  async function seedLegacyRow(secret: string): Promise<string> {
    const u = await makeUser();
    await prisma.fishWebhookEndpoint.create({
      data: {
        userId: u.id,
        url: 'http://127.0.0.1:9/hook',
        secretEncrypted: sealSecret(secret, LEGACY_KEY),
        createdAt: nowForDb(),
        updatedAt: nowForDb(),
      },
    });
    return u.id;
  }

  async function ciphertextOf(userId: string): Promise<string> {
    const row = await prisma.fishWebhookEndpoint.findUniqueOrThrow({ where: { userId } });
    return row.secretEncrypted;
  }

  it('旧钥匙封的密文解得开（回退，报 legacy）；rekey 只换封装、不换密钥本身，重复跑是空操作', async () => {
    const uid = await seedLegacyRow('merchant-must-not-rotate');
    const ct = await ciphertextOf(uid);
    expect(inspectWebhookSecret(ct)).toBe('legacy');
    expect(openWebhookSecret(ct)).toBe('merchant-must-not-rotate');

    const first = await rekeyWebhookSecrets();
    expect(first).toMatchObject({ total: 1, migrated: 1, alreadyCurrent: 0, failed: [] });

    const migrated = await ciphertextOf(uid);
    expect(inspectWebhookSecret(migrated)).toBe('current');
    // ★ 解出来的仍是原来那把 —— 商户的验签代码不该因为这次迁移失效
    expect(openSecret(migrated, process.env.FISH_ENCRYPTION_KEY as string)).toBe(
      'merchant-must-not-rotate'
    );
    expect(inspectWebhookSecret(migrated), '旧钥匙已经打不开新密文').not.toBe('legacy');

    const second = await rekeyWebhookSecrets();
    expect(second).toMatchObject({ total: 1, migrated: 0, alreadyCurrent: 1 });
  });

  it('--dry-run 只报数不写库', async () => {
    const uid = await seedLegacyRow('untouched');
    const before = await ciphertextOf(uid);

    const r = await rekeyWebhookSecrets({ dryRun: true });
    expect(r).toMatchObject({ migrated: 1, dryRun: true });

    expect(await ciphertextOf(uid)).toBe(before);
  });

  it('两把钥匙都解不开的行：判成 unreadable，rekey 不碰它', async () => {
    const uid = await seedLegacyRow('x');
    // 换成「第三把钥匙」封的密文 —— 模拟密钥丢失 / 被人改过
    await prisma.fishWebhookEndpoint.update({
      where: { userId: uid },
      data: { secretEncrypted: sealSecret('x', 'some-key-we-no-longer-have') },
    });
    const ct = await ciphertextOf(uid);
    expect(inspectWebhookSecret(ct)).toBe('unreadable');
    expect(() => openWebhookSecret(ct)).toThrow();

    const r = await rekeyWebhookSecrets();
    expect(r).toMatchObject({ migrated: 0, alreadyCurrent: 0 });
    expect(r.unreadable).toEqual([uid]);
    expect(await ciphertextOf(uid)).toBe(ct); // 原样没动
  });

  it('缺 FISH_ENCRYPTION_KEY：读回退照旧，**写路径响亮失败**', async () => {
    const uid = await seedLegacyRow('still-readable');
    const saved = process.env.FISH_ENCRYPTION_KEY;
    delete process.env.FISH_ENCRYPTION_KEY;
    try {
      // 读：回退到 SECRET_KEY，存量行照样能投递
      expect(openWebhookSecret(await ciphertextOf(uid))).toBe('still-readable');
      // 写：不静默退回旧钥匙（那会让耦合自己长回来），也不悄悄生成一把新密钥
      expect(() => sealWebhookSecret('new-one')).toThrow(/FISH_ENCRYPTION_KEY/);
      const fresh = await makeUser();
      await expect(
        upsertWebhookEndpoint(fresh.id, 'http://127.0.0.1:9/hook', { allowPrivate: true })
      ).rejects.toThrow(/FISH_ENCRYPTION_KEY/);
      // 没写进去
      expect(await prisma.fishWebhookEndpoint.count({ where: { userId: fresh.id } })).toBe(0);
      // rekey 也拒绝跑（没有目标钥匙）
      await expect(rekeyWebhookSecrets()).rejects.toThrow(/FISH_ENCRYPTION_KEY/);
    } finally {
      process.env.FISH_ENCRYPTION_KEY = saved;
    }
  });
});
