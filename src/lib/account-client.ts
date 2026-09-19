// ─────────────────────────────────────────────────────────────────────────────
// account-client.ts — 小鱼干账户微服务 HTTP 客户端（TS 版）
//
// 覆盖账户服务的全部公开 API，并严格保持
// **fail-closed** 写路径语义（详见 CLAUDE.md「鱼干写路径」 与 feed-service.ts）：
//   远端失败 → 本地写入被补偿事务精确撤销（对用户等价于回滚）→ 上抛明确错误。
//
// ⚠️ 本文件只负责**发 HTTP**，不持有事务 —— 调用方（*fish-sync.ts*）负责
// 「先提交本地 + 登记账本 → 事务外调本文件 → 失败补偿」。**绝不要把这里的
// 调用挪进 SQLite 事务**：写锁会被占满整个 ACCOUNT_SERVICE_TIMEOUT。
//
// 认证：双层 —— X-Internal-Token（服务间共享密钥）+ 用户/系统 API Key。
//   ⚠️ 账户服务实际用 `Authorization: Bearer <api_key>` 传递用户 Key（见其仓库的
//   extract_api_key —— 该服务已拆成独立仓库，本仓 git 历史 7d7be1c
//   之前还在），而**不是** X-Api-Key。
//   本客户端因此沿用 Bearer：传成 X-Api-Key 会被服务端当未认证。
//
// 用户 API Key 以 Fernet 加密存于 User.fishApiKeyEncrypted。解密密钥派生方式
// 与加密存量数据时完全一致（改了旧密文一律解不开）：
//   key = base64url( SHA-256( FISH_ENCRYPTION_KEY || SECRET_KEY ) )   → Fernet
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { openSecret, sealSecret } from './secret-box';

// 博客系统本身也是账户服务里的一个账户（用系统 Key 结算作者分成）。
export const SYSTEM_USER_ID = 'raricy-blog-system';

export interface AccountConfig {
  baseUrl: string;
  internalToken: string;
  systemKey: string;
  timeoutMs: number;
  /** Fernet 密钥来源明文：优先 FISH_ENCRYPTION_KEY，回退 SECRET_KEY（存量密文按此派生，改则解不开）。 */
  encryptionKeySource: string;
}

export function accountConfig(): AccountConfig {
  return {
    baseUrl: process.env.ACCOUNT_SERVICE_URL || 'http://localhost:8000',
    internalToken: process.env.ACCOUNT_SERVICE_INTERNAL_TOKEN || '',
    systemKey: process.env.ACCOUNT_SYSTEM_KEY || '',
    timeoutMs: parseInt(process.env.ACCOUNT_SERVICE_TIMEOUT || '5', 10) * 1000,
    encryptionKeySource: process.env.FISH_ENCRYPTION_KEY || process.env.SECRET_KEY || '',
  };
}

export class AccountServiceError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'AccountServiceError';
  }
}

/** 账户服务是否已配置（未配置时开发环境走本地 dev fallback）。 */
export function accountServiceEnabled(cfg = accountConfig()): boolean {
  return !!cfg.internalToken;
}

/** 并发抢同一个邀请码时，未抢到的一方（用于回滚事务，非系统错误）。 */
export class InviteCodeRaceError extends Error {
  constructor() {
    super('邀请码已被占用');
    this.name = 'InviteCodeRaceError';
  }
}

/**
 * 生产环境下账户服务必须可用 —— 未配置即抛 AccountServiceError(503)。
 *
 * 【为什么需要这道守卫】dev fallback 的本意是「本地没有账户服务时也能把切片跑起来」，
 * 但它在生产是 **fail-OPEN**：一旦漏配 ACCOUNT_SERVICE_INTERNAL_TOKEN，
 * 投喂/注册会静默地只写本地、只留一条 console.warn —— 与鱼干写路径的 fail-closed
 * 意图完全相反，且几乎不会被发现（用户侧一切正常，直到对账时才发现账目对不上）。
 * 故生产环境一律拒绝，让问题在部署时就暴露。
 *
 * @param what 操作名，用于错误日志（如「注册」「投喂」）
 */
