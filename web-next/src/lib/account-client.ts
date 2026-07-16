// ─────────────────────────────────────────────────────────────────────────────
// account-client.ts — 小鱼干账户微服务 HTTP 客户端（TS 版，对齐 Flask AccountClient）
//
// 对齐 Flask app/clients/account_client.py 的全部公开 API，并严格保持
// **fail-closed** 写路径语义（详见 CLAUDE.md Phase 1.5 与 feed-service.ts）：
//   本地先收集变更 → 远端同步成功后才 commit 本地 → 远端失败则整体回滚 + 返回明确错误。
//
// 认证：双层 —— X-Internal-Token（服务间共享密钥）+ 用户/系统 API Key。
//   ⚠️ 账户服务实际用 `Authorization: Bearer <api_key>` 传递用户 Key（见
//   account-service/app/api/deps.py:extract_api_key），而**不是** X-Api-Key。
//   本客户端因此沿用 Bearer，与 Flask 客户端一致。
//
// 用户 API Key 以 Fernet 加密存于 User.fishApiKeyEncrypted。解密密钥派生方式
// 与 Flask app/utils/AES.py / account_client.init_app 完全一致：
//   key = base64url( SHA-256( FISH_ENCRYPTION_KEY || SECRET_KEY ) )   → Fernet
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// fernet 无类型声明；用 createRequire 以 CJS 方式加载并给出最小接口。
const nodeRequire = createRequire(import.meta.url);

interface FernetSecret {
  readonly signingKey: unknown;
  readonly encryptionKey: unknown;
}
interface FernetToken {
  decode(): string;
  encode(message?: string): string;
}
interface FernetLib {
  Secret: new (secret64: string) => FernetSecret;
  Token: new (opts: {
    secret: FernetSecret;
    token?: string;
    message?: string;
    ttl?: number;
  }) => FernetToken;
}
const fernet = nodeRequire('fernet') as FernetLib;

// 博客系统本身也是账户服务里的一个账户（用系统 Key 结算作者分成）。
export const SYSTEM_USER_ID = 'raricy-blog-system';

export interface AccountConfig {
  baseUrl: string;
  internalToken: string;
  systemKey: string;
  timeoutMs: number;
  /** Fernet 密钥来源明文：优先 FISH_ENCRYPTION_KEY，回退 SECRET_KEY（对齐 Flask）。 */
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
 * 投喂/注册会静默地只写本地、只留一条 console.warn —— 与 Phase 1.5 的 fail-closed
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

// ── Fernet 解密（对齐 Flask AES.py：SHA-256 派生 → Fernet）───────────────────

/**
 * 解密存于 User.fishApiKeyEncrypted 的用户 API Key。
 * 与 Flask 派生方式一致：base64url(sha256(keySource)) 作为 Fernet 密钥。
 * 配置缺失或解密失败一律抛 AccountServiceError（503），供写路径 fail-closed。
 */
export function decryptApiKey(encrypted: string, cfg = accountConfig()): string {
  if (!cfg.encryptionKeySource) {
    throw new AccountServiceError('缺少 FISH_ENCRYPTION_KEY / SECRET_KEY，无法解密用户账户 Key', 503);
  }
  try {
    const derived = crypto.createHash('sha256').update(cfg.encryptionKeySource).digest();
    const secret64 = derived.toString('base64url'); // 32 bytes → url-safe base64
    const secret = new fernet.Secret(secret64);
    // ttl:0 关闭 Fernet 令牌过期校验（存量密文可能是很久以前加密的）。
    const token = new fernet.Token({ secret, token: encrypted, ttl: 0 });
    return token.decode();
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
    const derived = crypto.createHash('sha256').update(cfg.encryptionKeySource).digest();
    const secret64 = derived.toString('base64url'); // 32 bytes → url-safe base64（与 decrypt 一致）
    const secret = new fernet.Secret(secret64);
    const token = new fernet.Token({ secret });
    return token.encode(plain);
  } catch (e) {
    if (e instanceof AccountServiceError) throw e;
    throw new AccountServiceError(`用户账户 Key 加密失败: ${String(e)}`, 503);
  }
}

/**
 * 生成投喂操作的幂等键（≤64 字符，对齐 Flask _make_feed_idempotency_key）。
 * 格式：feed-{sha256(blogId-userId-count)[:16]}-{suffix}
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
 * Flask 客户端取 data.get('data', data)，这里同样把内层 data 解出返回。
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
   * 投喂的远端两步转账（fail-closed，对齐 Flask feed_transfer）：
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
        // 严重：补偿也失败，远端可能不一致，需人工核对。
        console.error(
          `[account-client] 严重：投喂 Step2 失败且补偿退款也失败，远端可能不一致` +
            `（feeder=${input.feederId}, author=${input.authorId}, blog=${input.blogId}, amount=${input.amount}）:`,
          refundErr
        );
      }
      // 无论补偿成败，都向上抛出，让调用方回滚本地事务（fail-closed）。
      throw step2Err;
    }
  },
};
