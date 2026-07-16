// ─────────────────────────────────────────────────────────────────────────────
// password.ts — 与 werkzeug 完全兼容的密码哈希校验/生成
//
// 现有数据库里的 password_hash 由 werkzeug.security.generate_password_hash 生成，
// 现代默认是 scrypt：格式 "scrypt:N:r:p$salt$hexhash"（dklen=64）。
// 也可能存在历史 "pbkdf2:sha256:iterations$salt$hexhash"。
//
// 本模块让 Next 侧**无需用户重置密码**即可直接校验旧哈希；新生成的哈希也保持
// werkzeug 可读，从而支持双向过渡期。
// ─────────────────────────────────────────────────────────────────────────────

import {
  scrypt as _scrypt,
  pbkdf2 as _pbkdf2,
  randomBytes,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

// 显式包裹 scrypt 的「options 回调」重载（promisify 只会挑到 3 参重载，丢掉 options）
function scrypt(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keylen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey)
    );
  });
}

const pbkdf2 = promisify(_pbkdf2);

// werkzeug scrypt 默认 dklen=64、maxmem≈132MB
const SCRYPT_DKLEN = 64;
const SCRYPT_MAXMEM = 132 * 1024 * 1024;

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // 长度已相等，timingSafeEqual 恒定时间比较
  return timingSafeEqual(ba, bb);
}

/**
 * 校验明文密码是否匹配 werkzeug 格式的哈希串。
 * 支持 scrypt 与 pbkdf2:<hash>。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || stored.indexOf('$') === -1) return false;
  const [method, salt, hashHex] = stored.split('$');
  if (!method || salt === undefined || !hashHex) return false;

  const parts = method.split(':');
  const algo = parts[0];

  try {
    if (algo === 'scrypt') {
      // scrypt:N:r:p
      const N = parseInt(parts[1], 10);
      const r = parseInt(parts[2], 10);
      const p = parseInt(parts[3], 10);
      const derived = (await scrypt(password, salt, SCRYPT_DKLEN, {
        N,
        r,
        p,
        maxmem: SCRYPT_MAXMEM,
      })) as Buffer;
      return hexEqual(derived.toString('hex'), hashHex);
    }

    if (algo === 'pbkdf2') {
      // pbkdf2:sha256:iterations  (werkzeug 旧默认)
      const digest = parts[1] || 'sha256';
      const iterations = parseInt(parts[2], 10);
      // werkzeug pbkdf2 的 dklen = 摘要输出长度（sha256 → 32）
      const dklen = digest === 'sha256' ? 32 : digest === 'sha1' ? 20 : 64;
      const derived = (await pbkdf2(password, salt, iterations, dklen, digest)) as Buffer;
      return hexEqual(derived.toString('hex'), hashHex);
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * 生成 werkzeug 兼容的 scrypt 哈希（新注册/改密码时用），Flask 侧亦可校验。
 * 与 werkzeug 默认参数一致：scrypt:32768:8:1，salt 16 字符，dklen=64。
 */
// werkzeug 的 salt 字符集与长度：secrets.choice(ascii_letters + digits)，salt_length=16。
const SALT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SALT_LENGTH = 16;

/**
 * 生成 werkzeug 同款 salt：固定 16 位字母数字。
 *
 * 注意别用 `randomBytes(n).toString('base64').replace(/[^a-zA-Z0-9]/g,'')` ——
 * 剥掉 +/= 后长度会随机变短（14~16 浮动），熵也跟着抖。
 * 这里用拒绝采样（丢弃 >=248 的字节）避免 % 62 的取模偏置。
 */
function generateSalt(len = SALT_LENGTH): string {
  let out = '';
  while (out.length < len) {
    for (const byte of randomBytes(len * 2)) {
      if (out.length >= len) break;
      if (byte < 248) out += SALT_CHARS[byte % SALT_CHARS.length]; // 248 = 4×62
    }
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const N = 32768,
    r = 8,
    p = 1;
  const salt = generateSalt();
  const derived = (await scrypt(password, salt, SCRYPT_DKLEN, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  return `scrypt:${N}:${r}:${p}$${salt}$${derived.toString('hex')}`;
}