export function assertRemoteRequiredInProduction(what: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new AccountServiceError(
      `账户服务未配置（缺少 ACCOUNT_SERVICE_INTERNAL_TOKEN），${what}已中止：` +
        `生产环境不允许跳过远端同步（fail-closed）`,
      503
    );
  }
}

// ── Fernet 解密（SHA-256 派生 → Fernet）───────────────────────────────────
//
// 密码学实现已抽到 src/lib/secret-box.ts（回调的签名密钥也要用同一套派生，
// 抄两份必然 drift）。本文件只保留**自己的错误语义**：把 SecretBoxError 翻成
// AccountServiceError(503)，以维持写路径的 fail-closed 契约 —— 那个 503 是
// 调用方（fish-sync 的补偿事务）判别「这笔没成交」的依据，不能改成别的类型。

/**
 * 解密存于 User.fishApiKeyEncrypted 的用户 API Key。
 * 派生方式（与存量密文一致）：base64url(sha256(keySource)) 作为 Fernet 密钥。
 * 配置缺失或解密失败一律抛 AccountServiceError（503），供写路径 fail-closed。
 */
export function decryptApiKey(encrypted: string, cfg = accountConfig()): string {
  if (!cfg.encryptionKeySource) {
    throw new AccountServiceError('缺少 FISH_ENCRYPTION_KEY / SECRET_KEY，无法解密用户账户 Key', 503);
  }
  try {
    return openSecret(encrypted, cfg.encryptionKeySource);
  } catch (e) {
    if (e instanceof AccountServiceError) throw e;
    throw new AccountServiceError(`用户账户 Key 解密失败: ${String(e)}`, 503);
  }
}

/**
 * 加密账户服务返回的用户 API Key，用于存入 User.fishApiKeyEncrypted。
 * 与 decryptApiKey 完全对称（同一 SHA-256 派生密钥 → Fernet），Python 侧
 * cryptography.Fernet 可直接解密（标准 Fernet 令牌格式，随机 IV）。
 * 配置缺失或加密失败一律抛 AccountServiceError(503)，供注册写路径 fail-closed。
 */
export function encryptApiKey(plain: string, cfg = accountConfig()): string {
  if (!cfg.encryptionKeySource) {
    throw new AccountServiceError('缺少 FISH_ENCRYPTION_KEY / SECRET_KEY，无法加密用户账户 Key', 503);
  }
  try {
    return sealSecret(plain, cfg.encryptionKeySource);
  } catch (e) {
    if (e instanceof AccountServiceError) throw e;
    throw new AccountServiceError(`用户账户 Key 加密失败: ${String(e)}`, 503);
  }
}

/**
 * 生成用户间转账的幂等键（≤64 字符，实测 45）。
 * 格式：transfer-{sha256(from-to-units-nonce)[:16]}-{ts}-{nonce}
 *
 * 【为什么把 id 哈希掉】两个 userId 各 36 字符，原样拼进去是 102 字符，超过账户服务
 * 的 64 字符上限（对照 checkin-{userId}-{date} 只嵌一个 id，55 字符刚好装得下）。
 *
 * 【为什么必须带随机 nonce】秒级时间戳下，同一用户对**同额**的两次转账会得到同一个键，
 * 第二笔会被账户服务当幂等重放**静默去重**：远端只记一笔、本地记两笔，账目无声分叉。
 * 转账是「点一次就是一笔新交易」，每次都必须有自己的键 —— 同
 * fish-admin.makeAdminIdempotencyKey 的理由。
 *
 * @param nonce 随机后缀（randomBytes(4).toString('hex')，8 字符）。同时进哈希输入，
 *              便于按日志里的 nonce 复核。
 */
export function makeTransferIdempotencyKey(
  fromUserId: string,
  toUserId: string,
  units: number,
  nonce: string
): string {
  const short = crypto
    .createHash('sha256')
    .update(`${fromUserId}-${toUserId}-${units}-${nonce}`)
    .digest('hex')
    .slice(0, 16);
  return `transfer-${short}-${Math.floor(Date.now() / 1000)}-${nonce}`;
}

