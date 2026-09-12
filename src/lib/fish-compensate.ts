// ─────────────────────────────────────────────────────────────────────────────
// fish-compensate.ts —— 全站群发补偿（CLI `fish compensate`）
//
// 【与 Flask 版的关系：有意偏离】
// Flask `flask fish compensate` 的结构是「一个大事务里给所有人 add_fish（不 commit）
// → 逐个调远端 → 全成功才 commit，任一失败整体 rollback」。那个结构把远端 HTTP 放进了
// SQLite 事务内部：写锁被占用 N × (1/rate) 秒（1000 人 @5req/s = 200 秒），这期间全站
// 写路径全部 database is locked；而且「远端已成功、本地 commit 失败」会造成无法察觉的
// 分叉 —— 正是 fail-closed 要防的反面。CLAUDE.md「鱼干写路径」明令禁止，故本移植版
// **不照搬那个结构**。
//
// 【本版语义：逐人原子】
// 每位用户走一次 grantFishWithKey 的三段结构（本地事务提交 → 事务外远端同步 →
// 失败补偿），写锁只占单人的一瞬。代价是**不再是全有或全无**：中途失败 =
// 「前 N 位已发放、后面的没发」。
//
// 【续跑靠幂等键，而不是靠整体回滚】
// 键由批次派生：comp-{sha256('compensate-{batchId}-{userId}-{amount}')[:16]} ——
// 与 Flask **逐字节同构**（所以哪怕某个批次是迁移前在 Flask 上跑了一半，这里用同一个
// batchId 续跑，远端照样按同一个键去重）。同一个 --batch-id 重跑时：
//   • 账本里该键已是 synced → 跳过（已经发过了，不能再发一次）；
//   • 该键是 pending / failed → 不动，提示先跑 `fish sync-retry`；
//   • 没有该行 → 正常发放。
// 这一条是必须的：若只是「重跑一遍」，本地会给已成功的人再加一次余额，而远端被幂等
// 去重不会加 —— 两边记账当场分叉，正是 fail-closed 想杜绝的事。
//
// ⚠️ dev fallback（未配 ACCOUNT_SERVICE）下远端开关为假，本地写入**不登记账本行**，
//    于是续跑去重失效（会重复发放）。生产环境由 assertRemoteRequiredInProduction
//    直接拒绝执行，所以这条只影响开发。
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, createHash } from 'node:crypto';
import { prisma } from './db';
import {
  accountServiceEnabled,
  assertRemoteRequiredInProduction,
  AccountServiceError,
} from './account-client';
import { FishBusinessError, grantFishWithKey } from './fish-admin';

/** 远端同步速率（req/s）。对齐 Flask 的 `--rate` 默认值。 */
export const DEFAULT_COMPENSATE_RATE = 5;

/**
 * 连续失败到这个数就中止整批。
 * 远端整体不可用（进程挂了 / 网络断了）时硬撑下去，只会把剩下所有人挨个刷成失败，
 * 还要多跑几十分钟 —— 不如早停，让运维用同一个批次 ID 续跑。
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** 单条账本行在本批次里的处境。 */
type LedgerStatus = 'new' | 'done' | 'pending' | 'failed';

export interface CompensateOptions {
  amount: number;
  description?: string;
  /** 批次 ID。由调用方生成（makeBatchId）—— 它要在开跑前就打印出来，见 CLI 的用法。 */
  batchId: string;
  rate?: number;
  dryRun?: boolean;
  /** 每位用户处理完（无论什么结局）回调一次，供 CLI 打进度。 */
  onProgress?: (done: number, total: number, username: string) => void;
}

export interface CompensateFailure {
  username: string;
  reason: string;
}

export interface CompensateResult {
  batchId: string;
  total: number;
  succeeded: number;
  /** 本批次此前已发放、本次跳过（续跑时正常现象）。 */
  skipped: number;
  /** 账本里有 pending / failed 行 —— 本地已提交但远端没落地，须先 fish sync-retry。 */
  blocked: { username: string; status: string }[];
  failed: CompensateFailure[];
  aborted: boolean;
  abortReason?: string;
  dryRun: boolean;
  /** 本次是否真的打了远端（dev fallback 下为 false，别对运维说「已同步」）。 */
  remoteSynced: boolean;
}

/** 新批次 ID：12 位 hex，对齐 Flask 的 `uuid.uuid4().hex[:12]`。 */
export function makeBatchId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 补偿的幂等键：`comp-{sha256('compensate-{batchId}-{userId}-{amount}')[:16]}`。
 *
 * 与 Flask `flask fish compensate` 的算法**逐字节同构**，刻意保留：
 * 迁移前用某个 batchId 在 Flask 上跑了一半的批次，这里传同一个 batchId 就能接着跑，
 * 远端按同一个键去重。
 *
 * 之所以走哈希短键而不是可读拼接：账户服务要求幂等键 1–64 字符且仅 [a-zA-Z0-9_-]，
 * 而 userId(36) + batchId + amount 拼起来就超了（同 feed 的 _make_feed_idempotency_key 处境）。
 */
export function compensateIdempotencyKey(
  batchId: string,
  userId: string,
  amount: number
): string {
  const hash = createHash('sha256')
    .update(`compensate-${batchId}-${userId}-${amount}`)
    .digest('hex');
  return `comp-${hash.slice(0, 16)}`;
}

