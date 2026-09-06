// ─────────────────────────────────────────────────────────────────────────────
// fish-admin.ts — 管理员手动发/扣小鱼干（对齐 Flask app/cli.py 的 `flask fish grant|deduct`）
//
// ★★★ 写路径 fail-closed（CLAUDE.md Phase 1.5）★★★
//   本地变更（余额 + 流水 + 账本行）先在一个事务里提交，远端同步在**事务外**进行
//   （不再占用 SQLite 写锁等待 HTTP）；远端成功 → 账本标 synced；远端失败 →
//   补偿事务精确撤销本地写入（对用户等价于回滚），账目绝不无声分叉。
//   机制详见 src/lib/fish-sync.ts。
//
// 放在 service 层而不是直接写在 CLI 里：① CLI 与未来可能的管理端接口共用同一套语义；
// ② 可被单元测试覆盖（这是钱的路径，必须能测）。
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import {
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  AccountServiceError,
} from './account-client';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
} from './fish-sync';

/** 业务错误（余额不足等），与「远端故障」区分开：调用方据此返回不同退出码/状态码。 */
export class FishBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FishBusinessError';
  }
}

/** 校验金额（两条路径共用）：正整数。 */
function assertValidAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
}

/**
 * 幂等键：`cli-grant|deduct-{userId}-{ts}-{amount}-{nonce6}`。
 *
 * 对齐 Flask `cli-grant-{id}-{ts}-{amount}` 的人读格式，**另加 6 位随机后缀**：
 * 秒级时间戳下，同一用户对同金额的两次操作会得到同一个键 —— 旧版（无账本）时这
 * 意味着第二次发放会被账户服务当幂等重放**静默去重**（远端只记一笔、本地发两笔，
 * 账目无声分叉）；并发时还会让本地账本行的唯一约束互相踩踏。每次执行都是独立的
 * 一笔新发放，就该有独立的键。
 */
function makeAdminIdempotencyKey(kind: 'grant' | 'deduct', userId: string, amount: number): string {
  const nonce = randomBytes(3).toString('hex'); // 6 位 hex
  return `cli-${kind}-${userId}-${Math.floor(Date.now() / 1000)}-${amount}-${nonce}`;
}

/**
 * 管理员赠送小鱼干（fail-closed）。
 * @returns 变更后的余额
 * @throws FishBusinessError  参数非法
 * @throws AccountServiceError 远端同步失败（本地已补偿回滚，余额未变）
 */
export async function adminGrantFish(
  userId: string,
  amount: number,
  description = '管理员手动赠送'
): Promise<number> {
  assertValidAmount(amount);
  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('赠送小鱼干');
    console.warn(`[fish-admin] ACCOUNT_SERVICE 未配置，赠送仅写本地库（dev fallback）。user=${userId}`);
  }

  // 幂等键含时间戳 + 随机后缀（见 makeAdminIdempotencyKey）：每次执行都是一笔新的发放。
  const idempotencyKey = makeAdminIdempotencyKey('grant', userId, amount);
  const entry = {
    idempotencyKey,
    operation: 'admin_grant' as const,
    payload: { userId, amount, description },
  };

  // Phase 1：本地事务（加余额 + 写流水 + 账本登记）。
  const phase1 = await prisma.$transaction(async (tx) => {
    const fish = await addFish(tx, { userId, amount, type: 'admin_grant', description });
    if (remoteEnabled) {
      await recordPendingSync(tx, entry);
    }
    return { fishTxId: fish.txId };
  });

  // Phase 2：事务外远端同步。
  if (remoteEnabled) {
    try {
      await executeSync(entry);
      await settleSync(idempotencyKey, 'synced');
    } catch (syncErr) {
      // Phase 3：补偿 —— 删流水 + 扣回刚加的余额 + 删账本行（释放幂等键）。
      try {
        await prisma.$transaction(async (tx) => {
          await tx.fishTransaction.deleteMany({ where: { id: phase1.fishTxId } });
          const dec = await tx.user.updateMany({
            where: { id: userId, driedFish: { gte: fishToUnits(amount) } },
            data: { driedFish: { decrement: fishToUnits(amount) } },
          });
          if (dec.count === 0) {
            throw new Error(`余额不足以回退（user=${userId} amount=${amount}）`);
          }
          await tx.accountSyncLedger.deleteMany({ where: { idempotencyKey } });
        });
      } catch (undoErr) {
        await settleSync(idempotencyKey, 'failed', String(undoErr)).catch(() => {
          /* 尽力而为 */
        });
        await logReconcileRequired(entry, undoErr);
      }
      throw syncErr instanceof AccountServiceError
        ? syncErr
        : new AccountServiceError(`赠送同步失败: ${String(syncErr)}`, 503);
    }
  }

  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}

/**
 * 管理员扣减小鱼干（fail-closed）。
 * @returns 变更后的余额
 * @throws FishBusinessError  参数非法 / 余额不足
 * @throws AccountServiceError 远端同步失败（本地已补偿回滚，余额未变）
 */
export async function adminDeductFish(
  userId: string,
  amount: number,
  description = '管理员手动扣减'
): Promise<number> {
  assertValidAmount(amount);
  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('扣减小鱼干');
    console.warn(`[fish-admin] ACCOUNT_SERVICE 未配置，扣减仅写本地库（dev fallback）。user=${userId}`);
  }

  const idempotencyKey = makeAdminIdempotencyKey('deduct', userId, amount);
  const entry = {
    idempotencyKey,
    operation: 'admin_deduct' as const,
    payload: { userId, amount, description },
  };

  // Phase 1：本地事务（原子扣减 + 写支出流水 + 账本登记）。
  const units = fishToUnits(amount);
  const phase1 = await prisma.$transaction(async (tx) => {
    // 原子扣减：WHERE driedFish >= amount —— 防超扣。
    const dec = await tx.user.updateMany({
      where: { id: userId, driedFish: { gte: units } },
      data: { driedFish: { decrement: units } },
    });
    if (dec.count === 0) {
      throw new FishBusinessError('小鱼干不足');
    }
    // 支出流水（负数表示支出，对齐 feed-service 的记法）
    const txRow = await tx.fishTransaction.create({
      data: {
        userId,
        amount: -units,
        type: 'admin_deduct',
        description,
        createdAt: nowForDb(),
      },
      select: { id: true },
    });
    if (remoteEnabled) {
      await recordPendingSync(tx, entry);
    }
    return { fishTxId: txRow.id };
  });

  // Phase 2：事务外远端同步（扣减 = 用户 → 系统账户的转账，账户服务无独立 deduct 端点）。
  if (remoteEnabled) {
    try {
      await executeSync(entry);
      await settleSync(idempotencyKey, 'synced');
    } catch (syncErr) {
      // Phase 3：补偿 —— 删流水 + 加回刚扣的余额 + 删账本行。
      try {
        await prisma.$transaction(async (tx) => {
          await tx.fishTransaction.deleteMany({ where: { id: phase1.fishTxId } });
          await tx.user.update({
            where: { id: userId },
            data: { driedFish: { increment: units } },
          });
          await tx.accountSyncLedger.deleteMany({ where: { idempotencyKey } });
        });
      } catch (undoErr) {
        await settleSync(idempotencyKey, 'failed', String(undoErr)).catch(() => {
          /* 尽力而为 */
        });
        await logReconcileRequired(entry, undoErr);
      }
      throw syncErr instanceof AccountServiceError
        ? syncErr
        : new AccountServiceError(`扣减同步失败: ${String(syncErr)}`, 503);
    }
  }

  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}
