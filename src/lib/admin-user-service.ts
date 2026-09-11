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

import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { hashPassword } from './password';
import { PUBLIC_USER_SELECT, hasAdminRights, isCurrentlyBanned, isOwner, type SafeUser } from './auth';
import { sendNotification } from './notification-service';
import { kickUser } from './chat-bus';

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

// ── SafeUser 载入（运维 CLI 解析审计主体用）─────────────────────────────────
//
// 【为什么需要这一组】CLI 没有登录会话，但写路径要往 admin_action_logs.admin_id /
// user_bans.admin_id 落一条**真实外键**（不能用伪造 ID）。所以 CLI 必须能按用户名
// 或「库内最早的站长」取回一个 SafeUser 形状的用户，拿它当 actor。
//
// 复用 auth.ts 的 PUBLIC_USER_SELECT，字段口径与 getCurrentUser() 完全一致。

export async function loadSafeUserByUsername(username: string): Promise<SafeUser | null> {
  const u = await prisma.user.findUnique({ where: { username }, select: PUBLIC_USER_SELECT });
  return (u as SafeUser | null) ?? null;
}

export async function loadUserById(id: string): Promise<SafeUser | null> {
  const u = await prisma.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
  return (u as SafeUser | null) ?? null;
}

/**
 * 库内最早的站长（createdAt 升序，id 兜底保证同秒创建时结果确定）。
 * 与 oauth create-app 既有的 owner 回退口径一致。
 */
export async function loadDefaultOwner(): Promise<SafeUser | null> {
  const u = await prisma.user.findFirst({
    where: { role: 'owner' },
    select: PUBLIC_USER_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return (u as SafeUser | null) ?? null;
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

/** 管理员可自行变更的角色档位：仅「认证/取消认证」这一对（user↔core）。 */
const ADMIN_SETTABLE_ROLES: readonly Role[] = ['user', 'core'];

/**
 * 变更用户角色（user↔core↔admin↔owner）。
 *
 * 权限分档：
 *  • user↔core（即页面上的「认证 / 取消认证」）—— 管理员即可。
 *  • 涉及 admin 或 owner 的任何方向 —— 仅站长。站长的用户管理页给出
 *    core→admin（提拔管理员）与 admin→core（降为核心用户）两个按钮，
 *    user↔core 那一对仍留给管理员日常使用。
 *  • 不能改自己的角色。
 *
 * 【为什么卡 admin 这一档】此前只拦了 owner，于是管理员可以直接
 * `PATCH /api/admin/users/:id {"role":"admin"}` 造出新的管理员（实测 200，
 * 角色真的落库）。UI 上没有这个按钮，但接口收任意角色 —— 藏起按钮不等于挡住。
 * Flask 侧压根做不到这件事：它的 /promote 硬编码只做 user→core，且是 @owner_required，
 * 想加管理员只能上服务器跑 `flask promote-admin`。
 *
 * 这里比 Flask 略宽（Flask 连 user↔core 都要站长），是刻意保留的：
 * 日常给新人认证是管理员的常规工作，收到站长会把这条路堵死。
 * 但「谁能任命管理员」这条底线与 Flask 一致 —— 只有站长。想撤掉一个管理员时
 * 同理：只有站长能把他降回 core，管理员之间不能互降。
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

  // 目标的当前角色与目标角色，只要有一头超出 user↔core，就必须是站长。
  // 判「当前角色」而非只判「新角色」：否则管理员能把另一个管理员一键降成 user。
  const privileged =
    !ADMIN_SETTABLE_ROLES.includes(target.role as Role) || !ADMIN_SETTABLE_ROLES.includes(newRole);
  if (privileged && !isOwner(p.actor)) {
    return { ok: false, code: 403, message: '仅站长可变更管理员/站长角色' };
  }

  await prisma.user.update({
    where: { id: p.targetId },
    data: { role: newRole },
    select: { id: true },
  });

  // 角色变更可能收回/放开聊天权限（core 才能进聊天）→ 踢掉已建立的 SSE 连接，
  // 让浏览器重连时重新走 requireChatUser 鉴权。
  kickUser(p.targetId);

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

  // 禁言即刻生效：踢掉已建立的 SSE 连接（否则那条长连接会继续收消息，
  // 直到用户自己刷新）。断开后 EventSource 重连 → requireChatUser 返回 403 → 关闭。
  kickUser(target.id);

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

// ── 重置密码（站长专用）──────────────────────────────────────────────────────
//
// 【为什么只能站长做，且不能对自己做】网页端的 changeOwnPassword 要求**先验原密码**。
// 这个函数不需要原密码 —— 那正是它的用途（用户忘了密码 / 邮箱被盗后电话核实），
// 也正因如此它是把「免密登录他人账号」的能力：给到管理员就等于给到所有人。
// 不允许对自己用，是因为自助改密走网页端（需原密码），CLI 免密重置自己 = 会话劫持原语。

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 生成随机密码。用拒绝采样避免取模偏置（248 = 4 × 62）。 */
function generatePassword(len = 16): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b >= 248) continue;
      out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

export interface ResetPasswordParams {
  actor: SafeUser;
  targetId: string;
  /** null → 由服务生成 16 位随机密码（推荐：不进 shell 历史）。 */
  newPassword: string | null;
  reason: string;
}

export type ResetPasswordResult =
  | { ok: true; message: string; password: string; generated: boolean; sessionVersion: number }
  | { ok: false; code: number; message: string };

/**
 * 重置某用户的密码，并递增 sessionVersion 让它所有已登录会话立即失效。
 *
 * ⚠️ 审计日志里**绝不写密码**（reason 与 metadata 都不写）—— /audit 是公开页。
 */
export async function resetUserPassword(p: ResetPasswordParams): Promise<ResetPasswordResult> {
  if (!isOwner(p.actor)) return { ok: false, code: 403, message: '仅站长可重置他人密码' };
  if (p.targetId === p.actor.id) {
    return { ok: false, code: 403, message: '不能重置自己的密码，请用网页端「修改密码」' };
  }

  const reason = (p.reason ?? '').trim();
  if (!reason) return { ok: false, code: 400, message: '缺少重置原因' };
  if (reason.length > BAN_REASON_MAX) {
    return { ok: false, code: 400, message: `重置原因不能超过 ${BAN_REASON_MAX} 个字符` };
  }

  const target = await prisma.user.findUnique({
    where: { id: p.targetId },
    select: { id: true, username: true, sessionVersion: true },
  });
  if (!target) return { ok: false, code: 404, message: '用户不存在' };

  const generated = p.newPassword === null;
  const password = p.newPassword ?? generatePassword();
  // 与 changeOwnPassword 同一条底线
  if (password.length < 8) return { ok: false, code: 400, message: '新密码长度至少为 8 位' };

  const passwordHash = await hashPassword(password);
  const nextVersion = (target.sessionVersion ?? 0) + 1;

  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash, sessionVersion: nextVersion },
    select: { id: true },
  });

  // 断开已建立的 SSE 长连接（否则那条连接会继续收消息直到用户自己刷新）
  kickUser(target.id);

  await logAdminAction({
    action: 'reset_password',
    adminId: p.actor.id,
    targetUserId: target.id,
    objectType: 'user',
    objectId: target.id,
    reason,
    metadata: { generated }, // ★ 只有「是不是生成的」，没有密码本身
  });

  return {
    ok: true,
    message: `已重置 ${target.username} 的密码`,
    password,
    generated,
    sessionVersion: nextVersion,
  };
}

