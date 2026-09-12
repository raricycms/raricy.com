// ─────────────────────────────────────────────────────────────────────────────
// fish-sync.ts — 账户微服务同步账本（fail-closed 的落地机制）
//
// 【为什么存在】此前三条鱼干写路径把远端 HTTP 调用放在 SQLite 交互事务**内部**：
//   1. 写锁被占用最长 ACCOUNT_SERVICE_TIMEOUT（5s）—— 并发写耗尽 busy_timeout
//      直接 "database is locked"，高峰期整站写路径雪崩；
//   2. 「远端成功 → 本地 commit 失败」（进程崩溃 / 锁超时）会造成无法察觉的分叉，
//      而这正是 fail-closed 想防的反面。
//
// 【新流程】本地事务先提交（快、无 IO），远端调用在**事务外**进行：
//   Tx A：业务写入 + account_sync_ledger 登记一行 pending ──→ commit
//   Phase 2：executeSync() 按账本参数调用远端（幂等键与旧版完全一致）
//     ├─ 成功 → settleSync('synced')
//     └─ 失败 → 补偿事务：精确撤销 Tx A 的本地写入 + 删除账本行
//              ├─ 补偿成功 → 对用户仍等价于「回滚 + 503」（不变式保持）
//              └─ 补偿失败 → settleSync('failed') + ACCOUNT_RECONCILE_REQUIRED 日志
//
// 【崩溃窗口分析】（对照旧版的不可恢复分叉）
//   • Tx A 提交后、远端调用前崩溃 → 账本行留 pending → 重放收敛（远端幂等）；
//   • 远端成功后、settle 前崩溃 → 账本行留 pending → 重放 = 幂等 no-op → synced。
//   两种窗口都可通过 `npm run cli -- fish sync-retry`（replayPendingSyncs）恢复，
//   不再依赖人盯日志。
//
// 【payload 纪律】只存重建远端调用所需的**非敏感**参数；系统 Key / 用户 Key 一律
// 不入库 —— 重放时按 userId 重新解密（decryptApiKey）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import {
  accountClient,
  accountConfig,
  decryptApiKey,
  encryptApiKey,
  AccountServiceError,
  SYSTEM_USER_ID,
} from './account-client';
import type { Prisma } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

export type SyncOperation =
  | 'feed'
  | 'checkin'
  | 'admin_grant'
  | 'admin_deduct'
  | 'compensate'
  | 'register';

/** 账本行状态机：pending → synced | compensated | failed（failed 可重放，见 replayPendingSyncs）。 */
export type SyncStatus = 'pending' | 'synced' | 'compensated' | 'failed';

export interface PendingSyncEntry {
  /** 发往账户服务的主幂等键（feed 为 consume/income/refund 三键的根）。 */
  idempotencyKey: string;
  operation: SyncOperation;
  /** 非敏感重放参数（重建远端调用用）。 */
  payload: Record<string, unknown>;
}

/** 在本地事务内登记一笔待同步操作（与业务写入同事务提交）。 */
export async function recordPendingSync(tx: TxClient, entry: PendingSyncEntry): Promise<void> {
  await tx.accountSyncLedger.create({
    data: {
      idempotencyKey: entry.idempotencyKey,
      operation: entry.operation,
      payload: JSON.stringify(entry.payload),
      status: 'pending',
      createdAt: nowForDb(),
      updatedAt: nowForDb(),
    },
  });
}

/** 更新账本行状态（attempts 每结算一次 +1，即远端尝试次数）。 */
export async function settleSync(
  idempotencyKey: string,
  status: Exclude<SyncStatus, 'pending'>,
  lastError?: string
): Promise<void> {
  await prisma.accountSyncLedger.updateMany({
    where: { idempotencyKey },
    data: {
      status,
      lastError: lastError ?? null,
      attempts: { increment: 1 },
      updatedAt: nowForDb(),
    },
  });
}

