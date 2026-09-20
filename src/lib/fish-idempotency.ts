// ─────────────────────────────────────────────────────────────────────────────
// fish-idempotency.ts — 鱼干写路径的幂等登记
//
// 【为什么需要它】鱼干写路径里有两处**键是确定的**：同一次操作重跑必须等价于没跑。
//   · 用户间转账（`opts.clientIdempotencyKey` 由站外脚本 / 收银台提供）——
//     调用方遇到超时后唯一的自救手段就是「用同一个键重发」；
//   · 群发补偿（`compensateIdempotencyKey` 由 batchId 派生）—— 批次跑一半被
//     中断，续跑必须跳过已发放的人。
// 这两处的键落库、唯一约束挡并发、重放时回报原结果。
//
// 【反过来：键带随机后缀的操作一律不登记】
//   签到翻牌 / 投喂 / 管理员单次发扣 / 练手盘开仓 / 注册建号 **每跑一次就是一笔新的**，
//   它们算出来的键每次都不一样，登记行没有任何去重价值，只会把表撑大、把「表里有什么」
//   这件事搅浑。**判据：键是确定的才登记。** 新增写路径时照这条判，别顺手都登记一遍。
//
// 【表的历史：为什么是 account_sync_ledger】
//   这张表原先是「本地已提交、远端账户服务尚未同步」的 outbox（pending → synced |
//   compensated | failed），配合补偿事务实现 fail-closed。账户服务搬进站内之后
//   **本地写入与记账在同一个事务里**，outbox 整个机制随之消失（见
//   docs/architecture.md §6.3.1 的历史注记）。
//   表**刻意不删、也不改名**：① 里面有真的历史账（那些行的 payload/status 是当年
//   对账的唯一凭据）；② 改名要一条迁移，而这张表的物理形态已经是既成事实。
//   现在写入的行**一律是 status='synced'**（登记与业务写入同事务提交 —— 提交成功
//   就是「已生效」，这个状态字面上就是对的）。
//   存量里可能残留 status != 'synced' 的行：那是迁移前的遗留，读的时候要当成
//   「不确定」处理（见 fish-market-service.resolveDuplicate），别当它不存在。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import type { Prisma } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

/**
 * 调用方提供的幂等键的字面量口径：1–48 位，仅字母数字与 `_ . : -`。
 *
 * 上限 48 不是随便定的：键会被拼成 `xfer-{8位哈希}-{客户端键}`，这是当年发往账户服务
 * 的格式（服务端上限 64）。**格式已冻结** —— 对外文档（`docs/bot/fish-bot.md` §6）与
 * 收银台的 `order` 参数口径都照着它写，放宽会让存量键与新键混进同一个命名空间。
 */
export const CLIENT_KEY_RE = /^[A-Za-z0-9_.:-]{1,48}$/;

export interface IdempotencyEntry {
  /** 幂等键（`account_sync_ledger.idempotency_key`，全局唯一）。 */
  idempotencyKey: string;
  /**
   * 这笔是什么操作。历史值：transfer / compensate（当前仅这两种会写行）；
   * 迁移前还有 feed / checkin / admin_grant / admin_deduct / register /
   * market_buy / market_sell —— 那些行的 operation 是它们当年的出处，别改。
   */
  operation: string;
  /** 非敏感参数（JSON 字符串落库）。**绝不放密钥**：凭据不入库是本模块的既定纪律。 */
  payload: Record<string, unknown>;
}

/**
 * 在调用方事务内登记一条幂等记录。
 *
 * ⚠️ **必须与业务写入同一个事务**。分开写就等于「钱动了但键没记」或反过来：
 * 前者让同键重放变成第二笔转账，后者让一笔根本没成交的操作把键永久占死。
 *
 * 并发同键由唯一约束挡下（P2002）—— 调用方据此判定「另一个请求已经在办这笔」。
 */
export async function claimIdempotency(tx: TxClient, entry: IdempotencyEntry): Promise<void> {
  const now = nowForDb();
  await tx.accountSyncLedger.create({
    data: {
      idempotencyKey: entry.idempotencyKey,
      operation: entry.operation,
      payload: JSON.stringify(entry.payload),
      // 与业务写入同事务提交：提交成功即「已生效」，不存在中间态。
      status: 'synced',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/** 按幂等键点查已登记的记录（转账重放判定用）。 */
export async function findIdempotency(idempotencyKey: string) {
  return prisma.accountSyncLedger.findUnique({ where: { idempotencyKey } });
}

/**
 * 生成**服务端自动**的转账幂等键（调用方没给 `idempotencyKey` 时）。
 * 格式：`transfer-{sha256(from-to-units-nonce)[:16]}-{ts}-{nonce}`
 *
 * 【为什么必须带随机 nonce】秒级时间戳下，同一用户对**同额**的两次转账会得到同一个键，
 * 第二笔会被当成幂等重放**静默去重**：只记一笔、用户以为转了两笔。转账是
 * 「点一次就是一笔新交易」，每次都必须有自己的键。
 *
 * 【为什么把 id 哈希掉而不是原样拼】两个 userId 各 36 字符，原样拼进去 102 字符，
 * 超过 `account_sync_ledger.idempotency_key` 的历史长度约定（≤64）。
 */
export function makeTransferIdempotencyKey(
  fromUserId: string,
  toUserId: string,
  units: number,
  nonce: string
): string {
  const short = createHash('sha256')
    .update(`${fromUserId}-${toUserId}-${units}-${nonce}`)
    .digest('hex')
    .slice(0, 16);
  return `transfer-${short}-${Math.floor(Date.now() / 1000)}-${nonce}`;
}

/**
 * 由**调用方提供的**键派生最终键。格式：`xfer-{sha256(fromUserId)[:8]}-{clientKey}`
 *
 * 【为什么要混进发送者哈希】客户端键只在调用方自己的命名空间里唯一（`wd-0007` 这种），
 * 两个不同的发送者完全可能撞上同一个字符串 —— 而幂等键是**全局唯一**的，
 * 不混进身份就会互相挡住。
 *
 * 【为什么与自动键分前缀】自动键是 `transfer-…`，这类是 `xfer-…`：
 * 运维查表时一眼能看出「这笔是调用方给了键」还是「服务端自己生成的」。
 */
export function makeClientIdempotencyKey(fromUserId: string, clientKey: string): string {
  const short = createHash('sha256').update(fromUserId).digest('hex').slice(0, 8);
  return `xfer-${short}-${clientKey}`;
}

/**
 * 幂等键 → 转账单号（两条流水共享的那个值）。取 sha256 前 16 位十六进制。
 *
 * 【为什么派生而不是随机 + 存一份】幂等键在一次调用里只算一次、且两条重放路径
 * （命中已有记录 / 并发撞唯一约束）手里都有它，派生出来的单号因此**天然可重现**
 * —— 重放同一个键回报的就是同一个单号，不需要多存一份，也就没有第二份会漂移的副本。
 * 反过来若存进记录里，迟早有人顺手把它加进「同键换参数」的比对，
 * 那会让**每一次重放都变成 409**。
 *
 * 不是凭证：它是给收付双方对账用的句柄，可预测无害（本仓没有「按单号查」的接口）。
 */
export function makeTransferId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
}
