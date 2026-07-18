// ─────────────────────────────────────────────────────────────────────────────
// fish-admin.ts — 管理员手动发/扣小鱼干（对齐 Flask app/cli.py 的 `flask fish grant|deduct`）
//
// ★★★ 写路径 fail-closed（CLAUDE.md Phase 1.5）★★★
//   本地变更（余额 + 流水）收进一个事务，**提交之前**同步账户微服务；
//   远端成功才提交本地，远端失败则整体回滚 —— 绝不出现「本地改了余额但远端没记账」。
//
// 放在 service 层而不是直接写在 CLI 里：① CLI 与未来可能的管理端接口共用同一套语义；
// ② 可被单元测试覆盖（这是钱的路径，必须能测）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import {
  accountClient,
  accountConfig,
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  AccountServiceError,
  SYSTEM_USER_ID,
} from './account-client';

/** 业务错误（余额不足等），与「远端故障」区分开：调用方据此返回不同退出码/状态码。 */
export class FishBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FishBusinessError';
  }
}

/**
 * 管理员赠送小鱼干（fail-closed）。
 * @returns 变更后的余额
 * @throws FishBusinessError  参数非法
 * @throws AccountServiceError 远端同步失败（本地已回滚，余额未变）
 */
export async function adminGrantFish(
  userId: string,
  amount: number,
  description = '管理员手动赠送'
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
  const remoteEnabled = accountServiceEnabled();
  // 幂等键含时间戳：对齐 Flask `cli-grant-{id}-{ts}-{amount}`。
  // 每次执行都是一笔新的发放（不是重试同一笔），故不做跨次幂等。
  const idempotencyKey = `cli-grant-${userId}-${Math.floor(Date.now() / 1000)}-${amount}`;

  return prisma.$transaction(
    async (tx) => {
      await addFish(tx, { userId, amount, type: 'admin_grant', description });

      if (remoteEnabled) {
        await accountClient.transfer({
          fromUserId: SYSTEM_USER_ID,
          toUserId: userId,
          amount,
          entryType: 'admin_grant',
          apiKey: accountConfig().systemKey,
          description,
          idempotencyKey,
        });
      } else {
        assertRemoteRequiredInProduction('赠送小鱼干');
        console.warn(`[fish-admin] ACCOUNT_SERVICE 未配置，赠送仅写本地库（dev fallback）。user=${userId}`);
      }

      const u = await tx.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
      return u?.driedFish ?? 0;
    },
    { timeout: 15000, maxWait: 5000 }
  );
}

/**
 * 管理员扣减小鱼干（fail-closed）。
 * @returns 变更后的余额
 * @throws FishBusinessError  参数非法 / 余额不足
 * @throws AccountServiceError 远端同步失败（本地已回滚，余额未变）
 */
export async function adminDeductFish(
  userId: string,
  amount: number,
  description = '管理员手动扣减'
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
  const remoteEnabled = accountServiceEnabled();
  const idempotencyKey = `cli-deduct-${userId}-${Math.floor(Date.now() / 1000)}-${amount}`;

  return prisma.$transaction(
    async (tx) => {
      // 原子扣减：WHERE driedFish >= amount —— 与 feed-service 同一套路，防超扣。
      const dec = await tx.user.updateMany({
        where: { id: userId, driedFish: { gte: amount } },
        data: { driedFish: { decrement: amount } },
      });
      if (dec.count === 0) {
        throw new FishBusinessError('小鱼干不足');
      }
      // 支出流水（负数表示支出，对齐 feed-service 的记法）
      await tx.fishTransaction.create({
        data: {
          userId,
          amount: -amount,
          type: 'admin_deduct',
          description,
          createdAt: nowForDb(),
        },
      });

      if (remoteEnabled) {
        // 扣减 = 用户 → 系统账户 的转账（账户服务无独立 deduct 端点）
        await accountClient.transfer({
          fromUserId: userId,
          toUserId: SYSTEM_USER_ID,
          amount,
          entryType: 'admin_deduct',
          apiKey: accountConfig().systemKey,
          description,
          idempotencyKey,
        });
      } else {
        assertRemoteRequiredInProduction('扣减小鱼干');
        console.warn(`[fish-admin] ACCOUNT_SERVICE 未配置，扣减仅写本地库（dev fallback）。user=${userId}`);
      }

      const u = await tx.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
      return u?.driedFish ?? 0;
    },
    { timeout: 15000, maxWait: 5000 }
  );
}
