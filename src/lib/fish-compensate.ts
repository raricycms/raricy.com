// ─────────────────────────────────────────────────────────────────────────────
// fish-compensate.ts —— 群发补偿（CLI `fish compensate`）
//
// 发放对象是**全部 core+ 用户**（不是全站注册用户）——理由见 eligibleUsers 的注释。
//
// 【逐人一笔事务，不是一个大批次】
//   每位用户独立走一次 grantFishWithKey：一个本地事务里加余额 + 写流水 +（有键时）登记。
//   于是**不再是全有或全无**：中途失败 =「前 N 位已发放、后面的没发」，续跑接着发。
//   这个形状是刻意的，与当年的远端无关：一锤子的大事务要么全成要么全败，拿不到
//   「发到哪了」，也就没有续跑可言；而且它会把 SQLite 写锁一次性占满整批
//   （上千人的写入，期间全站写路径排队等锁）。
//   （历史：那时逐人结构还有一条理由是「远端 HTTP 不能进 SQLite 事务」。账户服务
//   搬进站内之后那条约束消失了，逐人的形状仍然保留，理由如上。）
//
// 【续跑靠幂等键，而不是靠整体回滚】
//   键由批次派生：comp-{sha256('compensate-{batchId}-{userId}-{amount}')[:16]} ——
//   **算法与旧版逐字节相同**（所以迁移前用某个 batchId 只跑了一半的批次，现在拿同一个
//   batchId 就能接着跑）。同一个 --batch-id 重跑时：
//     • 该键已登记（新行一律 synced）→ 跳过（已经发过了，不能再发一次）；
//     • 该键停在 pending / failed → 不动，记进 blocked（见下）；
//     • 没有该行 → 正常发放。
//   这一条是必须的：若只是「重跑一遍」，会给已发放过的人再加一次余额。
//
// 【blocked：只剩迁移前遗留的行会命中】
//   新写入的登记行**一律是 synced**（登记与发放同事务提交，提交成功就是已生效），
//   所以 blocked 里只可能是**迁移前**留下的非 synced 行（当年停在 pending / failed
//   的那些）—— 那是「本地已提交、远端账户服务那半笔状态不明」的欠账。命中它的用户
//   **必须挡住重发**（重发会在本地实打实地叠加一笔），正确动作是人工查证。
//   代码里没有、也不该有自动重放这些行的命令。
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, createHash } from 'node:crypto';
import { prisma } from './db';
import { findIdempotency } from './fish-idempotency';
import { FishBusinessError, grantFishWithKey } from './fish-admin';

/** 单条幂等登记行在本批次里的处境。非 synced 的状态只可能来自迁移前的遗留行。 */
type LedgerStatus = 'new' | 'done' | 'pending' | 'failed';

export interface CompensateOptions {
  amount: number;
  description?: string;
  /** 批次 ID。由调用方生成（makeBatchId）—— 它要在开跑前就打印出来，见 CLI 的用法。 */
  batchId: string;
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
  /** 登记行不是 synced（迁移前的遗留行，本地已提交、当年远端那半笔状态不明），须人工查证。 */
  blocked: { username: string; status: string }[];
  failed: CompensateFailure[];
  dryRun: boolean;
}

/** 新批次 ID：12 位 hex（48 位随机，够防撞，也够短好抄给人）。 */
export function makeBatchId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 补偿的幂等键：`comp-{sha256('compensate-{batchId}-{userId}-{amount}')[:16]}`。
 *
 * 派生算法**逐字节照旧版**，刻意保留：当年用某个 batchId 只跑了一半的批次，
 * 这里传同一个 batchId 就能接着跑（键对上 = 认得是同一笔）。
 *
 * 之所以走哈希短键而不是可读拼接：幂等键的长度口径是历史定下的（≤64 字符、仅
 * [a-zA-Z0-9_-]，当年要发给账户服务），而 userId(36) + batchId + amount 拼起来就超了
 * （同 feed 密钥的处境）。
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
 * 该键的登记状态。
 *
 * 按唯一索引**点查**，不按批次扫全表 —— 键里那 16 位哈希把批次信息摊平了，
 * 从键本身认不出批次（这正是沿用旧版算法的代价）。每位用户一次点查。
 */
async function ledgerStatus(idempotencyKey: string): Promise<LedgerStatus> {
  const row = await findIdempotency(idempotencyKey);
  if (!row) return 'new';
  if (row.status === 'synced') return 'done';
  return row.status === 'failed' ? 'failed' : 'pending';
}

