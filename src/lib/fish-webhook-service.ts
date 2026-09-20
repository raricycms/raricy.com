// ─────────────────────────────────────────────────────────────────────────────
// fish-webhook-service.ts — 鱼干收款回调：地址配置 + outbox + 投递
//
// 【形状是 outbox，理由与记账无关】（CLAUDE.md 红线：HTTP **绝不能**在 SQLite 事务内）
//   ① 转账事务里：写一行 pending 投递（与两条流水同事务提交）
//      —— 于是「钱记了、通知忘了」在结构上不可能发生；
//   ② 事务提交后：`void deliver()` 尽力立即投递（不 await，
//      商户的 HTTP 延迟不该记在付款人账上）；
//   ③ 兜底：定时器与 CLI 只捞**超过宽限期**的 pending，覆盖 ② 失败 / 进程崩掉的情况。
//
// 【为什么不能顺手把它也改成「事务里直接发」】钱的事务只有毫秒级 ——
//   把商户的 HTTP（最长 WEBHOOK_TIMEOUT_MS）塞进去，等于让一个第三方站点的延迟
//   去占 SQLite 的写锁，并发写会直接 "database is locked"。这条与账户服务搬不搬
//   站内无关：**本站唯一允许的跨进程调用的 outbox 就是这里**。
//
// 【at-least-once，接收方必须去重】投递行被领走（status → sending）之后、标记
// delivered 之前进程崩掉，租约到期后这一行会被重新投递 —— 商户会收到重复回调。
// 这是刻意的取舍（要么至少一次、要么可能丢失；收款场景下「至少一次」才是对的）。
// 所以每条都带 X-Raricy-Delivery，**同一个值在重试之间不变**，商户按它去重。
//
// 【payload 存成品而不是重建参数】存参数是为了重放时重建请求，这里要的是
// **字节稳定** —— 签名算在正文上，重试时正文必须一模一样。
//
// 【失败不自动停用】连续失败次数只用于展示。悄悄停掉全部回调是典型的静默失效：
// 商户以为还在收通知，其实早就没了。要停由商户自己停。
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { sealSecret, openSecret, generateSecret } from './secret-box';
import {
  resolveWebhookTarget,
  postWebhook,
  WebhookUrlError,
  WEBHOOK_TIMEOUT_MS,
  type WebhookTarget,
} from './webhook-url';
import type { Prisma } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

/** 事件名。当前只有一种 —— 加了新的要同步 docs/bot/fish-bot.md。 */
export const WEBHOOK_EVENT_TRANSFER_RECEIVED = 'fish.transfer.received';

/** 重试间隔（毫秒），下标 = 已尝试次数。走完就判死。 */
const BACKOFF_MS = [
  10_000, // 第 1 次失败后 10 秒
  60_000, // 1 分钟
  5 * 60_000, // 5 分钟
  30 * 60_000, // 30 分钟
  2 * 60 * 60_000, // 2 小时
  6 * 60 * 60_000, // 6 小时
];
/** 总尝试次数上限（首次 + 重试）。超过 → dead。 */
export const WEBHOOK_MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** 领走但没落结果的行的租约时长；超时即视为崩了，回收重投。 */
const LEASE_MS = 120_000;

/** 定时器与 CLI 都只捞「投递行已存在超过这么久」的 —— 见文件头 ④。 */
const GRACE_MS = 60_000;

/** 一次 drain 最多处理几条。单进程 + SQLite，没必要并发。 */
const DRAIN_BATCH = 20;

export interface WebhookEndpointView {
  userId: string;
  url: string;
  disabledAt: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date | null;
}

// ── 签名 ─────────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256，签的是 **`${timestamp}.${body}`** 而不是光 body ——
 * 把时间戳纳入签名才挡得住重放（否则同一段正文可以被无限重发）。
 * Stripe 用的就是这个方案，商户那边好找参考实现。
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// ── 地址配置 ─────────────────────────────────────────────────────────────────

