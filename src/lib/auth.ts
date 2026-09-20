// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — 服务端取当前用户 + 角色/禁言判定
//
// 会话解析语义：
//   1. 读 cookie → 验签 → 得到 { uid, sv }
//   2. 按 uid 载入用户；比对 sv 与 user.sessionVersion，不一致 → 视为未登录
//   3. 角色体系 user → core → admin → owner（逐档包含，判定见下面的三个 isXxx）
// ─────────────────────────────────────────────────────────────────────────────

import { cookies } from 'next/headers';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { SESSION_COOKIE, verifySessionToken } from './session';
import type { User } from '@prisma/client';

export type SafeUser = Omit<User, 'passwordHash' | 'fishApiKeyEncrypted'>;

/**
 * SafeUser 形状的字段投影。导出给需要「拿到一个能当审计主体的用户」的调用方复用
 * （admin-user-service 的 loadSafeUserByUsername / loadDefaultOwner，进而给运维 CLI），
 * 避免同一份 22 个字段抄两遍、日后加字段只改一处。
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  avatarPath: true,
  bio: true,
  createdAt: true,
  lastLogin: true,
  sessionVersion: true,
  role: true,
  isBanned: true,
  banUntil: true,
  banReason: true,
  totalFortune: true,
  driedFish: true,
  notifyLike: true,
  notifyEdit: true,
  notifyDelete: true,
  notifyAdmin: true,
  showRecentBlogs: true,
  showRecentComments: true,
  focusMode: true,
  // 头像框的装备态（见迁移 20 头部的取舍）。**只为了让调用方能算出 frameUrl** ——
  // 拿到 SafeUser 的地方请一律走 frame-service.frameUrlFor(user)，
  // 别直接读这两列：绕过判定 = 到期的框永远戴着，而那不报错。
  equippedFrameKey: true,
  equippedFrameExpiresAt: true,
} as const;

/** 读取并校验当前登录用户；未登录 / 会话失效返回 null。 */
export async function getCurrentUser(): Promise<SafeUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.uid },
    select: PUBLIC_USER_SELECT,
  });
  if (!user) return null;

  // session_version 失效检查：重置密码 / 禁言 / 强制下线都会递增版本 → 旧 cookie 立即作废
  if ((user.sessionVersion ?? 0) !== payload.sv) return null;

  return user as SafeUser;
}

// ── 角色判定（逐档包含：user < core < admin < owner）────────────────────────

export function isOwner(u: { role?: string } | null): boolean {
  return !!u && u.role === 'owner';
}
export function hasAdminRights(u: { role?: string } | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'owner');
}
export function isCoreUser(u: { role?: string } | null): boolean {
  return !!u && (u.role === 'core' || u.role === 'admin' || u.role === 'owner');
}

/**
 * 当前是否处于禁言中（含自动过期判定）。
 *
 * 【为什么用 nowForDb() 而不是 new Date()】banUntil 存的是「UTC+8 墙上时间」
 * （banUser 按 nowForDb() + hours 计算 —— 写入与比较必须用同一把尺子）。
 * 若拿真实 UTC 的 new Date() 去比，两把尺子差 8 小时 —— 禁言 1 小时会实际生效 9 小时。
 * 比较双方必须用同一个时钟。见 src/lib/db-time.ts。
 */
export function isCurrentlyBanned(
  // 接受 null：getCurrentUser() 返回 SafeUser | null，三个角色函数也都收 | null。
  // 若此处不收，调用方漏判 null 就是 TypeError → 500。签名保持一致，未登录视为未禁言
  //（是否放行由调用方的登录检查负责，不是本函数的职责）。
  u: { isBanned?: boolean | null; banUntil?: Date | null } | null | undefined
): boolean {
  if (!u || !u.isBanned) return false;
  if (u.banUntil && nowForDb() > u.banUntil) return false; // 已过期
  return true;
}
