// ─────────────────────────────────────────────────────────────────────────────
// fish-market-service.ts — 鱼干市场：用户间转账（无手续费）
//
// ★★★ 写路径 fail-closed（CLAUDE.md「鱼干写路径」）★★★
//   与另外四条（投喂 / 签到翻牌 / CLI grant|deduct / 注册建号）同构：
//   Tx A：扣发送者 / 加接收者 / 两条流水 + 账本行 pending ──→ 提交；
//   随后在**事务外**调用账户微服务（幂等键发往远端）。
//   远端成功 → 账本标 synced；远端失败 → 补偿事务精确撤销本地写入（对用户等价于
//   「回滚 + 503」）。HTTP 绝不进 SQLite 事务 —— 写锁会被占满整个超时，
//   并发写直接 "database is locked"（机制详见 src/lib/fish-sync.ts 头部）。
//
// 【与投喂的结构差异】转账只有**一次**远端调用，没有 feed 那种「Step1 成功、
//   Step2 失败 → 远端退款」的中间态，因此不要照抄那套退款逻辑：对一笔可能根本
//   没成交的转账发起退款，等于凭退款凭空造出一笔钱。
//
// 【已知限制：超时歧义的二次成交窗口】远端已成交但响应丢失（超时）时，本地补偿会
//   删除账本行，用户重试拿到**新键**，于是远端可能被扣两次。这与 admin_grant 同性质
//   （键都带随机后缀，见 fish-admin.makeAdminIdempotencyKey），是「每次操作都是独立
//   新键」的固有代价；只有远端返回的 4xx 能确定「绝对没成交」，5xx/超时都不行。
//   失败时按 key 打一条结构化 warn（FISH_TRANSFER_SYNC_FAILED），供运维去账户服务
//   按 key 查证。
//
// 【金额口径】业务单位「鱼干」，最多 1 位小数（0.1 起）—— fishToUnits 在数据库边界
//   换成 0.1 鱼干单位的整数，超精度 fail-loud（这里转成 400 文案，别让它冒泡成 503）。
//
// 【权限档位】登录 + 非禁言，**不要求 core+** —— 与 /fish 面板、签到同一档
//   （投喂要求 core+ 是因为它挂在博客页；转账是鱼干的通用能力）。
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { addFish } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { sendNotification } from './notification-service';
import { rateLimit, RULES } from './rate-limit';
import {
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  decryptApiKey,
  makeClientIdempotencyKey,
  makeTransferIdempotencyKey,
  AccountServiceError,
} from './account-client';
import { isServiceAccount, SERVICE_QUOTA } from './service-accounts';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
  type PendingSyncEntry,
} from './fish-sync';
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
      /** true = 客户端幂等键命中同一笔已成交的转账，本次**没有**再转账。 */
      duplicated?: boolean;
    }
  | { ok: false; code: number; message: string };

/** 客户端幂等键的字面量口径（路由与文档同款）：1-48 位，禁空格与 URL 特殊字符。 */
export const CLIENT_KEY_RE = /^[A-Za-z0-9_.:-]{1,48}$/;

/** Prisma 唯一约束冲突（账本键撞车时用它区分「并发同键」与真故障）。 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === 'P2002'
  );
}

/**
 * 客户端幂等键命中**已有账本行**时的处理。三种局面各有各的对：
 *   · 参数一致且已成交 → 原样回报（`duplicated: true`），一分钱都不再动；
 *   · 参数不一致 → 409（同键换个参数是调用方的 bug，静默改单更糟）；
 *   · 尚未成交（pending / failed）→ 409，让调用方稍后**用同一个键**重试
 *     （远端同步由账本 + sync-retry 收敛，重试同一个键是安全的）。
 */
async function resolveDuplicate(
  row: { payload: string; status: string },
  expected: { fromUserId: string; toUserId: string; amount: number; description: string }
): Promise<TransferOutcome> {
  let payload: { toUserId?: string; amount?: number; description?: string } = {};
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    /* 账本 payload 损坏：当作参数不一致处理，宁可 409 也不冒重复转账的险 */
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
        duplicated: true,
      };
    }
  }
  return {
    ok: false,
    code: 409,
    message: '该幂等键的上一笔仍在处理中，请稍后用同一个键重试',
  };
}