/** 按账本参数重建并执行远端调用。成功 resolve；任何失败抛 AccountServiceError。 */
export async function executeSync(entry: {
  idempotencyKey: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
}): Promise<void> {
  switch (entry.operation) {
    case 'checkin': {
      const p = entry.payload as {
        toUserId: string;
        amount: number;
        description: string;
        date: string;
        fortuneValue: number;
      };
      await accountClient.transfer({
        fromUserId: SYSTEM_USER_ID,
        toUserId: p.toUserId,
        amount: p.amount,
        entryType: 'checkin',
        apiKey: accountConfig().systemKey,
        description: p.description,
        metadata: { fortune_value: p.fortuneValue, checkin_date: p.date },
        idempotencyKey: entry.idempotencyKey,
      });
      return;
    }

    case 'admin_grant':
    case 'admin_deduct': {
      const p = entry.payload as { userId: string; amount: number; description: string };
      const toSystem = entry.operation === 'admin_deduct';
      await accountClient.transfer({
        fromUserId: toSystem ? p.userId : SYSTEM_USER_ID,
        toUserId: toSystem ? SYSTEM_USER_ID : p.userId,
        amount: p.amount,
        entryType: entry.operation,
        apiKey: accountConfig().systemKey,
        description: p.description,
        idempotencyKey: entry.idempotencyKey,
      });
      return;
    }

    // 全站群发补偿：与 admin_grant 同向（系统账户 → 用户），但 entryType 记
    // 'system_compensate' 对齐 Flask —— 账户服务的流水里能一眼分出「补偿」与「手动赠送」。
    // 单列一个 case（而不是复用 admin_grant）是为了让 fish pending 里显示得诚实：
    // 借用 admin_grant 会让运维在账本上看到一批「管理员赠送」，而实际是系统补偿。
    case 'compensate': {
      const p = entry.payload as { userId: string; amount: number; description: string };
      await accountClient.transfer({
        fromUserId: SYSTEM_USER_ID,
        toUserId: p.userId,
        amount: p.amount,
        entryType: 'system_compensate',
        apiKey: accountConfig().systemKey,
        description: p.description,
        idempotencyKey: entry.idempotencyKey,
      });
      return;
    }

    case 'feed': {
      const p = entry.payload as {
        feederId: string;
        authorId: string;
        amount: number;
        authorIncome: number;
        blogId: string;
        blogTitle: string;
        feederName: string;
        feedSeq: number;
      };
      // 密钥不入账本：重放时按 userId 重新解密（缺 Key / 解密失败 → AccountServiceError）。
      const feeder = await prisma.user.findUnique({
        where: { id: p.feederId },
        select: { fishApiKeyEncrypted: true },
      });
      const feederApiKey = decryptApiKey(feeder?.fishApiKeyEncrypted ?? '');
      await accountClient.feedTransfer({
        feederId: p.feederId,
        feederApiKey,
        authorId: p.authorId,
        amount: p.amount,
        authorIncome: p.authorIncome,
        blogId: p.blogId,
        blogTitle: p.blogTitle,
        feederName: p.feederName,
        feedSeq: p.feedSeq,
      });
      return;
    }

    case 'register': {
      const p = entry.payload as { userId: string };
      // create_account 幂等：首次创建才返回 api_key。
      const acct = await accountClient.ensureAccount(p.userId);
      if (acct.api_key) {
        await prisma.user.update({
          where: { id: p.userId },
          data: { fishApiKeyEncrypted: encryptApiKey(acct.api_key) },
        });
      }
      // api_key 为空 = 账户早已存在（此前某次远端成功但未结算）。key 无法补发，
      // 标记 synced 并注明 —— 后续首次鱼干操作会因缺 Key fail-closed，人工介入。
      if (!acct.api_key) {
        console.warn(
          `[fish-sync] register 重放：账户 ${p.userId} 已存在但未返回 api_key，` +
            `无法回写本地 Key（需管理员在账户服务侧重置）`
        );
      }
      return;
    }
  }
}

export interface ReplayResult {
  /** 扫到的待重放行数 */
  total: number;
  synced: number;
  stillFailing: number;
}

/**
 * 重放 pending / failed 的账本行（幂等：远端同键重放收敛）。
 * 被 `npm run cli -- fish sync-retry` 调用；也可做成定时任务。
 *
 * @param olderThanMs 只重放创建时间早于该宽限期的行（避免与正在进行的写路径赛跑；
 *                    默认 60s —— 正常写路径的远端调用 + 补偿在秒级完成）。
 */
export async function replayPendingSyncs(
  opts: { olderThanMs?: number; limit?: number } = {}
): Promise<ReplayResult> {
  const graceMs = opts.olderThanMs ?? 60 * 1000;
  // 账本 createdAt 走 nowForDb()（UTC+8 墙上时间贴 Z），比较必须同一把钟 ——
  // 用真实 Date.now() 会让宽限期变成「8 小时 + graceMs」，崩溃后的 pending 行
  // 8 小时内扫不到（sync-retry 静默空转）。见 src/lib/db-time.ts。
  const cutoff = new Date(nowForDb().getTime() - graceMs);
  const rows = await prisma.accountSyncLedger.findMany({
    where: { status: { in: ['pending', 'failed'] }, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 50,
  });

  let synced = 0;
  let stillFailing = 0;
  for (const row of rows) {
    try {
      await executeSync({
        idempotencyKey: row.idempotencyKey,
        operation: row.operation as SyncOperation,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      });
      await prisma.accountSyncLedger.update({
        where: { idempotencyKey: row.idempotencyKey },
        data: { status: 'synced', lastError: null, attempts: { increment: 1 }, updatedAt: nowForDb() },
      });
      synced++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 只更新计数与错误信息，状态保持 pending/failed —— 下次继续重放。
      await prisma.accountSyncLedger
        .update({
          where: { idempotencyKey: row.idempotencyKey },
          data: { attempts: { increment: 1 }, lastError: msg, updatedAt: nowForDb() },
        })
        .catch(() => {
          /* 行被并发清理等极端情况：放弃本次 */
        });
      stillFailing++;
    }
  }
  return { total: rows.length, synced, stillFailing };
}

/**
 * 补偿事务失败时的最后一道防线：打结构化日志供告警系统按关键字捕获，
 * 并把账本行标记为 failed（下次 sync-retry 会重放远端，幂等收敛）。
 */
export async function logReconcileRequired(
  entry: PendingSyncEntry,
  err: unknown
): Promise<void> {
  console.error(
    'ACCOUNT_RECONCILE_REQUIRED ' +
      JSON.stringify({
        operation: entry.operation,
        idempotencyKey: entry.idempotencyKey,
        payload: entry.payload,
        stage: 'local_compensation_failed',
        error: err instanceof Error ? err.message : String(err),
        hint: '本地已提交但远端未同步且补偿失败；npm run cli -- fish sync-retry 可幂等重放',
      })
  );
}

export { AccountServiceError };