// ── 强制下线 ─────────────────────────────────────────────────────────────────

export interface ForceLogoutParams {
  actor: SafeUser;
  targetId: string;
  reason?: string;
}

/**
 * 强制某用户下线：递增 sessionVersion（会话立即失效）+ 踢 SSE 连接 + 审计 + 通知。
 *
 * 权限用 hasAdminRights 而不是 owner —— 强制下线严格弱于禁言，而禁言管理员已经能做。
 */
export async function forceLogout(p: ForceLogoutParams): Promise<AdminResult> {
  if (!hasAdminRights(p.actor)) return { ok: false, code: 403, message: '需要管理员权限' };
  if (p.targetId === p.actor.id) return { ok: false, code: 403, message: '不能强制自己下线' };

  const target = await prisma.user.findUnique({
    where: { id: p.targetId },
    select: { id: true, username: true },
  });
  if (!target) return { ok: false, code: 404, message: '用户不存在' };

  await prisma.user.update({
    where: { id: target.id },
    data: { sessionVersion: { increment: 1 } },
    select: { id: true },
  });
  kickUser(target.id);

  const reason = (p.reason ?? '').trim();
  await logAdminAction({
    action: 'force_logout',
    adminId: p.actor.id,
    targetUserId: target.id,
    objectType: 'user',
    objectId: target.id,
    reason: reason || null,
  });

  // 不说一声就掉线会让人以为站点坏了
  await sendNotification({
    recipientId: target.id,
    action: '强制下线',
    actorId: p.actor.id,
    objectType: 'user',
    objectId: target.id,
    detail: reason ? `你已被强制下线（${reason}），请重新登录。` : '你已被强制下线，请重新登录。',
    force: true,
  });

  return { ok: true, message: `已强制 ${target.username} 下线` };
}