/**
 * 搜索转账收款人：任意用户（**不限 core+** —— 鱼干可以转给任何人），排除自己。
 * query 为空时返回最近注册的一批。按 username 匹配，返回分页总数供弹窗算页数。
 *
 * 与 chat-service.searchCoreUsers 同形，差异只在「不筛 role」：聊天是 core+ 专属，
 * 转账不是。若将来聊天那边改了筛选口径，别顺手把这里也改过去。
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
 * 用户间转账：发送者扣 amount、接收者得 amount，零手续费，一次远端调用。
 *
 * 【幂等键】`opts.clientIdempotencyKey` 由调用方提供（站外脚本 / 收银台）时：
 * 同一个键 + **同样的收款人/金额/留言** 重发 = 返回原结果、绝不重复转账；
 * 同一个键配不同的参数 = 409（不静默改单）；上一笔还在处理中 = 409（可稍后用同键重试）。
 * 不提供时由服务端生成随机键 —— 此时**重试就是再转一笔**（见 docs/fish-bot.md §6）。
 *
 * @param note 可选留言（同一句话进双方流水的描述与远端记账的 description）
 * @param opts.clientIdempotencyKey ≤48 位，`[A-Za-z0-9_.:-]`
 * @returns 业务结果；远端同步失败**抛** AccountServiceError（本地已被补偿回滚）
 * @throws AccountServiceError 远端账户服务不可达 / 同步失败 → 路由据此返回 503
 */