export async function getWebhookEndpoint(userId: string): Promise<WebhookEndpointView | null> {
  return prisma.fishWebhookEndpoint.findUnique({
    where: { userId },
    select: {
      userId: true,
      url: true,
      disabledAt: true,
      consecutiveFailures: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      createdAt: true,
    },
  });
}

export type UpsertEndpointResult =
  | { ok: true; secret: string | null; endpoint: WebhookEndpointView }
  | { ok: false; message: string };

/**
 * 登记 / 更新回调地址。
 *
 * **每次写入都重新过一遍 SSRF 校验**（不只是创建时）—— 攻击者可以把一个已经
 * 登记过的域名改指向 127.0.0.1，只在校验创建那一刻查是拦不住的。
 *
 * 首次登记时生成签名密钥并**明文返回一次**；更新地址时密钥不变（返回 null），
 * 想换密钥走 rotateWebhookSecret。改地址而不换密钥是刻意的：换地址不该让商户
 * 已经写好的验签代码失效。
 */
export async function upsertWebhookEndpoint(
  userId: string,
  rawUrl: string,
  opts?: { allowPrivate?: boolean }
): Promise<UpsertEndpointResult> {
  let target: WebhookTarget;
  try {
    target = await resolveWebhookTarget(rawUrl, { allowPrivate: opts?.allowPrivate });
  } catch (e) {
    if (e instanceof WebhookUrlError) return { ok: false, message: e.message };
    throw e;
  }

  const existing = await prisma.fishWebhookEndpoint.findUnique({ where: { userId } });
  const now = nowForDb();
  const url = target.url.toString();

  if (existing) {
    const row = await prisma.fishWebhookEndpoint.update({
      where: { userId },
      data: {
        url,
        disabledAt: null, // 重新登记即视为重新启用
        consecutiveFailures: 0,
        updatedAt: now,
      },
      select: {
        userId: true,
        url: true,
        disabledAt: true,
        consecutiveFailures: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        createdAt: true,
      },
    });
    return { ok: true, secret: null, endpoint: row };
  }

  const secret = generateSecret();
  const row = await prisma.fishWebhookEndpoint.create({
    data: {
      userId,
      url,
      secretEncrypted: sealSecret(secret, encryptionKeySource()),
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    },
    select: {
      userId: true,
      url: true,
      disabledAt: true,
      consecutiveFailures: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      createdAt: true,
    },
  });
  return { ok: true, secret, endpoint: row };
}

/** 换一把签名密钥（旧密钥立即失效）。明文只返回这一次。 */
export async function rotateWebhookSecret(
  userId: string
): Promise<{ ok: true; secret: string } | { ok: false; message: string }> {
  const existing = await prisma.fishWebhookEndpoint.findUnique({ where: { userId } });
  if (!existing) return { ok: false, message: '还没有登记回调地址' };

  const secret = generateSecret();
  await prisma.fishWebhookEndpoint.update({
    where: { userId },
    data: { secretEncrypted: sealSecret(secret, encryptionKeySource()), updatedAt: nowForDb() },
  });
  return { ok: true, secret };
}

/** 停用（软停：置 disabled_at，不物删）。历史投递记录保留供查证。 */
export async function disableWebhookEndpoint(userId: string): Promise<boolean> {
  const res = await prisma.fishWebhookEndpoint.updateMany({
    where: { userId, disabledAt: null },
    data: { disabledAt: nowForDb(), updatedAt: nowForDb() },
  });
  return res.count > 0;
}

/** 密钥来源取自 secret-box 的同一套派生（FISH_ENCRYPTION_KEY 优先，回退 SECRET_KEY）。 */
function encryptionKeySource(): string {
  return process.env.FISH_ENCRYPTION_KEY || process.env.SECRET_KEY || '';
}

/**
 * 单次投递的超时（毫秒）。`FISH_WEBHOOK_TIMEOUT_MS` 可覆盖，默认见 webhook-url.ts。
 * 非法值回落默认而不是变成 NaN —— NaN 传给 http.request 的 timeout 等于没有超时，
 * 那会让一个不响应的商户端点把 drainer 永久拖住。
 */
