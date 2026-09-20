// ─────────────────────────────────────────────────────────────────────────────
// fish-market-service.ts — 鱼干市场：用户间转账（无手续费）
//
// 【写路径】扣发送者 + 加接收者 + 两条流水 +（有客户端幂等键时）一条幂等记录，
//   **全部在一个 SQLite 事务里提交**。余额与流水要么一起生效、要么一起不生效 ——
//   不存在中间态，因此也没有补偿事务（见 docs/architecture.md §6.3.1 的历史注记：
//   账户微服务曾在站外，那时才有「本地提交了、远端还没」这个窗口）。
//
// 【幂等键】`opts.clientIdempotencyKey` 由调用方提供（站外脚本 / 收银台）时：
//   同一个键 + **同样的收款人/金额/留言** 重发 = 返回原结果、绝不重复转账；
//   同一个键配不同的参数 = 409（不静默改单）。
//   不提供时由服务端生成随机键 —— 此时**重试就是再转一笔**（见 docs/bot/fish-bot.md §6）。
//   **只有给了键的那一路才登记记录**：随机键每次都不一样，登记了也没有去重价值，
//   只会把 account_sync_ledger 撑大（判据见 fish-idempotency.ts 头部）。
//
// 【金额口径】业务单位「鱼干」，最多 1 位小数（0.1 起）—— fishToUnits 在数据库边界
//   换成 0.1 鱼干单位的整数，超精度 fail-loud（这里转成 400 文案，别让它冒泡成 500）。
//
// 【权限档位】登录 + 非禁言，**不要求 core+** —— 与 /fish 面板、签到同一档
//   （投喂要求 core+ 是因为它挂在博客页；转账是鱼干的通用能力）。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import {
  claimIdempotency,
  findIdempotency,
  makeClientIdempotencyKey,
  makeTransferId,
  makeTransferIdempotencyKey,
  CLIENT_KEY_RE,
  type IdempotencyEntry,
} from './fish-idempotency';
import { sendNotification } from './notification-service';
import { rateLimit, RULES } from './rate-limit';
import { isServiceAccount, SERVICE_QUOTA } from './service-accounts';
import { enqueueTransferWebhook, deliverWebhook } from './fish-webhook-service';
import type { Prisma } from '@prisma/client';

/** 转账留言长度上限（超出直接 400，不静默截断）。 */
export const TRANSFER_NOTE_MAX = 30;

/** 流水 type：发送者支出 / 接收者入账（对齐 feed / feed_receive 的命名对）。 */
export const TRANSFER_OUT_TYPE = 'transfer';
export const TRANSFER_IN_TYPE = 'transfer_receive';

export interface TransferTarget {
  id: string;
  username: string;
}

export type TransferOutcome =
  | {
      ok: true;
      amount: number;
      balance: number;
      recipient: TransferTarget;
      /**
       * 这笔转账的共享单号 —— 发送方与接收方的两条流水都带同一个值，
       * 双方据此对同一笔账（见 prisma/migrations/14_fish_transfer_id）。
       * 重放（duplicated）时回报的是**原单**的单号，不是新的。
       */
      transferId: string;
      /** true = 客户端幂等键命中同一笔已成交的转账，本次**没有**再转账。 */
      duplicated?: boolean;
    }
  | { ok: false; code: number; message: string };

/**
 * 收银台 `order` 参数的字面量口径：≤32 位，字符集是 `CLIENT_KEY_RE` 的**子集**。
 *
 * 32 这个上界由键长预算倒推，不是随手取的：见下面 makeOrderKeyBase 的长度核算。
 * 放宽长度或字符集之前，先回去核 `CLIENT_KEY_RE` 的 48 字上限 —— 超了的表现是
 * 用户收到一句「幂等键格式不合法」，与他的输入看不出任何关系。
 */
export const ORDER_RE = /^[A-Za-z0-9_.:-]{1,32}$/;

