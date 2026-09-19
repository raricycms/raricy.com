// ─────────────────────────────────────────────────────────────────────────────
// secret-box.ts — 落盘密钥的对称加解密（Fernet）
//
// 站内现在有两处「必须加密落库的凭证」：
//   · User.fishApiKeyEncrypted —— 用户的账户微服务 API Key；
//   · FishWebhookEndpoint.secretEncrypted —— 回调的签名密钥（泄露即可伪造我们发出的回调）。
// 两者的**派生方式必须逐字节相同**，所以实现集中在这里，别在各自文件里再抄一份：
// 抄一份的代价不是重复代码，是「改了一处、另一处静默解不开」—— 而它直到某次
// 回调投递失败才会暴露。
//
// ★ 派生方式是冻结的，改了旧密文一律解不开 ★
//   key = base64url( SHA-256( FISH_ENCRYPTION_KEY || SECRET_KEY ) )   → Fernet
//   Python 侧 cryptography.Fernet 可直接解开（标准 Fernet 令牌格式、随机 IV）。
//   这条链上有两个已知的部署陷阱，见 docs/deploy.md 的 env 说明：
//   SECRET_KEY 必须跨环境原样沿用；FISH_ENCRYPTION_KEY 在**已有库**上必须留空。
//   tests/unit/secret-box.test.ts 里钉了一个**金标准密文**（由重构前的实现产出），
//   专门用来堵「两份实现一起被改」—— 那种情况下互通测试证明不了任何事。
//
// 【与 account-client.ts 的分工】本文件只管密码学，**不知道**鱼干、账户服务、
// 也不知道失败该返回 503 还是 400。那些语义留在调用方：account-client 把
// SecretBoxError 转成 AccountServiceError(503) 以维持它的 fail-closed 契约。
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

/** 本模块的唯一错误类型。调用方负责翻译成自己的错误语义。 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * 由密钥来源派生 Fernet Secret。**这是冻结的那一行** —— 见文件头。
 * 空来源直接抛：静默用一个空串做密钥等于把密文变成明文。
 */
function fernetSecret(keySource: string): FernetSecret {
  if (!keySource) throw new SecretBoxError('缺少密钥来源（FISH_ENCRYPTION_KEY / SECRET_KEY）');
  const derived = crypto.createHash('sha256').update(keySource).digest();
  return new fernet.Secret(derived.toString('base64url')); // 32 bytes → url-safe base64
}

/**
 * 加密明文 → Fernet 令牌。
 * @throws SecretBoxError 密钥来源为空，或加密过程失败
 */
export function sealSecret(plain: string, keySource: string): string {
  try {
    return new fernet.Token({ secret: fernetSecret(keySource) }).encode(plain);
  } catch (e) {
    if (e instanceof SecretBoxError) throw e;
    throw new SecretBoxError(`加密失败: ${String(e)}`);
  }
}

/**
 * 解密 Fernet 令牌 → 明文。
 *
 * 【ttl:0 是刻意的】关闭 Fernet 自带的令牌过期校验：存量密文可能是很久以前加密的，
 * 而我们的密钥轮换靠的是重新加密而不是等它过期。开着的话，超过 TTL 的老密文会在
 * 某天突然解不开 —— 那是一次纯粹的静默故障。
 *
 * @throws SecretBoxError 密钥来源为空，或令牌损坏 / 密钥不匹配
 */
export function openSecret(token: string, keySource: string): string {
  if (!token) throw new SecretBoxError('密文为空');
  try {
    const secret = fernetSecret(keySource);
    return new fernet.Token({ secret, token, ttl: 0 }).decode();
  } catch (e) {
    if (e instanceof SecretBoxError) throw e;
    throw new SecretBoxError(`解密失败: ${String(e)}`);
  }
}

/** 生成一个用于签名密钥的随机串（32 字节 → base64url），与 OAuth 的令牌同款。 */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}
