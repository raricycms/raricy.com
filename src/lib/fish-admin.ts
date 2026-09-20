// ─────────────────────────────────────────────────────────────────────────────
// fish-admin.ts — 管理员手动发/扣小鱼干（运维 CLI 与补偿批量的底层实现）
//
// 【写路径】余额与流水在**同一个 SQLite 事务**里提交 —— 要么一起生效、要么一起不生效，
//   不存在中间态，因此这里既没有远端同步、也没有补偿事务。账目与业务数据同库，
//   没有第二个存储需要对账（历史：迁移前是 fail-closed 三段结构，本地事务提交后要
//   在事务外调站外的账户微服务，失败再由补偿事务精确撤销本地写入。见
//   docs/architecture.md §6.3.1 的历史注记）。
//
// 【幂等登记：两条路径只有一条需要】
//   · `fish grant` / `fish deduct` —— 每次执行都是**一笔新的发放/扣减**，键带随机后缀，
//     登记了也没有去重价值，故不传 idempotencyKey（判据见 fish-idempotency.ts 头部）；
//   · 群发补偿 —— 键由 batchId + userId + amount 派生（确定的），批次跑一半被中断后
//     续跑必须跳过已发放的人，故必须登记。
//
// 放在 service 层而不是直接写在 CLI 里：① CLI 与未来可能的管理端接口共用同一套语义；
// ② 可被单元测试覆盖（这是钱的路径，必须能测）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { addFish, postEntry, InsufficientFishError } from './fish-service';
import { claimIdempotency } from './fish-idempotency';
import { fishToUnits, unitsToFish } from './fish-units';

/** 业务错误（余额不足等），与「故障」区分开：调用方据此报用户错误而不是未捕获异常。 */
export class FishBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FishBusinessError';
  }
}

/** 校验金额（三条路径共用）：正整数。 */
function assertValidAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
}

/**
 * operation → `fish_transactions.type`。
 *
 * 补偿记 `system_compensate`（专属值，不与 admin_grant 混用）——
 * 流水页上「系统补偿」和「管理员手动赠送」是两种能被区分开的事，别混成一个 type。
 */
const FISH_TX_TYPE: Record<'admin_grant' | 'compensate', string> = {
  admin_grant: 'admin_grant',
  compensate: 'system_compensate',
};

/**
 * 赠送的写路径 —— **唯一实现**（管理员单次赠送与群发补偿共用）。
 *
 * 【幂等登记是可选的，由「键是不是确定的」决定】给了 `idempotencyKey` 才登记，
 * 且**与余额/流水同一个事务**提交（claimIdempotency 的纪律见 fish-idempotency.ts 头部：
 * 分开写就是「钱动了但键没记」或「键被一笔没成交的操作占死」）。
 *   · 群发补偿传键 —— 同批次同用户必须拿到同一个键，续跑才会跳过已发放的人；
 *   · `fish grant` 不传 —— 每次执行都是一笔新发放，键每次都不一样，登记只会把表撑大。
 * 传 `null` 与不传等价。
 *
 * 补偿/回滚逻辑只有这一份：钱的路径各写一份，就是下一次「一边修了另一边没修」的起点。
 *
 * @returns 变更后的余额
 */
export async function grantFish(opts: {
  userId: string;
  amount: number;
  description: string;
  /** 幂等登记行的 account_sync_ledger.operation（补偿记 'compensate'，与单次赠送区分开）。 */
  operation: 'admin_grant' | 'compensate';
  idempotencyKey?: string | null;
}): Promise<number> {
  const { userId, amount, description, operation, idempotencyKey } = opts;

  await prisma.$transaction(async (tx) => {
    await addFish(tx, { userId, amount, type: FISH_TX_TYPE[operation], description });
    if (idempotencyKey) {
      await claimIdempotency(tx, {
        idempotencyKey,
        operation,
        payload: { userId, amount, description },
      });
    }
  });

  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}

/**
 * 管理员赠送小鱼干。
 * @returns 变更后的余额
 * @throws FishBusinessError 参数非法
 */
export async function adminGrantFish(
  userId: string,
  amount: number,
  description = '管理员手动赠送'
): Promise<number> {
  assertValidAmount(amount);
  // 不传幂等键：键带随机后缀、每次执行都是新的一笔（判据见 fish-idempotency.ts 头部）。
  return grantFish({ userId, amount, description, operation: 'admin_grant' });
}

/**
 * 管理员扣减小鱼干。
 * @returns 变更后的余额
 * @throws FishBusinessError 参数非法 / 余额不足
 */
export async function adminDeductFish(
  userId: string,
  amount: number,
  description = '管理员手动扣减'
): Promise<number> {
  assertValidAmount(amount);
  const units = fishToUnits(amount);

  await prisma.$transaction(async (tx) => {
    try {
      // 出账走记账内核：单条带谓词的 UPDATE（`driedFish >= need`），防超扣。
      await postEntry(tx, { userId, units: -units, type: 'admin_deduct', description });
    } catch (e) {
      // 内核的「余额不足」在本层有专门的业务文案（CLI 据此报用户错误、退出码 1）。
      // 内核不区分「余额不足」与「用户不存在」—— 两者的正确处理都是让事务失败，
      // 而 CLI 那条路径上用户是否存在早在 requireUser 里判过了。
      if (e instanceof InsufficientFishError) throw new FishBusinessError('小鱼干不足');
      throw e;
    }
  });

  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}
