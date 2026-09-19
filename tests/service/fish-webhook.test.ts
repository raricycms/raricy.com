// fish-webhook-service.ts —— 收款回调的 outbox、投递与重试。
//
// 【为什么要起一个真 HTTP 接收端】签名 header、正文形状、超时行为这些东西，
// mock 掉 postWebhook 就全测不到了 —— 而那正是商户要照着实现的部分。
// 接收端起在 127.0.0.1 上，投递时带 allowPrivate（**仅供测试**的开关，
// 生产调用方不传，见 fish-webhook-service.deliverWebhook 的签名）。
//
// 【与转账的接口在哪】「投递行与两条流水同事务写入」「补偿时删掉投递行」这两条
// 钱的安全性断言，落在 tests/service/fish-market-failclosed.test.ts 里更合适
//（那里有 mock 好的远端）。本文件测的是回调自己的生命周期。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
} from '@/lib/fish-webhook-service';
import { openSecret } from '@/lib/secret-box';
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
  it('★ 已知向量：签的是 `${timestamp}.${body}`，不是光 body', () => {
    // 硬编码的期望值 —— 改了签名方案这里就红。商户那边照这个实现才能对上。
    const sig = signWebhook('topsecret', 1700000000, '{"a":1}');
    const expected = createHmac('sha256', 'topsecret')
      .update('1700000000.{"a":1}')
      .digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同样的正文换个时间戳 → 签名不同（时间戳挡住了重放）', () => {
    const a = signWebhook('k', 100, '{}');
    const b = signWebhook('k', 101, '{}');
    expect(a).not.toBe(b);
  });

  it('换密钥 → 签名不同', () => {
    expect(signWebhook('k1', 1, '{}')).not.toBe(signWebhook('k2', 1, '{}'));
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

  it('★ 私网地址在登记时就被拒（不落库）', async () => {
    const u = await makeUser();
    const res = await upsertWebhookEndpoint(u.id, 'https://169.254.169.254/latest/meta-data');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('内网');
    expect(await prisma.fishWebhookEndpoint.count()).toBe(0);
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
  it('收款人登记了地址 → 写一行 pending，正文含 transfer_id 与金额', async () => {
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
  });

  it('没登记地址 → 什么都不写', async () => {
    const u = await makeUser();
    expect(await enqueue(u.id)).toBeNull();
    expect(await prisma.fishWebhookDelivery.count()).toBe(0);
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

    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('retry');

    const row = await prisma.fishWebhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastStatusCode).toBe(500);
    expect(row.lastError).toContain('500');
    // 退避：下一次不在这会儿
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 5000);

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

  it('已 delivered 的再投 → skipped（不会重复发）', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;
    await deliverWebhook(id, { allowPrivate: true });
    expect(await deliverWebhook(id, { allowPrivate: true })).toBe('skipped');
    expect(receiver!.hits).toHaveLength(1);
  });

  it('★ 认领是条件 UPDATE：同时投两次只有一次真的发出去', async () => {
    const u = await makeUser();
    await registerReceiver(u.id);
    const id = (await enqueue(u.id))!;

    const results = await Promise.all([
      deliverWebhook(id, { allowPrivate: true }),
      deliverWebhook(id, { allowPrivate: true }),
    ]);
    expect(results.filter((r) => r === 'delivered')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(1);
    expect(receiver!.hits, '商户只该收到一条').toHaveLength(1);
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