/**
 * 补偿的发放对象：**只发 core+**（core / admin / owner）。
 *
 * 【为什么不是全站】鱼干是 core+ 体系的报酬 —— 站内全部赚取渠道（签到翻牌、投喂
 * 分成）都在 core 门槛之后，非认证账号拿到鱼干也没有出口（发文章、投喂、投票都要
 * core+）。给全站空投等于把它变成「注册就有鱼干」，与这套口径直接冲突；而且它
 * 一次改的是全站余额，多发的人越多，回滚成本越高。
 *
 * 【为什么不排除被禁言者】补偿是系统行为，与个人当前状态无关 ——
 * 禁言只停发言权，不没收财产。
 *
 * ⚠️ 角色是**当前**角色：曾经是 core、后来被降回 user 的账号会被跳过。补偿不是
 * 结算历史欠账，是「现在这批人每人发多少」，所以按当前角色取人是正确的口径。
 */
const COMPENSATE_ROLES = ['core', 'admin', 'owner'] as const;

async function eligibleUsers(): Promise<{ id: string; username: string }[]> {
  return prisma.user.findMany({
    where: { role: { in: [...COMPENSATE_ROLES] } },
    select: { id: true, username: true },
    orderBy: { createdAt: 'asc' },
  });
}

export interface CompensatePlan {
  total: number;
  /** 传入 batchId 时才有意义：该批次已发放成功、续跑会跳过的位数。 */
  alreadyDone: number;
  /** 传入 batchId 时才有意义：登记行不是 synced（迁移前遗留）、须人工查证的位数。 */
  blocked: number;
  amount: number;
  totalFish: number;
}

/**
 * 只读预检：给「即将执行」确认屏用。**不写库**。
 * 传了 batchId 就顺带算出续跑时会跳过多少位、有多少位卡在迁移前的遗留行里。
 */
export async function planCompensation(opts: {
  amount: number;
  batchId?: string;
}): Promise<CompensatePlan> {
  const users = await eligibleUsers();

  let alreadyDone = 0;
  let blocked = 0;
  if (opts.batchId) {
    for (const u of users) {
      const s = await ledgerStatus(compensateIdempotencyKey(opts.batchId, u.id, opts.amount));
      if (s === 'done') alreadyDone++;
      else if (s !== 'new') blocked++;
    }
  }

  return {
    total: users.length,
    alreadyDone,
    blocked,
    amount: opts.amount,
    totalFish: opts.amount * users.length,
  };
}

/**
 * 给全部 core+ 用户每人发放 `amount` 小鱼干（逐人一笔事务）。
 *
 * 单用户失败不会影响其他人 —— 失败者的那笔事务整体回滚（余额与流水一起没写入），
 * 续跑用同一个 batchId 即可（他不会留下登记行，所以会被重新尝试）。
 *
 * @throws FishBusinessError 参数非法
 */
export async function compensateAllUsers(opts: CompensateOptions): Promise<CompensateResult> {
  const { amount, batchId } = opts;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new FishBusinessError('amount 必须为正整数');
  }
  const description = opts.description ?? '系统补偿';

  const users = await eligibleUsers();

  const result: CompensateResult = {
    batchId,
    total: users.length,
    succeeded: 0,
    skipped: 0,
    blocked: [],
    failed: [],
    dryRun: !!opts.dryRun,
  };

  if (opts.dryRun || users.length === 0) return result;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const idempotencyKey = compensateIdempotencyKey(batchId, u.id, amount);
    const seen = await ledgerStatus(idempotencyKey);

    if (seen === 'done') {
      result.skipped++;
    } else if (seen !== 'new') {
      // 迁移前遗留的非 synced 行（当年本地已提交、远端那半笔状态不明）。
      // 绝不能在这里再发一笔 —— 那会在本地实打实叠加，而当年远端到底落地没有
      // 无从得知。记进 blocked，等人工查证。
      result.blocked.push({ username: u.username, status: seen });
    } else {
      try {
        // 传键 → 登记与发放同事务提交，于是「续跑跳过已发放的人」由事务本身保证。
        await grantFishWithKey({
          userId: u.id,
          amount,
          description,
          operation: 'compensate',
          idempotencyKey,
        });
        result.succeeded++;
      } catch (e) {
        result.failed.push({
          username: u.username,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    opts.onProgress?.(i + 1, users.length, u.username);
  }

  return result;
}