export async function transferFish(
  fromUserId: string,
  toUserId: string,
  amount: number,
  note?: string | null,
  opts?: { clientIdempotencyKey?: string | null }
): Promise<TransferOutcome> {
  // ── 入参校验（不写库、不打远端）──────────────────────────────────────────
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 400, message: '转账金额需大于 0' };
  }
  let units: number;
  try {
    units = fishToUnits(amount);
  } catch {
    // fishToUnits 对 >1 位小数 fail-loud（抛的是普通 Error）。不在这里接住转成 400，
    // 它会冒泡到最外层被包成 AccountServiceError(503) —— 用户输入 0.05 收到
    // 「鱼干服务暂不可用」，且前端不知道该提示什么。
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
    select: { username: true, fishApiKeyEncrypted: true },
  });
  if (!sender) return { ok: false, code: 404, message: '用户不存在' };

  // 远端同步是否启用（未配置 internal token → dev 本地模式）。
  const remoteEnabled = accountServiceEnabled();
  if (!remoteEnabled) {
    // 生产 fail-closed：不做任何本地写入直接拒绝；dev 仅本地 + 告警。
    assertRemoteRequiredInProduction('转账');
    console.warn(
      `[fish-market] ACCOUNT_SERVICE 未配置，转账仅写本地库（dev fallback）。` +
        ` from=${fromUserId} to=${recipient.id} amount=${amount}`
    );
  } else if (!sender.fishApiKeyEncrypted) {
    throw new AccountServiceError('发送者没有关联的账户 Key，无法完成远端结算', 503);
  } else {
    // fail-fast：先解出 Key，解不开即 503（不做任何本地写入）。明文只用于本次校验；
    // 密钥绝不进 payload / 账本，重放时由 executeSync 按 userId 重新解密。
    decryptApiKey(sender.fishApiKeyEncrypted);
  }

  const description = cleanNote
    ? `转给「${recipient.username}」：${cleanNote}`
    : `转给「${recipient.username}」`;

  // 幂等键**只算一次**，Phase 1/2/3 共用 —— 别像 feed 那样在 Phase 2 把表达式重抄
  // 一遍（那里靠参数相同才碰巧一致，抄错一处就是静默的幂等失效）。
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

  // 调用方给了键 → 先看账本里有没有同一笔：有就按「重放」处理，绝不重复转账。
  // 放在限频**之前**：重放请求不该消耗额度（调用方遇到超时就该用同键重试）。
  const expected = { fromUserId, toUserId: recipient.id, amount, description };
  if (clientKey) {
    const existing = await prisma.accountSyncLedger.findUnique({ where: { idempotencyKey } });
    if (existing) return resolveDuplicate(existing, expected);
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

  const entry: PendingSyncEntry = {
    idempotencyKey,
    operation: 'transfer',
    payload: { fromUserId, toUserId: recipient.id, amount, description },
  };

  // 业务错误容器：事务回调里抛出后在外层转成 TransferOutcome（不当作 500）。
  class TransferBusinessError extends Error {
    constructor(
      public code: number,
      message: string
    ) {
      super(message);
    }
  }

  // 并发撞键的载体：Phase 1 撞上账本唯一约束时，把「重放的结果」原样带回外层。
  class TransferDuplicateError extends Error {
    constructor(public outcome: TransferOutcome) {
      super('duplicate idempotency key');
    }
  }

  try {
    // ── Phase 1：本地事务（纯 DB，无远端 IO —— 写锁只持有毫秒级）────────────────
    const phase1 = await prisma.$transaction(async (tx) => {
      // 1.1 原子条件扣减（单条 UPDATE 里带谓词，防超扣 / 防负数）。
      const dec = await tx.user.updateMany({
        where: { id: fromUserId, driedFish: { gte: units } },
        data: { driedFish: { decrement: units } },
      });
      if (dec.count === 0) throw new TransferBusinessError(400, '小鱼干不足');

      // 1.2 发送者支出流水。手写 create（不是 addFish —— 那是「加钱」的口径），
      //     createdAt 必须显式写：schema 里没有 @default(now())，漏写整条流水时间为
      //     NULL，流水倒序会乱、按区间的统计会静默失效。
      const outTx = await tx.fishTransaction.create({
        data: {
          userId: fromUserId,
          amount: -units,
          type: TRANSFER_OUT_TYPE,
          description,
          referenceType: 'user',
          referenceId: recipient.id,
          relatedUserId: recipient.id,
          createdAt: nowForDb(),
        },
        select: { id: true },
      });

      // 1.3 接收者入账（addFish：加余额 + transfer_receive 流水 + 显式 createdAt）。
      //     接收者侧不需要条件写 —— increment 不可能变负。
      const inTx = await addFish(tx, {
        userId: recipient.id,
        amount,
        type: TRANSFER_IN_TYPE,
        description: cleanNote
          ? `收到「${sender.username}」的转账：${cleanNote}`
          : `收到「${sender.username}」的转账`,
        referenceType: 'user',
        referenceId: fromUserId,
        relatedUserId: fromUserId,
      });

      // 1.4 账本登记 pending（与业务写入同事务提交；dev fallback 不登记 —— 登记了
      //     就是一堆永远同步不出去的 pending，把 fish pending / sync-retry 的语义搞浑）。
      if (remoteEnabled) await recordPendingSync(tx, entry);

      // 读回最新余额（仍在事务中，故为本事务可见的最新状态）
      const after = await tx.user.findUnique({
        where: { id: fromUserId },
        select: { driedFish: true },
      });
      return {
        outTxId: outTx.id,
        inTxId: inTx.txId,
        balance: unitsToFish(after?.driedFish ?? 0),
      };
    }).catch(async (e: unknown) => {
      // 并发同键：另一个请求已经建好了账本行（唯一约束把这一笔挡下）。这不是故障 ——
      // 回读那一行按「重放」处理（已成交就如实回报，未成交就让它稍后重试）。
      // 只有调用方给了键才可能走到这里；没给键时键是随机的，撞不上。
      if (clientKey && isUniqueViolation(e)) {
        const row = await prisma.accountSyncLedger.findUnique({ where: { idempotencyKey } });
        if (row) {
          throw new TransferDuplicateError(await resolveDuplicate(row, expected));
        }
      }
      throw e;
    });

    // ── Phase 2：事务外远端同步（提交后调用；失败走补偿，不再占用写锁）──────────
    if (remoteEnabled) {
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        // ── Phase 3：远端失败 → 补偿事务精确撤销本地写入（对用户等价于回滚）──
        try {
          await prisma.$transaction(async (tx) => {
            // 3.1 删除两条流水（按 id 精确撤销，不是按 user/type 模糊删）
            await tx.fishTransaction.deleteMany({
              where: { id: { in: [phase1.outTxId, phase1.inTxId] } },
            });
            // 3.2 接收者退回 —— 条件写：他可能已经把收到的鱼干花掉了。
            //     退不动就抛：整个补偿事务回滚（**绝不部分撤销** —— 那会造出
            //     「发送者拿回钱、接收者没被扣」的凭空多出来的鱼干），交给账本
            //     failed + sync-retry 正向重放收敛。与 feed-service 的作者分成回退同款。
            //     【链式追索出界】接收者可能已把鱼干转给第三人，那笔已在远端成交；
            //     撤销的上界就是本笔的双方账户 + 账本行，超出部分归对账，
            //     别试图写递归撤销。
            const dec = await tx.user.updateMany({
              where: { id: recipient.id, driedFish: { gte: units } },
              data: { driedFish: { decrement: units } },
            });
            if (dec.count === 0) {
              throw new Error(
                `接收者余额不足以退回（to=${recipient.id} amount=${amount}）`
              );
            }
            // 3.3 发送者拿回 —— 无条件 increment。Tx A 后他的余额是 B-u，之后最多
            //     再花掉 B-u，所以退回后 = B-u-s+u = B-s ≥ 0，数学上不可能变负。
            //     别「为了对称」也加条件：那会在发送者刚好花光时误判补偿失败，
            //     把一个本可自愈的局面推进 reconcile。
            await tx.user.update({
              where: { id: fromUserId },
              data: { driedFish: { increment: units } },
            });
            // 3.4 删除账本行：释放幂等键，用户重试时可以重建（无痕失败）。
            await tx.accountSyncLedger.deleteMany({
              where: { idempotencyKey: entry.idempotencyKey },
            });
          });
        } catch (undoErr) {
          // 补偿也失败：账本行留 pending/failed，sync-retry 可幂等重放收敛。
          await settleSync(entry.idempotencyKey, 'failed', String(undoErr)).catch(() => {
            /* 尽力而为 */
          });
          await logReconcileRequired(entry, undoErr);
        }
        // 超时歧义取证（见文件头「已知限制」）：远端可能已成交但响应丢了，
        // 用户重试会拿新键 → 远端二次成交。单行结构化 JSON，便于按 key 去远端查证。
        console.warn(
          'FISH_TRANSFER_SYNC_FAILED ' +
            JSON.stringify({
              fromUserId,
              toUserId: recipient.id,
              amount,
              idempotencyKey: entry.idempotencyKey,
              error: syncErr instanceof Error ? syncErr.message : String(syncErr),
              hint: '若远端实际已记账，用户重试会再记一笔；可按 idempotencyKey 去账户服务核对',
            })
        );
        throw syncErr instanceof AccountServiceError
          ? syncErr
          : new AccountServiceError(`转账同步失败: ${String(syncErr)}`, 503);
      }
    }

    // 通知接收者：**在提交与同步之后**发（钱已结算完，不能因通知失败而退回）；
    // 补偿路径绝不发（否则用户收到「有人给你转了钱」但那笔钱已被回滚）。
    // 无对应偏好开关（同「文章投喂」「聊天提及」），显式声明不受偏好拦截。
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

    return { ok: true, amount, balance: phase1.balance, recipient };
  } catch (e) {
    if (e instanceof TransferBusinessError) {
      return { ok: false, code: e.code, message: e.message };
    }
    if (e instanceof TransferDuplicateError) {
      // 并发撞键：本地写入已被唯一约束挡回（事务整体回滚），返回重放结果。
      return e.outcome;
    }
    if (e instanceof AccountServiceError) {
      // 远端失败：本地已被补偿（等价于回滚），向上抛让路由返回 503。
      console.warn(
        `[fish-market] 账户服务转账同步失败，本地写入已补偿回滚` +
          `（from=${fromUserId} to=${recipient.id} amount=${amount}）: ${e.message}`
      );
      throw e;
    }
    // 兜底：意外异常按 fail-closed 处理，包装为 503。
    console.error(
      `[fish-market] 转账异常（from=${fromUserId} to=${recipient.id} amount=${amount}）:`,
      e
    );
    throw new AccountServiceError(`转账失败: ${String(e)}`, 503);
  }
}
