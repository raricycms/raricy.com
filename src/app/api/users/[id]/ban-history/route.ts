// GET /api/users/[id]/ban-history
//   查询某用户的禁言历史。
//   返回 { user: {...}, ban_history: [...] }；ban_history 只取最近 10 条，banned_at 倒序。
//   权限：需登录 + 核心用户（core+）即可查询（不是站长专属）。
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { apiOk, apiErr } from '@/lib/format';
import { nowForDb } from '@/lib/db-time';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!isCoreUser(me)) return apiErr(403, '需要认证用户权限');

  const { id } = await ctx.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return apiErr(404, '用户不存在');

  const bans = await prisma.userBan.findMany({
    where: { userId: id },
    orderBy: { bannedAt: 'desc' },
    take: 10,
    include: {
      admin: { select: { username: true } },
      lifter: { select: { username: true } },
    },
  });

  // 对外字段一律 snake_case：前端按此形状消费，改名要同步前端
  const ban_history = bans.map((b) => ({
    id: b.id,
    user_id: b.userId,
    admin_id: b.adminId,
    admin_username: b.admin ? b.admin.username : null,
    banned_at: iso(b.bannedAt),
    ban_until: iso(b.banUntil),
    reason: b.reason,
    is_lifted: b.isLifted,
    lifted_at: iso(b.liftedAt),
    lifted_by: b.lifter ? b.lifter.username : null,
  }));

  // 含 ban_info：仅当前仍被禁言时返回，否则 null
  // ⚠️ 比较双方必须同一把钟：banUntil 存的是「UTC+8 墙上时间贴 Z」（见 db-time.ts），
  // 若用真实 UTC 的 new Date() 比对会差 8 小时 —— 禁言到期后仍显示「禁言中」8 小时。
  const now = nowForDb();
  const currentlyBanned =
    !!user.isBanned && (user.banUntil == null || now <= user.banUntil);
  const ban_info = currentlyBanned
    ? {
        is_banned: true,
        ban_until: iso(user.banUntil),
        reason: user.banReason,
        remaining_hours: user.banUntil
          ? (user.banUntil.getTime() - now.getTime()) / 3600000
          : null,
      }
    : null;

  // ⚠️【刻意不含 email】本接口只要求 core，带上 email 等于把全站邮箱开放给任何一个
  // 邀请码持有者（公开资料接口反而明确排除 email）。本接口的用途是禁言历史，
  // UI 也没用到 email。
  const userDict = {
    id: user.id,
    username: user.username,
    avatar_path: user.avatarPath,
    bio: user.bio ?? '',
    created_at: iso(user.createdAt),
    last_login: iso(user.lastLogin),
    role: user.role ?? 'user',
    notify_like: user.notifyLike ?? true,
    notify_edit: user.notifyEdit ?? true,
    notify_delete: user.notifyDelete ?? true,
    notify_admin: user.notifyAdmin ?? true,
    ban_info,
  };

  return apiOk({ user: userDict, ban_history });
}