/**
 * 收银台的幂等键基：由「收款人 + 订单号」决定（没给订单号时页面退回随机键基）。
 *
 * 于是**同一个订单号永远算出同一个键** —— 付款成功后刷新页面再点一次，服务端认得出
 * 是同一笔（回报 duplicated、不再扣款）。这正是 `order` 参数存在的全部理由：没有它，
 * 键基是每次加载随机的，刷新即新键 = 真的再付一笔。
 *
 * 【为什么把收款人混进来】不混的话，「同一个付款人给两家不同商户用同一个订单号串」
 * 会算出同一个键 → 第二家直接 409、付不出去。收款人正是区分两笔生意的那个维度。
 * 哈希后取前 8 位而非直接拼 id：键的上限是 48 字，要留足订单号的预算。
 *
 * 【为什么**不**把金额混进来】金额由收银台链接给定、用户改不了；同订单号换金额应当
 * **响亮地 409**（服务端「同键换参数」的标准语义），而不是静默变成第二笔扣款。
 * 这与随机键基那一路（`PayForm.idempotencyKeyFor`）的取舍**正好相反** ——
 * 扫码收款页的用户能在同一页里改金额，那一路必须换新键，否则一次正常重试会被 409 挡掉。
 *
 * 长度核算：`pay-`(4) + 哈希(8) + `-`(1) + 订单号(≤32) = 45 ≤ 48。
 *
 * 调用方负责先过 `ORDER_RE`（本函数不校验，与 makeClientIdempotencyKey 同款分工）。
 */
export function makeOrderKeyBase(counterpartyUserId: string, order: string): string {
  const h = createHash('sha256').update(counterpartyUserId).digest('hex').slice(0, 8);
  return `pay-${h}-${order}`;
}

/** Prisma 唯一约束冲突（账本键撞车时用它区分「并发同键」与真故障）。 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === 'P2002'
  );
}

/**
 * 客户端幂等键命中**已登记的记录**时的处理。三种局面各有各的对：
 *   · 参数一致且已生效 → 原样回报（`duplicated: true`），一分钱都不再动；
 *   · 参数不一致 → 409（同键换个参数是调用方的 bug，静默改单更糟）；
 *   · 记录存在但状态不是 synced → 409。
 *
 * 【第三种为什么还留着】新写入的记录**一律是 synced**（登记与转账同事务提交，
 * 提交成功就是已生效）。这个分支只为**迁移前遗留的行**服务 —— 那时记录会停在
 * pending / failed（本地已提交、远端没同步 / 补偿也失败）。对它们的正确动作是人工
 * 查证，绝不是当它已成交再回报一次「转账成功」。
 */
async function resolveDuplicate(
  row: { payload: string; status: string },
  expected: { fromUserId: string; toUserId: string; amount: number; description: string },
  /**
   * 本笔的单号（由幂等键派生，见 transferFish）。重放必须回报**原单**的单号 ——
   * 它是从同一个键派生出来的，所以这里天然就是原值，不需要额外查库。
   *
   * ⚠️ 别把 transferId 加进上面 expected 的**参数比对**：那是防「同键换参数」的闸门，
   * 而 transferId 由键决定、必然一致，加进去只会让每次重放都 409。
   */
  transferId: string
): Promise<TransferOutcome> {
  let payload: { toUserId?: string; amount?: number; description?: string } = {};
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    /* 记录 payload 损坏：当作参数不一致处理，宁可 409 也不冒重复转账的险 */
  }
  if (
    payload.toUserId !== expected.toUserId ||
    payload.amount !== expected.amount ||
    payload.description !== expected.description
  ) {
    return {
      ok: false,
      code: 409,
      message: '该幂等键已用于另一笔转账（收款人 / 金额 / 留言不同），请换一个键',
    };
  }
  if (row.status === 'synced') {
    const [sender, recipient] = await Promise.all([
      prisma.user.findUnique({
        where: { id: expected.fromUserId },
        select: { driedFish: true },
      }),
      prisma.user.findUnique({
        where: { id: expected.toUserId },
        select: { id: true, username: true },
      }),
    ]);
    if (recipient) {
      return {
        ok: true,
        amount: expected.amount,
        balance: unitsToFish(sender?.driedFish ?? 0),
        recipient,
        transferId,
        duplicated: true,
      };
    }
  }
  return {
    ok: false,
    code: 409,
    message: '该幂等键对应的记录状态异常（迁移前的遗留），请人工查证后再换键重试',
  };
}

