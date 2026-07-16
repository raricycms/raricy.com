// ─────────────────────────────────────────────────────────────────────────────
// admin-user-service.ts — 用户管理 / 禁言（对齐 Flask app/web/auth/user_management.py）
//
// 纯函数 + 显式参数，与项目其它 service 风格一致。所有写路径都会写一条
// AdminActionLog（visibility 默认 'public'，对齐 Flask log_admin_action）。
//
// 关于 admin_action_logs.extra：该列在 SQLite 里声明类型是 JSON，Prisma 的 SQLite
// 连接器在驱动层拒绝 SELECT 它（"Value JSON not supported"，audit-service 已注明）。
// 因此：create() 时用 `select:{id:true}` 避免回读 extra；需要写 extra 时用参数化
// raw UPDATE + CAST 语义写入（SQLite 动态类型，文本可直接落进 JSON 列）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { isCurrentlyBanned, isOwner, type SafeUser } from './auth';
import { sendNotification } from './notification-service';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;
const BAN_REASON_MAX = 200;

export const ROLES = ['user', 'core', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

// ── 审计日志写入 helper（appeal-service 也复用）──────────────────────────────
export interface LogAdminActionInput {
  action: string;
  adminId: string;
  targetUserId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  visibility?: string;
}

/** 写一条管理操作日志，返回日志 id。extra 走参数化 raw UPDATE，避免驱动层 JSON 读写坑。 */
export async function logAdminAction(input: LogAdminActionInput): Promise<number> {
  const log = await prisma.adminActionLog.create({
    data: {
      action: input.action,
      adminId: input.adminId,
      targetUserId: input.targetUserId ?? null,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      reason: input.reason ?? null,
      visibility: input.visibility ?? 'public',
      createdAt: nowForDb(),
    },
    select: { id: true }, // 不回读 extra（JSON 列）
  });

  if (input.metadata && Object.keys(input.metadata).length) {
    // 参数化：? 占位符由驱动绑定，不存在注入
    await prisma.$executeRawUnsafe(
      'UPDATE admin_action_logs SET extra = ? WHERE id = ?',
      JSON.stringify(input.metadata),
      log.id
    );
  }
  return log.id;
}

// ── 结果类型 ─────────────────────────────────────────────────────────────────
export type AdminResult<T extends object = object> =
  | ({ ok: true; message: string } & T)
  | { ok: false; code: number; message: string };

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  role: true,
  createdAt: true,
  lastLogin: true,
  isBanned: true,
  banUntil: true,
  banReason: true,
  avatarPath: true,
} as const;

export type AdminUserRow = {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt: string | null;
  lastLogin: string | null;
  isBanned: boolean;
  banUntil: string | null;
  banReason: string | null;
  currentlyBanned: boolean;
  avatarPath: string | null;
};

function toRow(u: {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt: Date | null;
  lastLogin: Date | null;
  isBanned: boolean | null;
  banUntil: Date | null;
  banReason: string | null;
  avatarPath: string | null;
}): AdminUserRow {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt ? u.createdAt.toISOString() : null,
    lastLogin: u.lastLogin ? u.lastLogin.toISOString() : null,
    isBanned: !!u.isBanned,
    banUntil: u.banUntil ? u.banUntil.toISOString() : null,
    banReason: u.banReason,
    currentlyBanned: isCurrentlyBanned({ isBanned: u.isBanned, banUntil: u.banUntil }),
    avatarPath: u.avatarPath,
  };
}

// ── 列表（分页 + 用户名/邮箱搜索）────────────────────────────────────────────
export interface ListUsersParams {
  page?: number;
  perPage?: number;
  search?: string | null;
}

export async function listUsers(params: ListUsersParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));
  const search = (params.search ?? '').trim();

  const where = search
    ? {
        OR: [
          { username: { contains: search } },
          { email: { contains: search } },
        ],
      }
    : {};

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // 对齐 Flask user_management
      skip: (page - 1) * perPage,
      take: perPage,
      select: USER_SELECT,
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return {
    users: rows.map(toRow),
    total,
    page,
    perPage,
    pages,
    hasPrev: page > 1,
    hasNext: page < pages,
  };
}

// ── 角色变更 ─────────────────────────────────────────────────────────────────
export interface SetRoleParams {
  actor: SafeUser;
  targetId: string;
  newRole: string;
}

/**
 * 变更用户角色（user↔core↔admin↔owner）。
 *  • 涉及 owner（目标当前是 owner，或目标要变成 owner）时，仅站长可操作。
 *  • 不能改自己的角色。
 */
export async function setRole(p: SetRoleParams): Promise<AdminResult<{ role: string }>> {
  const newRole = p.newRole as Role;
  if (!ROLES.includes(newRole)) return { ok: false, code: 400, message: '无效的角色' };
  if (p.targetId === p.actor.id) return { ok: false, code: 403, message: '不能修改自己的角色' };

  const target = await prisma.user.findUnique({
    where: { id: p.targetId },
    select: { id: true, username: true, role: true },
  });
  if (!target) return { ok: false, code: 404, message: '用户不存在' };
  if (target.role === newRole) return { ok: false, code: 400, message: '角色未变化' };

  // 涉及 owner 的任何方向都需要站长权限
  const touchesOwner = target.role === 'owner' || newRole === 'owner';
  if (touchesOwner && !isOwner(p.actor)) {
    return { ok: false, code: 403, message: '仅站长可变更站长角色' };
  }

  await prisma.user.update({
    where: { id: p.targetId },
    data: { role: newRole },
    select: { id: true },
  });

  await logAdminAction({
    action: 'change_role',
    adminId: p.actor.id,
    targetUserId: p.targetId,
    objectType: 'user',
    objectId: p.targetId,
    reason: `角色 ${target.role} → ${newRole}`,
    metadata: { from: target.role, to: newRole },
  });

  return { ok: true, message: `已将 ${target.username} 设为 ${newRole}`, role: newRole };
}

