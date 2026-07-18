// GET /api/users/[id]/ban-history
//   查询某用户的禁言历史（对齐 Flask auth.user_ban_history）。
//   Flask 返回 { user: user.to_dict(), ban_history: [ban.to_dict() ...] }，最近 10 条 banned_at 倒序。
//   权限对齐 Flask user_ban_history 的 @authenticated_required：核心用户（core+）即可查询。
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { apiOk, apiErr } from '@/lib/format';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!isCoreUser(me)) return apiErr(403, '需要认证用户权限');

  const { id } = await ctx.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return apiErr(404, '用户不存在'); // 对齐 Flask get_or_404

  const bans = await prisma.userBan.findMany({
    where: { userId: id },
    orderBy: { bannedAt: 'desc' },
    take: 10,
    include: {
      admin: { select: { username: true } },
      lifter: { select: { username: true } },
    },
  });

  // 对齐 UserBan.to_dict()
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

  // 对齐 User.to_dict()（含 get_ban_info：仅当前仍被禁言时返回，否则 null）
  const currentlyBanned =
    !!user.isBanned && (user.banUntil == null || new Date() <= user.banUntil);
  const ban_info = currentlyBanned
    ? {
        is_banned: true,
        ban_until: iso(user.banUntil),
        reason: user.banReason,
        remaining_hours: user.banUntil
          ? (user.banUntil.getTime() - Date.now()) / 3600000
          : null,
      }
    : null;

  const userDict = {
    id: user.id,
    username: user.username,
    email: user.email,
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