/**
 * 由**调用方提供的**幂等键派生最终键（≤64 字符，实测最大 62）。
 * 格式：xfer-{sha256(fromUserId)[:8]}-{clientKey}
 *
 * 【为什么要混进发送者哈希】客户端键只在调用方自己的命名空间里唯一
 * （`wd-0007` 这种），两个不同的发送者完全可能撞上同一个字符串 ——
 * 而账本的 idempotencyKey 是**全局唯一**的，不混进身份就会互相挡住。
 *
 * 【为什么与自动键分前缀】自动键是 `transfer-…`，这类是 `xfer-…`：
 * 运维 grep 账本时一眼能看出「这笔是调用方给了键」还是「服务端自己生成的」。
 *
 * @param clientKey 调用方提供的键，须已通过 CLIENT_KEY_RE 校验（≤48 字符）
 */
export function makeClientIdempotencyKey(fromUserId: string, clientKey: string): string {
  const short = crypto.createHash('sha256').update(fromUserId).digest('hex').slice(0, 8);
  return `xfer-${short}-${clientKey}`;
}

/**
 * 生成练手盘开仓的幂等键（≤64 字符，实测 43）。
 * 格式：market-{sha256(userId-symbol-units-nonce)[:16]}-{ts}-{nonce}
 *
 * 【为什么把 userId 哈希掉】同 makeTransferIdempotencyKey：一个 userId 就是 36 字符，
 * 原样拼进去会顶到账户服务那条 64 字符上限。
 *
 * 【为什么必须带随机 nonce】这条不是洁癖：同一用户对**同一标的同一金额**买两次是
 * 完全正常的操作（分批建仓）。秒级时间戳下不带 nonce 会让第二笔算出同一个键，
 * 被账户服务当幂等重放**静默去重** —— 远端只扣一笔、本地记两笔，或反过来。
 * 见 makeTransferIdempotencyKey 与 fish-admin.makeAdminIdempotencyKey 的同一理由。
 *
 * 【平仓为什么不复用这条】平仓天然幂等：仓位一旦是 closed，再平就是重放，
 * 由 status 条件写挡住，不需要键（见 market-service.closePosition）。
 */
export function makeMarketIdempotencyKey(
  userId: string,
  symbol: string,
  units: number,
  nonce: string
): string {
  const short = crypto
    .createHash('sha256')
    .update(`${userId}-${symbol}-${units}-${nonce}`)
    .digest('hex')
    .slice(0, 16);
  return `market-${short}-${Math.floor(Date.now() / 1000)}-${nonce}`;
}

/**
 * 生成投喂操作的幂等键（≤64 字符）。
 * 格式：feed-{sha256(blogId-userId-count)[:16]}-{suffix}
 *
 * 派生方式与旧版逐字节相同（**刻意保留**）：迁移前跑了一半的投喂，重跑时会算出
 * 同一个键，远端照样按同键去重。suffix 区分同一笔的各个阶段（sync / consume /
 * income / refund），换算法会让两边记账当场分叉。
 */
export function makeFeedIdempotencyKey(
  blogId: string,
  userId: string,
  count: number,
  suffix: string
): string {
  const short = crypto
    .createHash('sha256')
    .update(`${blogId}-${userId}-${count}`)
    .digest('hex')
    .slice(0, 16);
  return `feed-${short}-${suffix}`;
}

// ── 内部 HTTP 请求 ───────────────────────────────────────────────────────────

interface CallOpts {
  method: string;
  path: string;
  body?: unknown;
  apiKey?: string; // Authorization: Bearer <apiKey>（用户/系统 Key）
  idempotencyKey?: string; // X-Idempotency-Key
}

/**
 * 账户服务响应统一 envelope：{ code, data, message, request_id }。
 * 有 data 字段就取内层（语义等同 data.get('data', data)），没有则原样返回整个 body ——
 * 两种形状都要吃下，别把「没有 data」当成错误。
 */
