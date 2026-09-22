// ─────────────────────────────────────────────────────────────────────────────
// admin-stats-service.ts — 站点概览
//
// 运维台打开时先看到的那个屏。回答的是「现在站点是什么状态」：
// 有多少人、多少内容、**多少被删的东西**、多少待处理的申诉。
//
// 【为什么没有鱼干那一组】这里原本报 account_sync_ledger 的 pending / failed /
// compensated（当年的远端同步 outbox）。账户服务搬进站内后，新写的登记行一律是
// synced、本地写入也不再产生补偿，那三个数恒为 0 —— 一个永远显示 0 的卡片比没有更糟
// （运维会以为「对账过了」，实际是没人再往里写）。
//
// 【「今天」必须走 dayStart(todayStr())】不能用 `new Date().setHours(0,0,0,0)` ——
// 本库时间戳是「UTC+8 墙上时间贴 Z 标签」（见 db-time.ts），拿真实 UTC 去算零点，
// 在 UTC+8 的机器上「今天」会从早上 8 点开始，当日计数整天错位。这是 audit-service
// 已经踩过并写在注释里的坑。
//
// 【banned 按「此刻真的被禁言」算】不是简单的 `isBanned: true` 计数 ——
// 禁言到期后 isBanned 标志位不会自动清（没有定时任务），所以要跟 isCurrentlyBanned
// 同一口径：banUntil 为空、或者还没到。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { dayStart, nowForDb, todayStr } from './db-time';
import { ROLES, type Role } from './admin-user-service';

export interface SiteStats {
  users: {
    total: number;
    byRole: Record<Role, number>;
    banned: number;
    newToday: number;
    new7d: number;
  };
  blogs: { total: number; deleted: number; newToday: number };
  comments: { total: number; deleted: number; newToday: number };
  clips: { total: number; deleted: number; private: number };
  images: { total: number; deleted: number; storageBytes: number };
  // ⚠️ 与 images 是**两份不同的磁盘占用**，运维算总量要相加 —— 音频不吃图床的配额，
  //    它是独立的一块盘。漏了这一块，站长看到的占用数字会少掉整个音频池
  //    却「看着是对的」。
  audio: { total: number; deleted: number; storageBytes: number };
  votes: { total: number; deleted: number; records: number };
  appeals: { pending: number };
}

export async function getSiteStats(): Promise<SiteStats> {
  const now = nowForDb();
  const todayStart = dayStart(todayStr());
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const [
    usersByRole,
    banned,
    usersNewToday,
    usersNew7d,
    blogsTotal,
    blogsDeleted,
    blogsNewToday,
    commentsTotal,
    commentsDeleted,
    commentsNewToday,
    clipsTotal,
    clipsDeleted,
    clipsPrivate,
    imagesTotal,
    imagesDeleted,
    storageAgg,
    audioTotal,
    audioDeleted,
    audioStorageAgg,
    votesTotal,
    votesDeleted,
    voteRecords,
    appealsPending,
  ] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    // 与 auth.ts 的 isCurrentlyBanned 同口径：禁言已过期的不算「当前被禁言」
    prisma.user.count({
      where: { isBanned: true, OR: [{ banUntil: null }, { banUntil: { gt: now } }] },
    }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.blog.count(),
    prisma.blog.count({ where: { ignore: true } }),
    prisma.blog.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.blogComment.count(),
    prisma.blogComment.count({ where: { isDeleted: true } }),
    prisma.blogComment.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.clipBoard.count(),
    prisma.clipBoard.count({ where: { ignore: true } }),
    prisma.clipBoard.count({ where: { publicity: false, ignore: false } }),
    prisma.imageHosting.count(),
    prisma.imageHosting.count({ where: { ignore: true } }),
    // ★ 磁盘占用统计的是**全部**行，含已软删 —— 软删只翻标志位，文件还躺在
    //   instance/images/ 里。运维要的是「这块盘被占了多少」，不是「有效图片有多大」。
    //   注意这与 image-service.getTotalStorageBytes()（只算未软删，图床管理页在用）
    //   是两个不同的口径，别互相替换。
    prisma.imageHosting.aggregate({ _sum: { fileSize: true } }),
    prisma.audioHosting.count(),
    prisma.audioHosting.count({ where: { ignore: true } }),
    // 音频床与图床同一口径：统计**全部**行含已软删（文件还在 instance/audio/）。
    prisma.audioHosting.aggregate({ _sum: { fileSize: true } }),
    prisma.vote.count(),
    prisma.vote.count({ where: { ignore: true } }),
    prisma.voteRecord.count(),
    prisma.adminActionAppeal.count({ where: { status: 'pending' } }),
  ]);

  const byRole = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
  for (const row of usersByRole) {
    const role = row.role as Role;
    if (role in byRole) byRole[role] = row._count._all;
  }

  return {
    users: {
      total: ROLES.reduce((sum, r) => sum + byRole[r], 0),
      byRole,
      banned,
      newToday: usersNewToday,
      new7d: usersNew7d,
    },
    blogs: { total: blogsTotal, deleted: blogsDeleted, newToday: blogsNewToday },
    comments: { total: commentsTotal, deleted: commentsDeleted, newToday: commentsNewToday },
    clips: { total: clipsTotal, deleted: clipsDeleted, private: clipsPrivate },
    images: { total: imagesTotal, deleted: imagesDeleted, storageBytes: storageAgg._sum.fileSize ?? 0 },
    audio: {
      total: audioTotal,
      deleted: audioDeleted,
      storageBytes: audioStorageAgg._sum.fileSize ?? 0,
    },
    votes: { total: votesTotal, deleted: votesDeleted, records: voteRecords },
    appeals: { pending: appealsPending },
  };
}