function webhookTimeoutMs(): number {
  const raw = process.env.FISH_WEBHOOK_TIMEOUT_MS;
  if (!raw) return WEBHOOK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : WEBHOOK_TIMEOUT_MS;
}

// ── outbox：写入（在转账事务内） ─────────────────────────────────────────────

export interface EnqueueInput {
  tx: TxClient;
  /** 收款人（= 回调地址的持有者）。 */
  recipientId: string;
  recipientUsername: string;
  senderId: string;
  senderUsername: string;
  amount: number;
  note: string | null;
  transferId: string;
  /** 收款后的余额（鱼干）。让商户不必再拉一次余额就能对账。 */
  balanceAfter: number;
}

/**
 * 登记一条投递。**必须在转账的 Phase 1 事务里调用**（见文件头 ①）。
 * 收款人没登记地址 / 已停用时什么都不做，返回 null。
 *
 * 注意这里**不读密钥**：一是事务里不该碰密码学，二是密钥在投递时才需要，
 * 而投递发生在事务外。地址是否启用也在这里判 —— 停用后新转账不再产生投递行。
 */
export async function enqueueTransferWebhook(input: EnqueueInput): Promise<number | null> {
  const endpoint = await input.tx.fishWebhookEndpoint.findUnique({
    where: { userId: input.recipientId },
    select: { disabledAt: true },
  });
  if (!endpoint || endpoint.disabledAt) return null;

  const deliveryId = randomBytes(16).toString('hex');
  const occurredAt = nowForDb().toISOString();

  // 正文在这里就序列化好并**原样落库** —— 重试必须字节一致（签名算在它上面）。
  const payload = JSON.stringify({
    event: WEBHOOK_EVENT_TRANSFER_RECEIVED,
    delivery_id: deliveryId,
    occurred_at: occurredAt,
    transfer_id: input.transferId,
    to: { user_id: input.recipientId, username: input.recipientUsername },
    from: { user_id: input.senderId, username: input.senderUsername },
    // amount 与 balance_after 都已经是**业务单位（鱼干）**，与 bot API 同一口径 ——
    // 不再过一遍 unitsToFish（那是「存储单位 → 鱼干」，重复换算会把数除以 10）。
    amount: input.amount,
    note: input.note ?? null,
    balance_after: input.balanceAfter,
  });

  const row = await input.tx.fishWebhookDelivery.create({
    data: {
      deliveryId,
      userId: input.recipientId,
      transferId: input.transferId,
      event: WEBHOOK_EVENT_TRANSFER_RECEIVED,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: nowForDb(),
      createdAt: nowForDb(),
      updatedAt: nowForDb(),
    },
    select: { id: true },
  });

  // 返回**行号**而不是那个随机 deliveryId：调用方拿它是为了提交后立刻投递
  //（deliverWebhook 按行号认领），deliveryId 是给商户去重用的、不出这个进程。
  return row.id;
}

// 这里曾有一个 dropTransferWebhook（转账补偿时删掉投递行）—— 投递行与两条流水
// 同事务提交，而「转账被回滚」这件事随账户服务搬进站内一起消失了（要么都提交、
// 要么都没提交），所以它没有了适用场景。需要删投递行时别照旧例重写一个：
// 先想清楚「钱退回去了但回调还在路上」在新结构下还能不能发生。

// ── 投递 ─────────────────────────────────────────────────────────────────────

export type DeliveryOutcome = 'delivered' | 'retry' | 'dead' | 'skipped';

/**
 * 投递一条（一次尝试）。**HTTP 在这里发生，调用方必须确保不在事务内。**
 *
 * 认领靠条件 UPDATE：只有把 attempts 从 n 改成 n+1 的那个调用者拿到 count===1
 * 才允许发。定时器与 CLI 同时扫到同一行时另一个直接跳过 —— 这就是「两个 drainer
 * 不重复投递」的全部机制。
 */