async function call<T>(opts: CallOpts, cfg = accountConfig()): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Internal-Token': cfg.internalToken,
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

  try {
    const res = await fetch(`${cfg.baseUrl}${opts.path}`, {
      method: opts.method,
      signal: ctrl.signal,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      let msg = `account service ${res.status}`;
      if (payload && typeof payload === 'object' && 'message' in payload) {
        const m = (payload as { message: unknown }).message;
        if (typeof m === 'string' && m) msg = m;
      }
      throw new AccountServiceError(msg, res.status);
    }

    // 解出 envelope 内层 data（若无则返回整体）
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  } catch (e) {
    if (e instanceof AccountServiceError) throw e;
    // 超时 / 网络错误 → 503（写路径据此 fail-closed，向调用方返回明确错误）
    throw new AccountServiceError(`账户服务不可达: ${String(e)}`, 503);
  } finally {
    clearTimeout(timer);
  }
}

// ── 公开 API（对齐 account-service 真实路由）─────────────────────────────────

export interface CreateAccountResult {
  account_id: string;
  user_id: string;
  currency: string;
  balance: number;
  api_key?: string; // 仅首次创建（201）返回
  created_at?: string;
}

export interface BalanceResult {
  user_id: string;
  currency: string;
  balance: number;
  updated_at?: string | null;
  today_checkin?: number | null;
}

export interface TransferResult {
  transaction_id: string;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  currency: string;
  entry_type: string;
  from_balance_after: number;
  to_balance_after: number;
  created_at: string;
}

export interface LedgerResult {
  entries: unknown[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    pages: number;
    has_prev: boolean;
    has_next: boolean;
  };
}

export interface TransferInput {
  fromUserId: string;
  toUserId: string;
  amount: number;
  entryType: string;
  apiKey: string; // 调用方负责解出（系统 Key 或解密后的用户 Key）
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, unknown>;
  currency?: string;
}

export interface FeedTransferInput {
  feederId: string;
  feederApiKey: string; // 已解密的投喂者 Key
  authorId: string;
  amount: number;
  authorIncome: number;
  blogId: string;
  blogTitle: string;
  feederName: string;
  feedSeq: number; // 投喂后累计量（1~5），并入幂等键防重放误判
}