// ── 禁言 ─────────────────────────────────────────────────────────────────────
export interface BanUserParams {
  actor: SafeUser;
  targetId: string;
  hours: number;
  reason: string;
}

/**
 * 禁言用户（对齐 Flask ban_user）：
 *  创建 UserBan + 置 user.isBanned/banUntil/banReason + 递增 sessionVersion（强制下线）
 *  + 写 AdminActionLog + 给被禁言者发通知。
 */
export async function banUser(p: BanUserParams): Promise<AdminResult<{ banId: number }>> {
  const reason = (p.reason ?? '').trim();
  if (!reason) return { ok: false, code: 400, message: '缺少禁言原因' };
  if (reason.length > BAN_REASON_MAX)
    return { ok: false, code: 400, message: `禁言原因不能超过 ${BAN_REASON_MAX} 个字符` };

  const hours = Number(p.hours);
  if (!Number.isFinite(hours) || hours <= 0)
    return { ok: false, code: 400, message: '禁言时长必须大于 0' };

  if (p.targetId === p.actor.id) return { ok: false, code: 403, message: '不能禁言自己' };

  const target = await prisma.user.findUnique({
    where: { id: p.targetId },
    select: { id: true, username: true, role: true, isBanned: true, banUntil: true },
  });
  if (!target) return { ok: false, code: 404, message: '用户不存在' };
  if (target.role === 'admin' || target.role === 'owner')
    return { ok: false, code: 403, message: '不能禁言管理员' };
  if (isCurrentlyBanned({ isBanned: target.isBanned, banUntil: target.banUntil }))
    return { ok: false, code: 400, message: '用户已被禁言' };

  const now = nowForDb();
  const banUntil = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const ban = await prisma.userBan.create({
    data: {
      userId: target.id,
      adminId: p.actor.id,
      bannedAt: now,
      banUntil,
      reason,
      isLifted: false,
    },
    select: { id: true },
  });

  // 置禁言状态 + 递增 sessionVersion 强制下线（会话失效）
  await prisma.user.update({
    where: { id: target.id },
    data: {
      isBanned: true,
      banUntil,
      banReason: reason,
      sessionVersion: { increment: 1 },
    },
    select: { id: true },
  });

  await logAdminAction({
    action: 'ban_user',
    adminId: p.actor.id,
    targetUserId: target.id,
    objectType: 'user',
    objectId: target.id,
    reason,
    metadata: { ban_until: banUntil.toISOString(), hours },
  });

  // 通知被禁言者（force 绕过通知偏好）
  await sendNotification({
    recipientId: target.id,
    action: '禁言通知',
    actorId: p.actor.id,
    objectType: 'user',
    objectId: target.id,
    detail: `你已被禁言至 ${banUntil.toISOString()}，原因：${reason}`,
    force: true,
  });

  return { ok: true, message: `用户 ${target.username} 已被禁言 ${hours} 小时`, banId: ban.id };
}

// ── 解除禁言 ─────────────────────────────────────────────────────────────────
export interface UnbanUserParams {
  actor: SafeUser;
  targetId: string;
  reason?: string;
}

/**
 * 解除禁言（对齐 Flask lift_ban）：清标志 + 标记最近一条 UserBan lifted + 写日志 + 通知。
 */
export async function unbanUser(p: UnbanUserParams): Promise<AdminResult> {
  const reason = (p.reason ?? '').trim();
  if (reason.length > BAN_REASON_MAX)
    return { ok: false, code: 400, message: `原因不能超过 ${BAN_REASON_MAX} 个字符` };

  const target = await prisma.user.findUnique({
    where: { id: p.targetId },
    select: { id: true, username: true, isBanned: true, banUntil: true },
  });
  if (!target) return { ok: false, code: 404, message: '用户不存在' };
  if (!isCurrentlyBanned({ isBanned: target.isBanned, banUntil: target.banUntil }))
    return { ok: false, code: 400, message: '用户未被禁言' };

  await prisma.user.update({
    where: { id: target.id },
    data: { isBanned: false, banUntil: null, banReason: null },
    select: { id: true },
  });

  // 标记最近一条未解除的 UserBan（对齐 lift_ban：banned_at desc 取第一条）
  const latest = await prisma.userBan.findFirst({
    where: { userId: target.id, isLifted: false },
    orderBy: { bannedAt: 'desc' },
    select: { id: true },
  });
  if (latest) {
    await prisma.userBan.update({
      where: { id: latest.id },
      data: { isLifted: true, liftedAt: nowForDb(), liftedBy: p.actor.id },
      select: { id: true },
    });
  }

  await logAdminAction({
    action: 'unban_user',
    adminId: p.actor.id,
    targetUserId: target.id,
    objectType: 'user',
    objectId: target.id,
    reason: reason || null,
  });

  await sendNotification({
    recipientId: target.id,
    action: '解除禁言',
    actorId: p.actor.id,
    objectType: 'user',
    objectId: target.id,
    detail: reason ? `你的禁言已被解除：${reason}` : '你的禁言已被解除',
    force: true,
  });

  return { ok: true, message: `用户 ${target.username} 的禁言已解除` };
}
