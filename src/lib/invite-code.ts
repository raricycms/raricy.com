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

// ── 管理端列表与撤销 ─────────────────────────────────────────────────────────

export const INVITE_CODE_LENGTH = 12;

export interface InviteCodeListParams {
  page?: number;
  perPage?: number;
  filter?: 'all' | 'unused' | 'used';
}

export async function listInviteCodes(params: InviteCodeListParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));

  // isUsed 可空（历史数据），null 一律视同「未使用」
  const where =
    params.filter === 'unused'
      ? { isUsed: { not: true } }
      : params.filter === 'used'
        ? { isUsed: true }
        : {};

  const [total, rows] = await Promise.all([
    prisma.inviteCode.count({ where }),
    prisma.inviteCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        code: true,
        isUsed: true,
        createdAt: true,
        usedBy: true,
        usedByUser: { select: { username: true } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return {
    codes: rows.map((r) => ({ ...r, usedByName: r.usedByUser?.username ?? null })),
    total,
    page,
    perPage,
    pages,
    hasPrev: page > 1,
    hasNext: page < pages,
  };
}

export type RevokeInviteCodeResult =
  | { ok: true; message: string }
  | { ok: false; code: number; message: string };

/**
 * 撤销一枚**未使用**的邀请码。
 *
 * 【为什么是物理删除，以及为什么拒绝已使用的】InviteCode 没有软删列
 * （id/code/is_used/created_at/used_by），所以「撤销」只能是物理 DELETE ——
 * 这是本工具里唯一破「永不物理删除」的地方，因此收窄到最小：
 *
 *   · 未使用的码 → 删掉是对的，后果只是持码人注册不了（这正是「撤销」的语义）
 *   · **已使用的码 → 拒绝**。used_by 是「谁邀请了谁」的唯一记录，
 *     删掉就永久丢失，审计日志也重建不出来（用户行不受影响，没有级联，
 *     所以只是数据丢失 —— 但这就够了）。
 *
 * 【码值绝不进审计日志】logAdminAction 默认 visibility:'public'，而 /audit 是**公开页**。
 * 把 12 位邀请码写进 reason/metadata 等于把注册凭证发给所有 core 用户。
 * 所以只记 objectType + 数字 id。
 */
export async function revokeInviteCode(
  idOrCode: string,
  actor: { id: string; username: string }
): Promise<RevokeInviteCodeResult> {
  const key = idOrCode.trim();
  const asId = Number.parseInt(key, 10);

  const row = Number.isInteger(asId) && String(asId) === key
    ? await prisma.inviteCode.findUnique({ where: { id: asId }, select: { id: true, code: true, isUsed: true, usedBy: true } })
    : await prisma.inviteCode.findUnique({ where: { code: key }, select: { id: true, code: true, isUsed: true, usedBy: true } });

  if (!row) return { ok: false, code: 404, message: '邀请码不存在' };
  if (row.isUsed) {
    return {
      ok: false,
      code: 400,
      message: '该邀请码已被使用，不能撤销（撤销会丢失「谁邀请了谁」的记录）',
    };
  }

  await prisma.inviteCode.delete({ where: { id: row.id } });

  // 审计里只出现数字 id 与「撤销」这件事，**不出现码值**（见上方说明）
  const { logAdminAction } = await import('./admin-user-service');
  try {
    await logAdminAction({
      action: 'revoke_invite_code',
      adminId: actor.id,
      objectType: 'invite_code',
      objectId: String(row.id),
      reason: '撤销未使用的邀请码',
    });
  } catch {
    /* 审计写入失败不影响撤销结果 */
  }

  return { ok: true, message: '已撤销该邀请码' };
}