/**
 * 搜索转账收款人：任意用户（**不限 core+** —— 鱼干可以转给任何人），排除自己。
 * query 为空时返回最近注册的一批。按 username 匹配，返回分页总数供弹窗算页数。
 *
 * 与 chat-service.searchCoreUsers 同形，差异只在「不筛 role」：讨论是 core+ 专属，
 * 转账不是。若将来讨论那边改了筛选口径，别顺手把这里也改过去。
 */
export async function searchTransferTargets(
  query: string,
  selfId: string,
  limit = 30,
  offset = 0
): Promise<{ users: TransferTarget[]; total: number }> {
  const q = query.trim();
  const where: Prisma.UserWhereInput = {
    NOT: { id: selfId },
    ...(q ? { username: { contains: q } } : {}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, offset),
      take: Math.min(100, Math.max(1, limit)),
      select: { id: true, username: true },
    }),
    prisma.user.count({ where }),
  ]);
  return { users, total };
}

/**
 * 按用户名**精确**查收款人（站外脚本手里只有用户名，没有 id）。
 * 找不到返回 null。匹配口径与 /api/auth/login 一致：区分大小写、不做模糊匹配 ——
 * 转账是钱的路径，「看起来像」不算数。
 */
export async function findTransferTargetByUsername(
  username: string
): Promise<TransferTarget | null> {
  const u = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true },
  });
  return u;
}

/**
 * 用户间转账：发送者扣 amount、接收者得 amount，零手续费，**一个事务**。
 *
 * 【幂等键】`opts.clientIdempotencyKey` 由调用方提供（站外脚本 / 收银台）时：
 * 同一个键 + **同样的收款人/金额/留言** 重发 = 返回原结果、绝不重复转账；
 * 同一个键配不同的参数 = 409（不静默改单）。
 * 不提供时由服务端生成随机键 —— 此时**重试就是再转一笔**（见 docs/bot/fish-bot.md §6）。
 *
 * @param note 可选留言（同一句话进双方流水的描述）
 * @param opts.clientIdempotencyKey ≤48 位，`[A-Za-z0-9_.:-]`
 * @returns 业务结果。**不抛故障类异常** —— 没有远端了，本地事务要么成要么不成。
 */
