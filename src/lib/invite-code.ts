// ─────────────────────────────────────────────────────────────────────────────
// invite-code.ts — 邀请码生成
//
// 码的形状（不可改：库里的存量码、注册侧的 length===12 校验都按它）：
//   raw = 64 位随机数 → base62 编码 → 右填 '0' 到 12 位、再截断为 12
//   · base62 字符集是 0-9A-Za-z 的默认表（数字 + 大写 + 小写）。
//   · 因此产物恒为 12 字符。
// 随机数用 crypto.getRandomValues 取 64 位（比旧版的 random 更均匀）；
// created_at 用 nowForDb() 写入（UTC+8 墙上时间，见 db-time.ts）。
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

/** findInviteCode 的返回行（撤销与运维 CLI 的确认屏共用同一份投影）。 */
const INVITE_CODE_SELECT = {
  id: true,
  code: true,
  isUsed: true,
  createdAt: true,
  usedBy: true,
  usedByUser: { select: { username: true } },
} as const;

/**
 * 按「数字 id」或「12 位码」取一行。
 *
 * 【为什么撤销与确认屏必须共用它】两处各写一份的话会立刻漂移，而且症状很别扭：
 * 确认屏说「找不到邀请码」、服务层却能把它删掉（或反过来）。
 *
 * 【为什么不能像别处那样用列表接口去翻】`listInviteCodes` 按 createdAt 倒序分页、
 * perPage 封顶 100 —— 拿它当查找用，第 100 行之后的码会被误报成「不存在」，
 * 而这里是一次 findUnique，全表都能命中。
 *
 * id 与码的优先级：`String(asId) === key` 形状的先当 id 查（`007` 不当 7），
 * 查不到再当码查 —— 纯数字的码虽然罕见（12 位全数字 ≈ 千万分之一），
 * 不值得为它留一个「查不到」的坑。
 */
export async function findInviteCode(idOrCode: string) {
  const key = idOrCode.trim();
  const asId = Number.parseInt(key, 10);
  if (Number.isInteger(asId) && String(asId) === key) {
    const byId = await prisma.inviteCode.findUnique({ where: { id: asId }, select: INVITE_CODE_SELECT });
    if (byId) return byId;
  }
  return prisma.inviteCode.findUnique({ where: { code: key }, select: INVITE_CODE_SELECT });
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
 * 【码值绝不进审计日志】12 位邀请码就是注册凭证，不该在库里多抄一份到审计表 ——
 * 日志是要被翻、被导出、将来还可能被改成公示的。所以只记 objectType + 数字 id。
 *（调用方目前只有运维 CLI，后台运维的日志落 visibility='internal'，见 audit-context.ts；
 *  但这条纪律不跟着可见性走 —— 哪天网页端也接上撤销入口，日志就是公开的了。）
 */
export async function revokeInviteCode(
  idOrCode: string,
  actor: { id: string; username: string }
): Promise<RevokeInviteCodeResult> {
  const row = await findInviteCode(idOrCode);

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
