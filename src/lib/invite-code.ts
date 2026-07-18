// ─────────────────────────────────────────────────────────────────────────────
// invite-code.ts — 邀请码生成（对齐 Flask app/utils/invite_code.py:generate_invite_code）
//
// 原实现：raw = random.getrandbits(64) → base62 编码 → .ljust(12, '0')[:12]
//   · base62 字符集用 base62 PyPI 包默认表（数字 + 大写 + 小写）。
//   · 右填 '0' 到 12 位再截断为 12，因此产物恒为 12 字符（注册时校验 length===12）。
// 语义等价迁移：用 crypto.getRandomValues 取 64 位随机数（比 random 更均匀），
// 其余编码 / 补位 / 落库逻辑逐一对齐。created_at 对齐模型 default=datetime.now。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // base62 默认表

function base62Encode(n: bigint): string {
  if (n === 0n) return '0';
  const base = 62n;
  let out = '';
  while (n > 0n) {
    out = CHARSET[Number(n % base)] + out;
    n = n / base;
  }
  return out;
}

/** 生成一枚 12 位 base62 邀请码并落库，返回该邀请码。 */
export async function generateInviteCode(): Promise<string> {
  const buf = new Uint8Array(8); // 64 位
  crypto.getRandomValues(buf);
  let raw = 0n;
  for (const b of buf) raw = (raw << 8n) | BigInt(b);

  const code = base62Encode(raw).padEnd(12, '0').slice(0, 12);

  await prisma.inviteCode.create({
    data: { code, isUsed: false, createdAt: nowForDb() },
  });
  return code;
}