export async function transferFish(
  fromUserId: string,
  toUserId: string,
  amount: number,
  note?: string | null,
  opts?: { clientIdempotencyKey?: string | null }
): Promise<TransferOutcome> {
  // ── 入参校验（不写库）────────────────────────────────────────────────────
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 400, message: '转账金额需大于 0' };
  }
  let units: number;
  try {
    units = fishToUnits(amount);
  } catch {
    // fishToUnits 对 >1 位小数 fail-loud（抛的是普通 Error）。不在这里接住转成 400，
    // 它会冒泡成 500 —— 用户输入 0.05 看到「服务器开小差了」，前端也不知道该提示什么。
    return { ok: false, code: 400, message: '转账金额最多 1 位小数' };
  }

  const cleanNote = (note ?? '').trim().replace(/\s+/g, ' ');
  if (cleanNote.length > TRANSFER_NOTE_MAX) {
    return { ok: false, code: 400, message: `留言最多 ${TRANSFER_NOTE_MAX} 个字` };
  }

  const recipient = await prisma.user.findUnique({
    where: { id: toUserId },
    select: { id: true, username: true },
  });
  if (!recipient) return { ok: false, code: 404, message: '接收者不存在' };
  if (recipient.id === fromUserId) return { ok: false, code: 400, message: '不能给自己转账' };

  const sender = await prisma.user.findUnique({
    where: { id: fromUserId },
    select: { username: true },
  });
  if (!sender) return { ok: false, code: 404, message: '用户不存在' };

  const description = cleanNote
    ? `转给「${recipient.username}」：${cleanNote}`
    : `转给「${recipient.username}」`;

  // 幂等键**只算一次**：登记（事务内）与单号派生都用它。
  const clientKey = (opts?.clientIdempotencyKey ?? '').trim();
  if (clientKey && !CLIENT_KEY_RE.test(clientKey)) {
    return {
      ok: false,
      code: 400,
      message: '幂等键格式不合法（1-48 位，仅字母数字与 _ . : -）',
    };
  }
  const idempotencyKey = clientKey
    ? makeClientIdempotencyKey(fromUserId, clientKey)
    : makeTransferIdempotencyKey(fromUserId, recipient.id, units, randomBytes(4).toString('hex'));

  // 共享单号：写进**两条**流水（派生规则见 fish-idempotency.makeTransferId）。
  const transferId = makeTransferId(idempotencyKey);

  // 调用方给了键 → 先看有没有同一笔的记录：有就按「重放」处理，绝不重复转账。
  // 放在限频**之前**：重放请求不该消耗额度（调用方遇到超时就该用同键重试）。
  const expected = { fromUserId, toUserId: recipient.id, amount, description };
  if (clientKey) {
    const existing = await findIdempotency(idempotencyKey);
    if (existing) return resolveDuplicate(existing, expected, transferId);
  }

  // 限频（放在校验之后：刷不存在的用户名不该烧掉自己的额度，对齐点赞/评论）。
  // 转账是**唯一**有配额的鱼干写路径 —— 也是唯一能把鱼干推给任意第三方的路径。
  // 白名单账号（站外银行这类）走 SERVICE_QUOTA 抬高的一组，见 service-accounts.ts。
  const quota = isServiceAccount(fromUserId) ? SERVICE_QUOTA : RULES;
  const hourly = rateLimit(`transfer:h:${fromUserId}`, quota.transferHourly);
  const daily = rateLimit(`transfer:d:${fromUserId}`, quota.transferDaily);
  if (!hourly.allowed || !daily.allowed) {
    return { ok: false, code: 429, message: '转账太频繁了，请稍后再试' };
  }

  // 幂等记录（只在调用方给了键时才登记，判据见 fish-idempotency.ts 头部）。
  const entry: IdempotencyEntry = {
    idempotencyKey,
    operation: 'transfer',
    payload: { fromUserId, toUserId: recipient.id, amount, description },
  };

  // 并发撞键的载体：事务里撞上幂等记录的唯一约束时，把「重放的结果」原样带回外层。
  class TransferDuplicateError extends Error {
    constructor(public outcome: TransferOutcome) {
      super('duplicate idempotency key');
    }
  }

  try {
    // ── 一个事务：扣款、两条流水、幂等记录、回调出账 ──────────────────────────
    const applied = await prisma.$transaction(async (tx) => {
      // 1.1 发送者支出（内核：条件扣减 + 一条负数流水）。
      //     余额不足由内核抛 InsufficientFishError，外层转成 400。
      const outTx = await postEntry(tx, {
        userId: fromUserId,
        units: -units,
        type: TRANSFER_OUT_TYPE,
        description,
        referenceType: 'user',
        referenceId: recipient.id,
        relatedUserId: recipient.id,
        transferId,
      });

      // 1.2 接收者入账（内核：加余额 + transfer_receive 流水）。
      //     1.1 与 1.2 的 transferId 必须是**同一个值** —— 这正是这一列存在的全部意义，
      //     两边各算一次（或漏传一边）会让「按单号对上同一笔」静默失效。
      const inTx = await postEntry(tx, {
        userId: recipient.id,
        units,
        type: TRANSFER_IN_TYPE,
        description: cleanNote
          ? `收到「${sender.username}」的转账：${cleanNote}`
          : `收到「${sender.username}」的转账`,
        referenceType: 'user',
        referenceId: fromUserId,
        relatedUserId: fromUserId,
        transferId,
      });

      // 1.3 幂等记录。**与两条流水同事务提交** —— 于是「钱动了但键没记」
      //     （同键重放变成第二笔转账）在结构上不可能发生。
      if (clientKey) await claimIdempotency(tx, entry);

      // 读回最新余额（仍在事务中，故为本事务可见的最新状态）
      const after = await tx.user.findUnique({
        where: { id: fromUserId },
        select: { driedFish: true },
      });
      const recipientAfter = await tx.user.findUnique({
        where: { id: recipient.id },
        select: { driedFish: true },
      });

      // 1.4 回调出账（outbox）。**与两条流水同事务提交** —— 于是「钱记了、通知忘了」
      //     在结构上不可能发生。收款人没登记地址 / 已停用时什么都不写。
      //     这里只有纯 DB 写入，密码学与 HTTP 全在事务外（见 fish-webhook-service 头部）。
      const deliveryId = await enqueueTransferWebhook({
        tx,
        recipientId: recipient.id,
        recipientUsername: recipient.username,
        senderId: fromUserId,
        senderUsername: sender.username,
        amount,
        note: cleanNote || null,
        transferId,
        balanceAfter: unitsToFish(recipientAfter?.driedFish ?? 0),
      });

      return {
        outTxId: outTx.txId,
        inTxId: inTx.txId,
        balance: unitsToFish(after?.driedFish ?? 0),
        deliveryId,
      };
    }).catch(async (e: unknown) => {
      // 并发同键：另一个请求已经登记了同一个键（唯一约束把这一笔挡下）。这不是故障 ——
      // 回读那条记录按「重放」处理（已生效就如实回报）。
      // 只有调用方给了键才可能走到这里；没给键时键是随机的，撞不上。
      if (clientKey && isUniqueViolation(e)) {
        const row = await findIdempotency(idempotencyKey);
        if (row) {
          throw new TransferDuplicateError(await resolveDuplicate(row, expected, transferId));
        }
      }
      throw e;
    });

    // 回调（站外商户）：**事务提交之后**才发，且**不 await** ——
    // 商户的 HTTP 延迟不该记在付款人的账上。定时 drainer 才是保证（它只捞超过
    // 宽限期的 pending），这一下只是把正常路径的延迟从「最多 30 秒」压到亚秒级。
    // 吞异常：投递失败的收敛归 drainer，绝不能让它冒泡回去把一笔**已经成交**的
    // 转账变成 500（同顶栏推送那条纪律）。
    if (applied.deliveryId) {
      void deliverWebhook(applied.deliveryId).catch(() => {
        /* 交给 drainer 重试 */
      });
    }

    // 通知接收者：**在事务提交之后**发（钱已经记完，不能因通知失败而退回）。
    // 无对应偏好开关（同「文章投喂」「讨论提及」），显式声明不受偏好拦截。
    try {
      await sendNotification({
        recipientId: recipient.id,
        action: '鱼干转账',
        actorId: fromUserId,
        detail: cleanNote
          ? `${sender.username} 给你转了 ${amount} 条小鱼干：${cleanNote}`
          : `${sender.username} 给你转了 ${amount} 条小鱼干`,
        prefKey: null,
      });
    } catch (notifyErr) {
      console.warn(
        `[fish-market] 转账成功但通知接收者失败（不影响转账结果）` +
          `（from=${fromUserId} to=${recipient.id}）:`,
        notifyErr
      );
    }

    return { ok: true, amount, balance: applied.balance, recipient, transferId };
  } catch (e) {
    if (e instanceof TransferDuplicateError) {
      // 并发撞键：本地写入已被唯一约束挡回（事务整体回滚），返回重放结果。
      return e.outcome;
    }
    if (e instanceof InsufficientFishError) {
      // 余额不足是**业务结果**，不是故障 —— 内核在事务里抛出时，整笔转账已整体回滚。
      return { ok: false, code: 400, message: '小鱼干不足' };
    }
    // 兜底：意外异常按 500 处理（没有远端了，本地事务失败就是真故障）。
    console.error(
      `[fish-market] 转账异常（from=${fromUserId} to=${recipient.id} amount=${amount}）:`,
      e
    );
    throw e;
  }
}