export const accountClient = {
  /** POST /api/v1/accounts — 创建账户（幂等）。首次返回 api_key。 */
  async ensureAccount(userId: string, currency = 'DRIED_FISH'): Promise<CreateAccountResult> {
    return call<CreateAccountResult>({
      method: 'POST',
      path: '/api/v1/accounts',
      body: { user_id: userId, currency },
    });
  },

  /** GET /api/v1/accounts/{userId}/balance — 查询单用户余额（不存在返回 0）。 */
  async getBalance(userId: string, includeTodayCheckin = false): Promise<BalanceResult> {
    const q = includeTodayCheckin ? '?include=today_checkin' : '';
    return call<BalanceResult>({
      method: 'GET',
      path: `/api/v1/accounts/${encodeURIComponent(userId)}/balance${q}`,
    });
  },

  /** POST /api/v1/accounts/balances/batch — 批量余额（最多 100）。 */
  async getBalances(userIds: string[], currency = 'DRIED_FISH'): Promise<Record<string, number>> {
    const data = await call<{ balances: Record<string, number> }>({
      method: 'POST',
      path: '/api/v1/accounts/balances/batch',
      body: { user_ids: userIds.slice(0, 100), currency },
    });
    return data.balances ?? {};
  },

  /**
   * POST /api/v1/transfers — 复式转账（唯一的记账写操作）。
   * 账户服务无独立 grant/deduct 端点，发放/扣减都用系统账户 ↔ 用户账户的转账表达。
   */
  async transfer(input: TransferInput): Promise<TransferResult> {
    return call<TransferResult>({
      method: 'POST',
      path: '/api/v1/transfers',
      apiKey: input.apiKey,
      idempotencyKey: input.idempotencyKey,
      body: {
        from_user_id: input.fromUserId,
        to_user_id: input.toUserId,
        amount: input.amount,
        currency: input.currency ?? 'DRIED_FISH',
        entry_type: input.entryType,
        description: input.description ?? '',
        metadata: input.metadata ?? {},
      },
    });
  },

  /** GET /api/v1/accounts/{userId}/ledger — 分页流水。 */
  async getLedger(
    userId: string,
    page = 1,
    perPage = 20,
    entryType?: string
  ): Promise<LedgerResult> {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (entryType) params.set('entry_type', entryType);
    return call<LedgerResult>({
      method: 'GET',
      path: `/api/v1/accounts/${encodeURIComponent(userId)}/ledger?${params.toString()}`,
    });
  },

  /**
   * 投喂的远端两步转账（fail-closed）：
   *   Step1 投喂者 → 系统（全额，用投喂者 Key）
   *   Step2 系统 → 作者（80% 分成，用系统 Key）
   * Step1 成功但 Step2 失败 → 补偿退款 Step1，使远端回到初始态，再抛出。
   * 任一步失败都会抛 AccountServiceError，交由调用方回滚本地事务。
   */
  async feedTransfer(input: FeedTransferInput, cfg = accountConfig()): Promise<void> {
    // Step 1: 投喂者 → 系统（全额）。失败直接抛出（远端未扣款，本地回滚即一致）。
    await this.transfer({
      fromUserId: input.feederId,
      toUserId: SYSTEM_USER_ID,
      amount: input.amount,
      entryType: 'feed_consume',
      apiKey: input.feederApiKey,
      description: `投喂文章「${input.blogTitle}」`,
      metadata: { blog_id: input.blogId },
      idempotencyKey: makeFeedIdempotencyKey(input.blogId, input.feederId, input.feedSeq, 'consume'),
    });

    // Step 2: 系统 → 作者（80% 分成，用系统 Key）。
    try {
      await this.transfer({
        fromUserId: SYSTEM_USER_ID,
        toUserId: input.authorId,
        amount: input.authorIncome,
        entryType: 'feed_income',
        apiKey: cfg.systemKey,
        description: `投喂文章「${input.blogTitle}」分成`,
        metadata: {
          blog_id: input.blogId,
          feeder_id: input.feederId,
          feeder_name: input.feederName,
        },
        idempotencyKey: makeFeedIdempotencyKey(input.blogId, input.feederId, input.feedSeq, 'income'),
      });
    } catch (step2Err) {
      // Step1 已扣款但 Step2 失败 → 补偿退款 Step1，让远端回到初始态。
      try {
        await this.transfer({
          fromUserId: SYSTEM_USER_ID,
          toUserId: input.feederId,
          amount: input.amount,
          entryType: 'feed_refund',
          apiKey: cfg.systemKey,
          description: `投喂文章「${input.blogTitle}」分成失败，退款`,
          metadata: { blog_id: input.blogId, reason: 'feed_income_failed' },
          idempotencyKey: makeFeedIdempotencyKey(input.blogId, input.feederId, input.feedSeq, 'refund'),
        });
      } catch (refundErr) {
        // ★ 唯一会产生「本地/远端分叉」的窗口：Step1 已扣款 → Step2 失败 → 补偿也失败。
        // 此时本地事务会回滚（下面照常上抛），但**远端已经扣了投喂者的钱**，两边对不上。
        //
        // 这条日志是目前唯一的发现途径 —— 没有对账队列，也没有自动重试。
        // 故意打成**单行、带固定前缀的结构化 JSON**，便于日志系统按
        // `ACCOUNT_RECONCILE_REQUIRED` 关键字告警、并直接解析出对账所需字段。
        // 长期方案：落一张对账表 + 后台重试，而不是靠人盯日志。
        console.error(
          'ACCOUNT_RECONCILE_REQUIRED ' +
            JSON.stringify({
              scene: 'feed',
              reason: 'step2_failed_and_refund_failed',
              feederId: input.feederId,
              authorId: input.authorId,
              blogId: input.blogId,
              amount: input.amount,
              authorIncome: input.authorIncome,
              feedSeq: input.feedSeq,
              // 幂等键：人工补偿时按它去账户服务查/补，可避免重复退款
              refundIdempotencyKey: makeFeedIdempotencyKey(
                input.blogId,
                input.feederId,
                input.feedSeq,
                'refund'
              ),
              step2Error: step2Err instanceof Error ? step2Err.message : String(step2Err),
              refundError: refundErr instanceof Error ? refundErr.message : String(refundErr),
            }),
          refundErr
        );
      }
      // 无论补偿成败，都向上抛出，让调用方回滚本地事务（fail-closed）。
      throw step2Err;
    }
  },
};