/**
 * 该键在账本里的状态。
 *
 * 按唯一索引**点查**，不按批次扫全表 —— 键里那 16 位哈希把批次信息摊平了，
 * 从键本身认不出批次（这正是与 Flask 同构的代价）。每位用户一次点查，
 * 相对后面那次远端 HTTP 可以忽略不计。
 */
async function ledgerStatus(idempotencyKey: string): Promise<LedgerStatus> {
  const row = await prisma.accountSyncLedger.findUnique({
    where: { idempotencyKey },
    select: { status: true },
  });
  if (!row) return 'new';
  if (row.status === 'synced') return 'done';
  return row.status === 'failed' ? 'failed' : 'pending';
}

/** 全站用户（含被禁言者 —— 补偿是系统行为，与个人状态无关，对齐 Flask）。 */
async function allUsers(): Promise<{ id: string; username: string }[]> {
  return prisma.user.findMany({
    select: { id: true, username: true },
    orderBy: { createdAt: 'asc' },
  });
}

export interface CompensatePlan {
  total: number;
  /** 传入 batchId 时才有意义：该批次已发放成功、续跑会跳过的位数。 */
  alreadyDone: number;
  /** 传入 batchId 时才有意义：账本里 pending/failed、须先 sync-retry 的位数。 */
  blocked: number;
  amount: number;
  totalFish: number;
  rate: number;
  /** 预计耗时（毫秒）：每位实际打远端的用户之间 sleep 1/rate 秒。 */
  estimatedMs: number;
}

/**
 * 只读预检：给「即将执行」确认屏用。**不写库**。
 * 传了 batchId 就顺带算出续跑时会跳过多少位、有多少位卡在账本里。
 */
export async function planCompensation(opts: {
  amount: number;
  batchId?: string;
  rate?: number;
}): Promise<CompensatePlan> {
  const rate = opts.rate ?? DEFAULT_COMPENSATE_RATE;
  const users = await allUsers();

  let alreadyDone = 0;
  let blocked = 0;
  if (opts.batchId) {
    for (const u of users) {
      const s = await ledgerStatus(compensateIdempotencyKey(opts.batchId, u.id, opts.amount));
      if (s === 'done') alreadyDone++;
      else if (s !== 'new') blocked++;
    }
  }

  const pending = users.length - alreadyDone - blocked;
  return {
    total: users.length,
    alreadyDone,
    blocked,
    amount: opts.amount,
    totalFish: opts.amount * users.length,
    rate,
    // 首位不发请求，之后每位实际打远端的最多间隔 1/rate 秒。
    estimatedMs: users.length <= 1 ? 0 : Math.max(0, pending - 1) * (1000 / rate),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 给全站用户每人发放 `amount` 小鱼干（逐人原子，fail-closed）。
 *
 * 单用户失败不会回滚其他人 —— 失败者的本地写入已被各自的补偿事务精确撤销
 * （对那位用户等价于没发生），续跑用同一个 batchId 即可。
 *
 * @throws FishBusinessError 参数非法
 */
export async function compensateAllUsers(opts: CompensateOptions): Promise<CompensateResult> {
  const { amount, batchId } = opts;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
  const rate = opts.rate ?? DEFAULT_COMPENSATE_RATE;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new FishBusinessError('rate 必须为正数');
  }
  const description = opts.description ?? '系统补偿';

  const users = await allUsers();
  const remoteEnabled = accountServiceEnabled();

  const result: CompensateResult = {
    batchId,
    total: users.length,
    succeeded: 0,
    skipped: 0,
    blocked: [],
    failed: [],
    aborted: false,
    dryRun: !!opts.dryRun,
    remoteSynced: remoteEnabled,
  };

  if (opts.dryRun || users.length === 0) return result;

  if (!remoteEnabled) {
    assertRemoteRequiredInProduction('全站补偿');
    console.warn(
      `[fish-compensate] ACCOUNT_SERVICE 未配置，补偿仅写本地库（dev fallback，续跑去重失效）。batch=${batchId}`
    );
  }

  const intervalMs = 1000 / rate;
  // 只在实际打远端之前限频：续跑时大量用户是「跳过」，不该为它们白等。
  let remoteCalls = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const idempotencyKey = compensateIdempotencyKey(batchId, u.id, amount);
    const seen = await ledgerStatus(idempotencyKey);
    let abortNow: string | null = null;

    if (seen === 'done') {
      result.skipped++;
    } else if (seen !== 'new') {
      // 本地已提交、远端没落地（或补偿也失败）。正确动作是 fish sync-retry，
      // 不是再发一笔 —— 再发一笔会在本地叠加，而远端按同键去重不会加。
      result.blocked.push({ username: u.username, status: seen });
    } else {
      if (remoteCalls > 0) await sleep(intervalMs);
      remoteCalls++;
      try {
        await grantFishWithKey({
          userId: u.id,
          amount,
          description,
          idempotencyKey,
          operation: 'compensate',
          remoteEnabled,
        });
        result.succeeded++;
        consecutiveFailures = 0;
      } catch (e) {
        result.failed.push({
          username: u.username,
          reason: e instanceof Error ? e.message : String(e),
        });
        consecutiveFailures++;
        if (e instanceof AccountServiceError && e.status === 429) {
          abortNow = '远端返回 429（限频）';
        } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          abortNow = `连续 ${consecutiveFailures} 位失败，判定远端账户服务整体不可用`;
        }
      }
    }

    opts.onProgress?.(i + 1, users.length, u.username);

    if (abortNow) {
      result.aborted = true;
      result.abortReason = abortNow;
      break;
    }
  }

  return result;
}