export async function deliverWebhook(
  deliveryId: number,
  /** @internal **仅供测试** —— 放行回环地址，好让 vitest 起一个真接收端。
   *  生产调用方（转账的那一下与 drainWebhookDeliveries）一律不传。 */
  opts?: { allowPrivate?: boolean }
): Promise<DeliveryOutcome> {
  const row = await prisma.fishWebhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!row || row.status === 'delivered' || row.status === 'dead') return 'skipped';

  const claim = await prisma.fishWebhookDelivery.updateMany({
    where: { id: row.id, attempts: row.attempts, status: { in: ['pending', 'sending'] } },
    data: { status: 'sending', attempts: { increment: 1 }, updatedAt: nowForDb() },
  });
  if (claim.count !== 1) return 'skipped'; // 被别人领走了

  const attempt = row.attempts + 1;
  const endpoint = await prisma.fishWebhookEndpoint.findUnique({
    where: { userId: row.userId },
  });
  if (!endpoint || endpoint.disabledAt) {
    // 地址没了或停了 —— 不是投递失败，是这件事不该再发生。直接判死，
    // 否则会一直重试到一个永远不存在的端点。
    await prisma.fishWebhookDelivery.updateMany({
      where: { id: row.id },
      data: { status: 'dead', lastError: '回调地址已停用或不存在', updatedAt: nowForDb() },
    });
    return 'dead';
  }

  let error: string | null = null;
  let statusCode: number | null = null;
  try {
    const secret = openSecret(endpoint.secretEncrypted, encryptionKeySource());
    const timestamp = Math.floor(Date.now() / 1000);
    // **重试时时间戳是新算的**（签名因而也是新的）—— 商户那边要按
    // X-Raricy-Delivery 去重、按时间戳判新鲜度，两者分工不同。
    const signature = signWebhook(secret, timestamp, row.payload);
    // ★ 每一次投递都**重新**过一遍 SSRF 校验 ★
    // 只在登记时查一次是不够的：商户可以把一个已登记的域名改指向 127.0.0.1
    //（DNS 变了，我们手里的 url 字符串没变）。这里连的也是校验过的那个 IP。
    const target = await resolveWebhookTarget(endpoint.url, {
      allowPrivate: opts?.allowPrivate,
    });

    const res = await postWebhook(
      target,
      {
        'X-Raricy-Event': row.event,
        'X-Raricy-Delivery': row.deliveryId,
        'X-Raricy-Timestamp': String(timestamp),
        'X-Raricy-Signature': `v1=${signature}`,
      },
      row.payload,
      { timeoutMs: webhookTimeoutMs() }
    );
    statusCode = res.status;
    if (res.status >= 200 && res.status < 300) {
      await prisma.fishWebhookDelivery.updateMany({
        where: { id: row.id },
        data: {
          status: 'delivered',
          deliveredAt: nowForDb(),
          lastStatusCode: res.status,
          lastError: null,
          updatedAt: nowForDb(),
        },
      });
      await prisma.fishWebhookEndpoint.updateMany({
        where: { userId: row.userId },
        data: { consecutiveFailures: 0, lastSuccessAt: nowForDb(), updatedAt: nowForDb() },
      });
      return 'delivered';
    }
    error = `商户返回 ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // 失败：还有额度就排下一次，否则判死（**不物删**，留给运维查证）
  const dead = attempt >= WEBHOOK_MAX_ATTEMPTS;
  const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  const nextAt = new Date(nowForDb().getTime() + delay);

  await prisma.fishWebhookDelivery.updateMany({
    where: { id: row.id },
    data: {
      status: dead ? 'dead' : 'pending',
      lastError: error,
      lastStatusCode: statusCode,
      nextAttemptAt: dead ? row.nextAttemptAt : nextAt,
      updatedAt: nowForDb(),
    },
  });
  await prisma.fishWebhookEndpoint.updateMany({
    where: { userId: row.userId },
    data: { consecutiveFailures: { increment: 1 }, lastFailureAt: nowForDb(), updatedAt: nowForDb() },
  });

  if (dead) {
    // 单行结构化日志（仿 ACCOUNT_RECONCILE_REQUIRED）—— 失败到判死是**没人会主动看**
    // 的那种事，留一行可供 grep 的记录，并在文档里指到 `fish webhooks`。
    console.error(
      'WEBHOOK_DEAD_LETTER ' +
        JSON.stringify({
          deliveryId: row.deliveryId,
          userId: row.userId,
          transferId: row.transferId,
          attempts: attempt,
          lastError: error,
          hint: '回调已放弃投递。商户需自行拉流水对账；运维可查 `fish webhooks`。',
        })
    );
    return 'dead';
  }
  return 'retry';
}

/**
 * 回收租约：把卡在 sending 太久（进程崩在「已发送、未落结果」之间）的行改回 pending。
 * **每条 drain 开头都要跑** —— 不跑的话那些行会永远卡住，没有任何东西会再来碰它们。
 */
async function reclaimLeases(): Promise<number> {
  const cutoff = new Date(nowForDb().getTime() - LEASE_MS);
  const res = await prisma.fishWebhookDelivery.updateMany({
    where: { status: 'sending', updatedAt: { lt: cutoff } },
    data: { status: 'pending', lastError: '投递中断，已重新排队', updatedAt: nowForDb() },
  });
  return res.count;
}

export interface DrainResult {
  scanned: number;
  delivered: number;
  retried: number;
  dead: number;
  reclaimed: number;
}

/**
 * 捞一批到期的 pending 依次投递。
 *
 * @param opts.ignoreBackoff CLI 手动推动时为 true：不看 nextAttemptAt，全捞
 *        （运维要的是「现在就再试一遍」，不是「等退避到点」）。
 * @param opts.olderThanMs 只处理创建超过这么久的行。定时器用默认的宽限期
 *        （躲开「转账已提交、远端还没结算」的窗口，见文件头 ④）；CLI 传 0。
 */
export async function drainWebhookDeliveries(opts?: {
  limit?: number;
  ignoreBackoff?: boolean;
  olderThanMs?: number;
  /** @internal **仅供测试**，原样转给 deliverWebhook。 */
  allowPrivate?: boolean;
}): Promise<DrainResult> {
  const reclaimed = await reclaimLeases();

  const cutoff = new Date(nowForDb().getTime() - (opts?.olderThanMs ?? GRACE_MS));
  const rows = await prisma.fishWebhookDelivery.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
      ...(opts?.ignoreBackoff ? {} : { nextAttemptAt: { lte: nowForDb() } }),
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: Math.min(200, Math.max(1, opts?.limit ?? DRAIN_BATCH)),
    select: { id: true },
  });

  const result: DrainResult = {
    scanned: rows.length,
    delivered: 0,
    retried: 0,
    dead: 0,
    reclaimed,
  };
  // 串行发：单进程 + SQLite，而且并发投递会让「同一商户端点」被同时打
  for (const r of rows) {
    const outcome = await deliverWebhook(r.id, { allowPrivate: opts?.allowPrivate });
    if (outcome === 'delivered') result.delivered++;
    else if (outcome === 'retry') result.retried++;
    else if (outcome === 'dead') result.dead++;
  }
  return result;
}

/** 最近若干条投递记录（自助页展示用）。**不返回 payload** —— 那是给商户的，不是给页面看的。 */
export async function listRecentDeliveries(userId: string, take = 20) {
  return prisma.fishWebhookDelivery.findMany({
    where: { userId },
    orderBy: { id: 'desc' },
    take: Math.min(50, Math.max(1, take)),
    select: {
      id: true,
      deliveryId: true,
      transferId: true,
      event: true,
      status: true,
      attempts: true,
      lastError: true,
      lastStatusCode: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
}
