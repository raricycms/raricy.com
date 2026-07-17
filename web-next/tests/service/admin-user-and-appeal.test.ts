// admin-user-service.ts + admin-appeal-service.ts —— 禁言 / 审计日志 / 申诉裁决
// （对齐 Flask app/web/auth/user_management.py + app/service/audit_log.py）
//
// 【为什么测这些】这两个 service 是全站权限最高、副作用最多、且失败最安静的一块：
//
//   1. 禁言不是「改一个 bool」，而是一次五写：user.isBanned/banUntil/banReason
//      + UserBan 历史 + sessionVersion++（强制下线）+ AdminActionLog + 通知。
//      漏掉 UserBan 历史 → 审计断链（CLAUDE.md 明确要求 ban_user 自动建历史）；
//      漏掉 sessionVersion++ → 被禁言的人当前会话还能继续发言，禁言形同虚设。
//   2. 自动过期：banUntil 过去了就不算禁言，靠 isCurrentlyBanned 纯函数判定，
//      DB 里 isBanned 仍是 true。service 层返回的 currentlyBanned 必须跟纯函数
//      口径一致，否则后台列表显示的禁言状态和实际拦截行为对不上。
//   3. 申诉通过要「撤销原操作」，三条撤销路径（解禁 / 恢复文章 / 恢复评论）各写
//      不同的表，其中恢复评论还要回补 Blog.commentsCount / lastCommentAt 冗余字段
//      —— 算错不报错，只会让列表页的评论数对不上详情页。
//   4. AdminActionLog.extra 在生产库里是 JSON 声明列（Flask/alembic 建的），Prisma 驱动层
//      拒读，写入走 raw UPDATE。本测试库由 `prisma db push` 从 schema（extra String?）
//      生成，列类型是 TEXT，所以这里「直接 select extra」其实读得到 —— 测试环境复现不了
//      生产的那个坑。故断言一律走 audit-service 同款的 CAST(extra AS TEXT)：
//      它在两种列类型下都对，也顺带覆盖了 listPublicLogs 的 raw 绕行路径。
//
// 【时间约定】本库时间戳语义是「UTC+8 墙上时间贴 Z 标签」（见 src/lib/db-time.ts），
// 写库一律走 nowForDb() = 真实 now + 8h。因此断言写入时间时不能拿 Date.now() 直接比，
// 要加 SITE_TZ_OFFSET_MS。下面 banUntil 的用例把这条语义显式钉住。
//
// 跑真实 SQLite（tests/.tmp/ 下的每进程临时库），不 mock Prisma —— 冗余计数、外键、
// 非空约束正是被测对象，mock 掉就什么也没测。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { isCurrentlyBanned, type SafeUser } from '@/lib/auth';
import {
  logAdminAction,
  banUser,
  unbanUser,
  setRole,
  listUsers,
} from '@/lib/admin-user-service';
import { createAppeal, listPublicLogs } from '@/lib/audit-service';
import { SITE_TZ_OFFSET_MS } from '@/lib/db-time';
import { adjudicate, listAppeals } from '@/lib/admin-appeal-service';
import { toContentHtml } from '@/lib/comment-service';

beforeEach(async () => {
  await resetDb();
});

// ── 本地工具 ────────────────────────────────────────────────────────────────

/** makeUser 返回完整 User（含 passwordHash）；service 只吃 SafeUser 形状，这里收窄。 */
const asActor = (u: { id: string; role: string }) => u as unknown as SafeUser;

const HOUR = 60 * 60 * 1000;

/**
 * 读 admin_action_logs.extra —— 与 audit-service 一致走 CAST(extra AS TEXT)。
 * 生产库里该列是 JSON 声明类型，Prisma 的 SQLite 连接器在驱动层拒绝 SELECT
 * （"Value JSON not supported"）；本测试库由 db push 建出来是 TEXT，直接 select
 * 反而读得到。用 CAST 是为了两种列类型下都成立，别依赖测试库那个「碰巧能读」。
 */
async function readExtra(logId: number): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT CAST(extra AS TEXT) AS extra FROM admin_action_logs WHERE id = ?',
    logId
  )) as Array<{ extra: string | null }>;
  return rows[0]?.extra ?? null;
}

/** 取某个 action 的最新一条日志（不含 extra，避免驱动层 JSON 读取报错）。 */
async function latestLog(action: string) {
  return prisma.adminActionLog.findFirst({
    where: { action },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      action: true,
      adminId: true,
      targetUserId: true,
      objectType: true,
      objectId: true,
      reason: true,
      visibility: true,
      createdAt: true,
    },
  });
}

/** 直接落库造一条日志（申诉相关用例只关心 action/objectType/objectId/targetUserId）。 */
async function makeLog(opts: {
  action: string;
  adminId: string;
  targetUserId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
}) {
  const log = await prisma.adminActionLog.create({
    data: {
      action: opts.action,
      adminId: opts.adminId,
      targetUserId: opts.targetUserId ?? null,
      objectType: opts.objectType ?? null,
      objectId: opts.objectId ?? null,
      reason: 'r',
      visibility: 'public',
      createdAt: new Date(),
    },
    select: { id: true },
  });
  return log.id;
}

/** 直接落库造评论：createdAt 单调递增，保证 lastCommentAt 断言唯一。 */
let clock = 0;
async function makeComment(opts: {
  blogId: string;
  authorId: string;
  isDeleted?: boolean;
  createdAt?: Date;
}) {
  const id = crypto.randomUUID();
  return prisma.blogComment.create({
    data: {
      id,
      blogId: opts.blogId,
      authorId: opts.authorId,
      parentId: null,
      rootId: null,
      content: 'c',
      contentHtml: toContentHtml('c'),
      status: 'approved',
      isDeleted: opts.isDeleted ?? false,
      likesCount: 0,
      createdAt: opts.createdAt ?? new Date(1700000000000 + ++clock * 1000),
      updatedAt: new Date(),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// logAdminAction —— 审计日志字段完整性
// ═══════════════════════════════════════════════════════════════════════════

describe('logAdminAction（审计日志写入）', () => {
  it('落全字段：action/adminId/targetUserId/objectType/objectId/reason 原样入库', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser();

    const id = await logAdminAction({
      action: 'test_action',
      adminId: admin.id,
      targetUserId: target.id,
      objectType: 'blog',
      objectId: 'blog-42',
      reason: '测试原因',
    });

    const log = await latestLog('test_action');
    expect(log).toMatchObject({
      id,
      action: 'test_action',
      adminId: admin.id,
      targetUserId: target.id,
      objectType: 'blog',
      objectId: 'blog-42',
      reason: '测试原因',
    });
  });

  it('metadata 落进 extra（JSON 文本），只能用 CAST(extra AS TEXT) 读回', async () => {
    const admin = await makeUser({ role: 'admin' });

    const id = await logAdminAction({
      action: 'test_meta',
      adminId: admin.id,
      metadata: { from: 'user', to: 'core', n: 1 },
    });

    expect(JSON.parse((await readExtra(id))!)).toEqual({ from: 'user', to: 'core', n: 1 });
  });

  it('extra 经 listPublicLogs 的 CAST 绕行 + parseExtra 原样往返（覆盖 raw 读取路径）', async () => {
    const admin = await makeUser({ role: 'admin' });
    await logAdminAction({
      action: 'test_roundtrip',
      adminId: admin.id,
      metadata: { hours: 24, nested: { k: 'v' } },
    });

    const { items } = await listPublicLogs({ action: 'test_roundtrip' });
    expect(items).toHaveLength(1);
    expect(items[0].extra).toEqual({ hours: 24, nested: { k: 'v' } });
  });

  it('没写 extra 的日志经 parseExtra 回退成 {}，不会炸也不会漏成 null', async () => {
    const admin = await makeUser({ role: 'admin' });
    await logAdminAction({ action: 'test_no_extra', adminId: admin.id });

    const { items } = await listPublicLogs({ action: 'test_no_extra' });
    expect(items[0].extra).toEqual({});
  });

  it('metadata 缺省或为空对象时不写 extra（保持 NULL，避免存 "{}" 噪音）', async () => {
    const admin = await makeUser({ role: 'admin' });

    const noMeta = await logAdminAction({ action: 'test_no_meta', adminId: admin.id });
    const emptyMeta = await logAdminAction({
      action: 'test_empty_meta',
      adminId: admin.id,
      metadata: {},
    });

    expect(await readExtra(noMeta)).toBeNull();
    expect(await readExtra(emptyMeta)).toBeNull();
  });

  it('visibility 默认 public（对齐 Flask log_admin_action），可显式覆盖', async () => {
    const admin = await makeUser({ role: 'admin' });

    await logAdminAction({ action: 'vis_default', adminId: admin.id });
    await logAdminAction({ action: 'vis_private', adminId: admin.id, visibility: 'private' });

    expect((await latestLog('vis_default'))!.visibility).toBe('public');
    expect((await latestLog('vis_private'))!.visibility).toBe('private');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// banUser
// ═══════════════════════════════════════════════════════════════════════════

describe('banUser（禁言）', () => {
  it('限时禁言：写 user 状态 + 建 UserBan 历史 + sessionVersion++ + 日志 + 通知（五写齐全）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core', sessionVersion: 3 });

    const before = Date.now();
    const r = await banUser({
      actor: asActor(admin),
      targetId: target.id,
      hours: 24,
      reason: '刷屏',
    });
    expect(r.ok).toBe(true);

    // 1) user 状态
    const u = await prisma.user.findUnique({ where: { id: target.id } });
    expect(u!.isBanned).toBe(true);
    expect(u!.banReason).toBe('刷屏');
    // banUntil = nowForDb() + hours = 真实 now + 8h + 24h（库时间戳是 UTC+8 墙上时间贴 Z）
    const expectedBanUntil = before + SITE_TZ_OFFSET_MS + 24 * HOUR;
    expect(u!.banUntil!.getTime()).toBeGreaterThanOrEqual(expectedBanUntil - 5000);
    expect(u!.banUntil!.getTime()).toBeLessThanOrEqual(expectedBanUntil + 5000);
    // 2) 强制下线：sessionVersion 必须 +1，否则被禁言者当前会话还能继续操作
    expect(u!.sessionVersion).toBe(4);

    // 3) UserBan 历史（CLAUDE.md：ban_user() 自动创建历史记录）
    const bans = await prisma.userBan.findMany({ where: { userId: target.id } });
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({
      userId: target.id,
      adminId: admin.id,
      reason: '刷屏',
      isLifted: false,
      liftedAt: null,
      liftedBy: null,
    });
    expect(bans[0].banUntil.getTime()).toBe(u!.banUntil!.getTime());
    expect((r as { banId: number }).banId).toBe(bans[0].id);

    // 4) 审计日志
    const log = await latestLog('ban_user');
    expect(log).toMatchObject({
      adminId: admin.id,
      targetUserId: target.id,
      objectType: 'user',
      objectId: target.id,
      reason: '刷屏',
      visibility: 'public',
    });
    expect(JSON.parse((await readExtra(log!.id))!)).toMatchObject({
      hours: 24,
      ban_until: u!.banUntil!.toISOString(),
    });

    // 5) 通知被禁言者（force 绕过 notifyAdmin 偏好）
    const notes = await prisma.notification.findMany({ where: { recipientId: target.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].action).toBe('禁言通知');
    expect(notes[0].actorId).toBe(admin.id);
    expect(notes[0].detail).toContain('刷屏');
  });

  // ⚠️ 已知不一致（只钉现状，不在测试里改源码）：
  // banUser 用 nowForDb()（= 真实 now + 8h，UTC+8 墙上时间贴 Z）算 banUntil，
  // 而 auth.isCurrentlyBanned 的过期判定用 `new Date()`（真实 UTC 瞬间）去比。
  // 两把尺子差 8 小时 → 实际禁言时长 = 下达时长 + 8h。
  // 若哪天把 isCurrentlyBanned 改成 nowForDb() 口径（或 banUntil 改回 new Date()），
  // 这条会红 —— 那正是修复信号，届时把断言里的 SITE_TZ_OFFSET_MS 去掉即可。
  it('【现状】banUntil 比下达时长多 8 小时：nowForDb() 写入 vs isCurrentlyBanned 用真实 now 判过期', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    const before = Date.now();
    await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: 'x' });

    const u = await prisma.user.findUnique({ where: { id: target.id } });
    const actualDuration = u!.banUntil!.getTime() - before;
    // 下达 1 小时，实际算出来是 9 小时
    expect(actualDuration).toBeGreaterThanOrEqual(9 * HOUR - 5000);
    expect(actualDuration).toBeLessThanOrEqual(9 * HOUR + 5000);

    // 后果：即便真实时间已过去 8 小时（远超 1 小时禁言期），仍被判为禁言中
    expect(
      isCurrentlyBanned({ isBanned: u!.isBanned, banUntil: u!.banUntil })
    ).toBe(true);
    const eightHoursLater = new Date(before + 8 * HOUR);
    expect(u!.banUntil!.getTime()).toBeGreaterThan(eightHoursLater.getTime());
  });

  it('force 生效：目标关掉 notifyAdmin 偏好也照样收到禁言通知', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });
    await prisma.user.update({ where: { id: target.id }, data: { notifyAdmin: false } });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: 'x' });

    expect(await prisma.notification.count({ where: { recipientId: target.id } })).toBe(1);
  });

  it('拒绝空原因 / 纯空白原因（400），且不产生任何副作用', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core', sessionVersion: 1 });

    for (const reason of ['', '   ']) {
      const r = await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason });
      expect(r).toMatchObject({ ok: false, code: 400 });
    }

    expect(await prisma.userBan.count()).toBe(0);
    expect(await prisma.adminActionLog.count()).toBe(0);
    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.sessionVersion).toBe(1);
  });

  it('禁言原因上限 200 字：200 通过，201 拒绝', async () => {
    const admin = await makeUser({ role: 'admin' });
    const t1 = await makeUser({ role: 'core' });
    const t2 = await makeUser({ role: 'core' });

    expect(
      await banUser({ actor: asActor(admin), targetId: t2.id, hours: 1, reason: 'x'.repeat(201) })
    ).toMatchObject({ ok: false, code: 400 });

    expect(
      (await banUser({ actor: asActor(admin), targetId: t1.id, hours: 1, reason: 'x'.repeat(200) }))
        .ok
    ).toBe(true);
  });

  it('hours 必须 > 0 且有限：0 / 负数 / NaN / Infinity 一律 400 —— 即「永久禁言」当前无法通过 banUser 下达', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    for (const hours of [0, -1, NaN, Infinity]) {
      const r = await banUser({ actor: asActor(admin), targetId: target.id, hours, reason: 'x' });
      expect(r).toMatchObject({ ok: false, code: 400 });
    }
    expect(await prisma.userBan.count()).toBe(0);
  });

  it('不能禁言自己（403）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const r = await banUser({
      actor: asActor(admin),
      targetId: admin.id,
      hours: 1,
      reason: 'x',
    });
    expect(r).toMatchObject({ ok: false, code: 403 });
  });

  it('用户不存在 → 404', async () => {
    const admin = await makeUser({ role: 'admin' });
    expect(
      await banUser({ actor: asActor(admin), targetId: 'nope', hours: 1, reason: 'x' })
    ).toMatchObject({ ok: false, code: 404 });
  });

  it('管理员和站长都禁言不了：连 owner 也不能禁言 admin —— 钉住现状（权限边界只看 target.role）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const admin = await makeUser({ role: 'admin' });
    const otherAdmin = await makeUser({ role: 'admin' });

    // admin 禁言 owner → 403（预期内）
    expect(
      await banUser({ actor: asActor(admin), targetId: owner.id, hours: 1, reason: 'x' })
    ).toMatchObject({ ok: false, code: 403 });

    // owner 禁言 admin → 同样 403：banUser 只看 target.role，不看 actor 的等级
    expect(
      await banUser({ actor: asActor(owner), targetId: otherAdmin.id, hours: 1, reason: 'x' })
    ).toMatchObject({ ok: false, code: 403 });

    expect(await prisma.userBan.count()).toBe(0);
  });

  it('普通 user 角色的 actor 也能禁言：banUser 内部不校验 actor 权限（依赖上层路由把关）', async () => {
    const nobody = await makeUser({ role: 'user' });
    const target = await makeUser({ role: 'core' });

    const r = await banUser({ actor: asActor(nobody), targetId: target.id, hours: 1, reason: 'x' });
    expect(r.ok).toBe(true); // 现状如此 —— 权限必须在调用方（route handler）拦住
  });

  it('已在禁言中 → 400，不重复建 UserBan', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '一次' });
    const r = await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '两次' });

    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.userBan.count({ where: { userId: target.id } })).toBe(1);
  });

  it('自动过期：banUntil 已过去的用户视为未禁言，可以再次被禁言（第二条历史）', async () => {
    const admin = await makeUser({ role: 'admin' });
    // 造历史数据：isBanned 仍是 true，但 banUntil 已过去 —— 时间列是 INTEGER 毫秒，
    // 直接给 Date 对象走 Prisma 即可，别在 SQL 里对它用 date()
    const target = await makeUser({
      role: 'core',
      isBanned: true,
      banUntil: new Date(Date.now() - 2 * HOUR),
      banReason: '旧的',
    });
    await prisma.userBan.create({
      data: {
        userId: target.id,
        adminId: admin.id,
        bannedAt: new Date(Date.now() - 3 * HOUR),
        banUntil: new Date(Date.now() - 2 * HOUR),
        reason: '旧的',
        isLifted: false,
      },
    });

    const r = await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: '新的' });
    expect(r.ok).toBe(true);
    expect(await prisma.userBan.count({ where: { userId: target.id } })).toBe(2);
    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.banReason).toBe('新的');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// unbanUser
// ═══════════════════════════════════════════════════════════════════════════

describe('unbanUser（解除禁言）', () => {
  it('清 user 禁言状态 + 标记 UserBan lifted/liftedAt/liftedBy + 日志 + 通知', async () => {
    const admin = await makeUser({ role: 'admin' });
    const lifter = await makeUser({ role: 'owner' });
    const target = await makeUser({ role: 'core' });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '刷屏' });

    const r = await unbanUser({ actor: asActor(lifter), targetId: target.id, reason: '误判' });
    expect(r.ok).toBe(true);

    const u = await prisma.user.findUnique({ where: { id: target.id } });
    expect(u).toMatchObject({ isBanned: false, banUntil: null, banReason: null });

    const ban = await prisma.userBan.findFirst({ where: { userId: target.id } });
    expect(ban!.isLifted).toBe(true);
    expect(ban!.liftedBy).toBe(lifter.id);
    expect(ban!.liftedAt).toBeInstanceOf(Date);

    const log = await latestLog('unban_user');
    expect(log).toMatchObject({
      adminId: lifter.id,
      targetUserId: target.id,
      objectType: 'user',
      objectId: target.id,
      reason: '误判',
    });

    const note = await prisma.notification.findFirst({
      where: { recipientId: target.id, action: '解除禁言' },
    });
    expect(note!.detail).toContain('误判');
  });

  it('解禁不回滚 sessionVersion：被禁言时踢下线的会话不会因解禁而复活', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core', sessionVersion: 0 });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: 'x' });
    await unbanUser({ actor: asActor(admin), targetId: target.id });

    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.sessionVersion).toBe(1);
  });

  it('只标记「最近一条未解除」的 UserBan，历史上已解除的记录不被改写', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    // 一条陈年旧账：早已解除
    const old = await prisma.userBan.create({
      data: {
        userId: target.id,
        adminId: admin.id,
        bannedAt: new Date(Date.now() - 10 * HOUR),
        banUntil: new Date(Date.now() - 9 * HOUR),
        reason: '旧的',
        isLifted: true,
        liftedAt: new Date(Date.now() - 9 * HOUR),
        liftedBy: admin.id,
      },
    });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '新的' });
    await unbanUser({ actor: asActor(admin), targetId: target.id });

    const oldAfter = await prisma.userBan.findUnique({ where: { id: old.id } });
    expect(oldAfter!.liftedAt!.getTime()).toBe(old.liftedAt!.getTime()); // 未被改写

    const fresh = await prisma.userBan.findFirst({
      where: { userId: target.id, reason: '新的' },
    });
    expect(fresh!.isLifted).toBe(true);
  });

  it('用户未被禁言 → 400，不写日志不发通知', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    expect(await unbanUser({ actor: asActor(admin), targetId: target.id })).toMatchObject({
      ok: false,
      code: 400,
    });
    expect(await prisma.adminActionLog.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('禁言已自然过期 → unbanUser 返回 400，isBanned=true 的脏标志留在库里清不掉（现状）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({
      role: 'core',
      isBanned: true,
      banUntil: new Date(Date.now() - HOUR),
      banReason: '过期的',
    });

    // isCurrentlyBanned 已判为 false → unbanUser 直接拒绝
    expect(await unbanUser({ actor: asActor(admin), targetId: target.id })).toMatchObject({
      ok: false,
      code: 400,
    });

    const u = await prisma.user.findUnique({ where: { id: target.id } });
    expect(u!.isBanned).toBe(true); // 标志位没被清理，只靠读取时的过期判定兜底
    expect(isCurrentlyBanned({ isBanned: u!.isBanned, banUntil: u!.banUntil })).toBe(false);
  });

  it('用户不存在 → 404；原因超 200 字 → 400', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });
    await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: 'x' });

    expect(await unbanUser({ actor: asActor(admin), targetId: 'nope' })).toMatchObject({
      ok: false,
      code: 404,
    });
    expect(
      await unbanUser({ actor: asActor(admin), targetId: target.id, reason: 'x'.repeat(201) })
    ).toMatchObject({ ok: false, code: 400 });
  });

  it('不带 reason 时日志 reason 落 null、通知用默认文案', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });
    await banUser({ actor: asActor(admin), targetId: target.id, hours: 1, reason: 'x' });

    await unbanUser({ actor: asActor(admin), targetId: target.id });

    expect((await latestLog('unban_user'))!.reason).toBeNull();
    const note = await prisma.notification.findFirst({
      where: { recipientId: target.id, action: '解除禁言' },
    });
    expect(note!.detail).toBe('你的禁言已被解除');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listUsers.currentlyBanned —— service 层字段必须与 isCurrentlyBanned 纯函数同口径
// ═══════════════════════════════════════════════════════════════════════════

describe('listUsers 的 currentlyBanned 与 isCurrentlyBanned 口径一致', () => {
  it('未过期→true；已过期→false（isBanned 仍为 true）；未禁言→false', async () => {
    // banUntil 存的是「UTC+8 墙上时间」（banUser 按 nowForDb() + hours 算，
    // isCurrentlyBanned 也按 nowForDb() 比），故夹具必须同口径 —— 直接用
    // Date.now()（真实 UTC）+1h 在墙上时钟看来已是「8 小时前」，会被误判为已过期。
    const wallNow = () => Date.now() + 8 * 3600 * 1000;
    const active = await makeUser({
      username: 'zz_active',
      isBanned: true,
      banUntil: new Date(wallNow() + HOUR),
    });
    const expired = await makeUser({
      username: 'zz_expired',
      isBanned: true,
      banUntil: new Date(wallNow() - HOUR),
    });
    const clean = await makeUser({ username: 'zz_clean' });

    const { users } = await listUsers({ search: 'zz_' });
    const byId = new Map(users.map((u) => [u.id, u]));

    expect(byId.get(active.id)!.currentlyBanned).toBe(true);
    expect(byId.get(expired.id)!.currentlyBanned).toBe(false);
    expect(byId.get(expired.id)!.isBanned).toBe(true); // 原始标志位如实透出
    expect(byId.get(clean.id)!.currentlyBanned).toBe(false);
  });

  it('banUntil 为 null 且 isBanned=true（永久禁言的历史数据）→ currentlyBanned 为 true', async () => {
    // banUser 造不出这种数据（hours 必须 > 0），但 Flask 时代/人工改库可能留下，
    // isCurrentlyBanned 对它的判定是「永久有效」—— 钉住这条语义
    const u = await makeUser({ username: 'zz_forever', isBanned: true, banUntil: null });

    const { users } = await listUsers({ search: 'zz_forever' });
    expect(users[0].currentlyBanned).toBe(true);
    expect(users[0].banUntil).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setRole
// ═══════════════════════════════════════════════════════════════════════════

describe('setRole（角色变更）', () => {
  it('admin 可提升 user→core，并写 change_role 日志（extra 记 from/to）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'user' });

    const r = await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'core' });
    expect(r).toMatchObject({ ok: true, role: 'core' });
    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.role).toBe('core');

    const log = await latestLog('change_role');
    expect(log).toMatchObject({ adminId: admin.id, targetUserId: target.id, objectType: 'user' });
    expect(JSON.parse((await readExtra(log!.id))!)).toEqual({ from: 'user', to: 'core' });
  });

  it('★ admin 不能任命 admin —— 接口收任意角色，UI 没按钮不等于挡住', async () => {
    const admin = await makeUser({ role: 'admin' });
    const plain = await makeUser({ role: 'user' });

    // 实测过：此前这里返回 200，角色真的落库，管理员 curl 一发就能造出新管理员。
    // Flask 压根做不到 —— /promote 硬编码只做 user→core 且 @owner_required，
    // 想加管理员只能上服务器跑 flask promote-admin。
    expect(
      await setRole({ actor: asActor(admin), targetId: plain.id, newRole: 'admin' })
    ).toMatchObject({ ok: false, code: 403, message: '仅站长可变更管理员/站长角色' });
    expect((await prisma.user.findUnique({ where: { id: plain.id } }))!.role).toBe('user');
  });

  it('★ admin 也不能把另一个 admin 降成 user（判的是目标当前角色，不只是新角色）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'admin' });

    expect(
      await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'user' })
    ).toMatchObject({ ok: false, code: 403 });
    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.role).toBe('admin');
  });

  it('站长可以任命/卸任 admin', async () => {
    const owner = await makeUser({ role: 'owner' });
    const plain = await makeUser({ role: 'user' });

    expect((await setRole({ actor: asActor(owner), targetId: plain.id, newRole: 'admin' })).ok).toBe(
      true
    );
    expect((await setRole({ actor: asActor(owner), targetId: plain.id, newRole: 'user' })).ok).toBe(
      true
    );
  });

  it('user↔core（页面上的「认证 / 取消认证」）管理员仍然可以做 —— 这是日常工作，不该收到站长', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'user' });

    expect((await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'core' })).ok).toBe(
      true
    );
    expect((await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'user' })).ok).toBe(
      true
    );
  });

  it('无效角色 → 400；不能改自己 → 403；目标不存在 → 404；角色未变化 → 400', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    expect(
      await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'superuser' })
    ).toMatchObject({ ok: false, code: 400 });
    expect(
      await setRole({ actor: asActor(admin), targetId: admin.id, newRole: 'owner' })
    ).toMatchObject({ ok: false, code: 403 });
    expect(await setRole({ actor: asActor(admin), targetId: 'nope', newRole: 'core' })).toMatchObject(
      { ok: false, code: 404 }
    );
    expect(
      await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'core' })
    ).toMatchObject({ ok: false, code: 400 });

    expect(await prisma.adminActionLog.count()).toBe(0);
  });

  it('涉及 owner 的任何方向都要站长权限：admin 既不能封 owner，也不能改 owner 的角色', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    const plain = await makeUser({ role: 'user' });

    // 目标要变成 owner
    expect(
      await setRole({ actor: asActor(admin), targetId: plain.id, newRole: 'owner' })
    ).toMatchObject({ ok: false, code: 403 });
    // 目标当前是 owner
    expect(
      await setRole({ actor: asActor(admin), targetId: owner.id, newRole: 'user' })
    ).toMatchObject({ ok: false, code: 403 });
  });

  it('站长可以任命新站长，也可以卸任别的站长', async () => {
    const owner = await makeUser({ role: 'owner' });
    const other = await makeUser({ role: 'owner' });
    const plain = await makeUser({ role: 'user' });

    expect((await setRole({ actor: asActor(owner), targetId: plain.id, newRole: 'owner' })).ok).toBe(
      true
    );
    expect((await setRole({ actor: asActor(owner), targetId: other.id, newRole: 'user' })).ok).toBe(
      true
    );
  });

  it('角色变更不递增 sessionVersion，也不发通知（与禁言路径不同）—— 钉住现状', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'user', sessionVersion: 5 });

    await setRole({ actor: asActor(admin), targetId: target.id, newRole: 'core' });

    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.sessionVersion).toBe(5);
    expect(await prisma.notification.count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createAppeal
// ═══════════════════════════════════════════════════════════════════════════

describe('createAppeal（提交申诉）', () => {
  it('正常提交：创建 status=pending 的申诉', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const logId = await makeLog({ action: 'ban_user', adminId: admin.id, targetUserId: user.id });

    const r = await createAppeal({ logId, appellantId: user.id, content: '  我没刷屏  ' });
    expect(r.ok).toBe(true);

    const a = await prisma.adminActionAppeal.findUnique({ where: { id: r.appealId! } });
    expect(a).toMatchObject({
      logId,
      appellantId: user.id,
      content: '我没刷屏', // trim 后入库
      status: 'pending',
      decision: null,
      decidedBy: null,
      decidedAt: null,
    });
  });

  it('内容为空 / 纯空白 / 超 2000 字 → 拒绝', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const logId = await makeLog({ action: 'ban_user', adminId: admin.id });

    for (const content of ['', '   ', 'x'.repeat(2001)]) {
      expect(await createAppeal({ logId, appellantId: user.id, content })).toMatchObject({
        ok: false,
        appealId: null,
      });
    }
    expect(await prisma.adminActionAppeal.count()).toBe(0);

    // 边界：正好 2000 字通过
    expect((await createAppeal({ logId, appellantId: user.id, content: 'x'.repeat(2000) })).ok).toBe(
      true
    );
  });

  it('对不存在的日志申诉 → 拒绝（否则会撞外键约束）', async () => {
    const user = await makeUser({ role: 'core' });
    expect(
      await createAppeal({ logId: 999999, appellantId: user.id, content: '啊' })
    ).toMatchObject({ ok: false, message: '日志不存在', appealId: null });
  });

  it('该日志已有 accepted 申诉 → 任何人都不能再申诉（一事不再理）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const u1 = await makeUser({ role: 'core' });
    const u2 = await makeUser({ role: 'core' });
    const logId = await makeLog({ action: 'ban_user', adminId: admin.id });

    await prisma.adminActionAppeal.create({
      data: {
        logId,
        appellantId: u1.id,
        content: '早先的',
        status: 'accepted',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 连原申诉人自己也不行
    for (const u of [u1, u2]) {
      expect(await createAppeal({ logId, appellantId: u.id, content: '再来一次' })).toMatchObject({
        ok: false,
        message: '该操作申诉已被通过，无法再次申诉',
      });
    }
  });

  it('同日志 + 同申诉人已有 pending → 拒绝重复申诉；换个人则允许', async () => {
    const admin = await makeUser({ role: 'admin' });
    const u1 = await makeUser({ role: 'core' });
    const u2 = await makeUser({ role: 'core' });
    const logId = await makeLog({ action: 'delete_blog', adminId: admin.id });

    expect((await createAppeal({ logId, appellantId: u1.id, content: '一' })).ok).toBe(true);
    expect(await createAppeal({ logId, appellantId: u1.id, content: '二' })).toMatchObject({
      ok: false,
      message: '该日志已存在你提交的待处理申诉',
    });
    // 另一个人对同一日志可以各自申诉
    expect((await createAppeal({ logId, appellantId: u2.id, content: '三' })).ok).toBe(true);
  });

  it('rejected 之后可以对同一日志再次申诉（只有 pending 和 accepted 才拦）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const logId = await makeLog({ action: 'delete_blog', adminId: admin.id });

    await prisma.adminActionAppeal.create({
      data: {
        logId,
        appellantId: user.id,
        content: '被驳回的',
        status: 'rejected',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect((await createAppeal({ logId, appellantId: user.id, content: '再申一次' })).ok).toBe(true);
  });

  it('每日 20 次上限：第 21 次拒绝，且只按「当日 + 本人」计数', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });

    // 造 20 条今天的申诉（用不同日志绕开「同日志 pending 唯一」的前置拦截）
    for (let i = 0; i < 20; i++) {
      const logId = await makeLog({ action: 'delete_blog', adminId: admin.id });
      await prisma.adminActionAppeal.create({
        data: {
          logId,
          appellantId: user.id,
          content: `第 ${i}`,
          status: 'pending',
          // 与 createAppeal 的窗口同口径：库内时间戳是「UTC+8 墙上时间」（见 db-time.ts），
          // 用真实 UTC 的 new Date() 造夹具会落到今日窗口之前，导致计数为 0。
          createdAt: new Date(Date.now() + 8 * 3600 * 1000),
          updatedAt: new Date(Date.now() + 8 * 3600 * 1000),
        },
      });
    }
    // 昨天的不计入
    const oldLog = await makeLog({ action: 'delete_blog', adminId: admin.id });
    await prisma.adminActionAppeal.create({
      data: {
        logId: oldLog,
        appellantId: user.id,
        content: '昨天的',
        status: 'pending',
        createdAt: new Date(Date.now() - 25 * HOUR),
        updatedAt: new Date(),
      },
    });

    const freshLog = await makeLog({ action: 'delete_blog', adminId: admin.id });
    expect(await createAppeal({ logId: freshLog, appellantId: user.id, content: '第 21' })).toMatchObject(
      { ok: false, message: '今日申诉次数已达上限（20次）' }
    );

    // 别人的额度不受影响
    expect((await createAppeal({ logId: freshLog, appellantId: other.id, content: '我第一次' })).ok).toBe(
      true
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// adjudicate —— 裁决 + 通过时撤销原操作
// ═══════════════════════════════════════════════════════════════════════════

describe('adjudicate（裁决申诉）', () => {
  /** 造「日志 + 该日志的 pending 申诉」。 */
  async function makePendingAppeal(opts: {
    action: string;
    adminId: string;
    appellantId: string;
    targetUserId?: string | null;
    objectType?: string | null;
    objectId?: string | null;
  }) {
    const logId = await makeLog(opts);
    const appeal = await prisma.adminActionAppeal.create({
      data: {
        logId,
        appellantId: opts.appellantId,
        content: '申诉内容',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      select: { id: true },
    });
    return { logId, appealId: appeal.id };
  }

  it('accept：置 status/decision/decidedBy/decidedAt + 写 decide_appeal 日志 + 通知申诉人', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const { logId, appealId } = await makePendingAppeal({
      action: 'other_action',
      adminId: admin.id,
      appellantId: user.id,
    });

    const r = await adjudicate({
      actor: asActor(admin),
      appealId,
      decision: 'accept',
      note: '确实误判',
    });
    expect(r.ok).toBe(true);

    const a = await prisma.adminActionAppeal.findUnique({ where: { id: appealId } });
    expect(a).toMatchObject({ status: 'accepted', decision: '确实误判', decidedBy: admin.id });
    expect(a!.decidedAt).toBeInstanceOf(Date);

    const log = await latestLog('decide_appeal');
    expect(log).toMatchObject({
      adminId: admin.id,
      objectType: 'admin_action_appeal',
      objectId: String(appealId),
      reason: '确实误判',
    });
    expect(JSON.parse((await readExtra(log!.id))!)).toEqual({
      appeal_id: appealId,
      result: 'accepted',
      log_id: logId,
    });

    const note = await prisma.notification.findFirst({
      where: { recipientId: user.id, action: '申诉结果' },
    });
    expect(note!.detail).toContain('申诉通过');
  });

  it('accept + ban_user → 自动解禁：user 状态清空 + UserBan 标记 lifted + 补 unban_user 日志', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '刷屏' });
    const { appealId } = await makePendingAppeal({
      action: 'ban_user',
      adminId: admin.id,
      appellantId: target.id,
      targetUserId: target.id,
      objectType: 'user',
      objectId: target.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);

    const u = await prisma.user.findUnique({ where: { id: target.id } });
    expect(u).toMatchObject({ isBanned: false, banUntil: null, banReason: null });

    const ban = await prisma.userBan.findFirst({ where: { userId: target.id } });
    expect(ban!.isLifted).toBe(true);
    expect(ban!.liftedBy).toBe(admin.id);

    expect(await latestLog('unban_user')).not.toBeNull();

    const note = await prisma.notification.findFirst({
      where: { recipientId: target.id, action: '申诉结果' },
    });
    expect(note!.detail).toContain('已自动解除禁言');
  });

  it('accept + ban_user 但禁言已自然过期 → 撤销静默失败，裁决仍成功（不 rollback）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({
      role: 'core',
      isBanned: true,
      banUntil: new Date(Date.now() - HOUR),
    });
    const { appealId } = await makePendingAppeal({
      action: 'ban_user',
      adminId: admin.id,
      appellantId: target.id,
      targetUserId: target.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);
    expect((await prisma.adminActionAppeal.findUnique({ where: { id: appealId } }))!.status).toBe(
      'accepted'
    );

    // unbanUser 返回了 ok:false 并被忽略 → 脏标志位仍在，通知里也不会提"已自动解除禁言"
    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.isBanned).toBe(true);
    const note = await prisma.notification.findFirst({
      where: { recipientId: target.id, action: '申诉结果' },
    });
    expect(note!.detail).not.toContain('已自动解除禁言');
  });

  it('accept + delete_blog → Blog.ignore 复位为 false', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id, ignore: true });

    const { appealId } = await makePendingAppeal({
      action: 'delete_blog',
      adminId: admin.id,
      appellantId: author.id,
      targetUserId: author.id,
      objectType: 'blog',
      objectId: blog.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.ignore).toBe(false);

    const note = await prisma.notification.findFirst({
      where: { recipientId: author.id, action: '申诉结果' },
    });
    expect(note!.detail).toContain('已恢复被删文章');
  });

  it('accept + delete_blog：文章本就未删除 / 文章已不存在 → 不报错，只是没有恢复提示', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const alive = await makeBlog({ authorId: author.id, ignore: false });

    const a1 = await makePendingAppeal({
      action: 'delete_blog',
      adminId: admin.id,
      appellantId: author.id,
      objectType: 'blog',
      objectId: alive.id,
    });
    expect(
      (await adjudicate({ actor: asActor(admin), appealId: a1.appealId, decision: 'accept' })).ok
    ).toBe(true);

    const a2 = await makePendingAppeal({
      action: 'delete_blog',
      adminId: admin.id,
      appellantId: author.id,
      objectType: 'blog',
      objectId: 'ghost-blog',
    });
    expect(
      (await adjudicate({ actor: asActor(admin), appealId: a2.appealId, decision: 'accept' })).ok
    ).toBe(true);

    const notes = await prisma.notification.findMany({
      where: { recipientId: author.id, action: '申诉结果' },
    });
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.detail).not.toContain('已恢复被删文章');
  });

  it('accept + delete_comment → isDeleted 复位，并回补 Blog.commentsCount / lastCommentAt', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id });

    // c1 存活（早），c2 被删（晚）—— 恢复后 lastCommentAt 应前移到 c2
    const c1 = await makeComment({ blogId: blog.id, authorId: author.id });
    const c2 = await makeComment({ blogId: blog.id, authorId: author.id, isDeleted: true });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 1, lastCommentAt: c1.createdAt },
    });

    const { appealId } = await makePendingAppeal({
      action: 'delete_comment',
      adminId: admin.id,
      appellantId: author.id,
      targetUserId: author.id,
      objectType: 'comment',
      objectId: c2.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);

    expect((await prisma.blogComment.findUnique({ where: { id: c2.id } }))!.isDeleted).toBe(false);

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(2);
    expect(b!.lastCommentAt!.getTime()).toBe(c2.createdAt!.getTime());

    const note = await prisma.notification.findFirst({
      where: { recipientId: author.id, action: '申诉结果' },
    });
    expect(note!.detail).toContain('已恢复被删评论');
  });

  it('accept + delete_comment：评论未被删 → 不重算计数（幂等，不会把计数越加越多）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id });
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 1, lastCommentAt: c.createdAt },
    });

    const { appealId } = await makePendingAppeal({
      action: 'delete_comment',
      adminId: admin.id,
      appellantId: author.id,
      objectType: 'comment',
      objectId: c.id,
    });
    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);

    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.commentsCount).toBe(1);
  });

  it('撤销路径靠 objectType 把关：action 对但 objectType 不匹配 → 不撤销', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id, ignore: true });

    const { appealId } = await makePendingAppeal({
      action: 'delete_blog',
      adminId: admin.id,
      appellantId: author.id,
      objectType: 'post', // 不是 'blog'
      objectId: blog.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.ignore).toBe(true);
  });

  it('reject：只置状态，绝不撤销原操作（禁言/删文照旧生效）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: target.id, ignore: true });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '刷屏' });
    const banAppeal = await makePendingAppeal({
      action: 'ban_user',
      adminId: admin.id,
      appellantId: target.id,
      targetUserId: target.id,
    });
    const blogAppeal = await makePendingAppeal({
      action: 'delete_blog',
      adminId: admin.id,
      appellantId: target.id,
      objectType: 'blog',
      objectId: blog.id,
    });

    for (const { appealId } of [banAppeal, blogAppeal]) {
      expect(
        (await adjudicate({ actor: asActor(admin), appealId, decision: 'reject', note: '维持原判' }))
          .ok
      ).toBe(true);
      const a = await prisma.adminActionAppeal.findUnique({ where: { id: appealId } });
      expect(a).toMatchObject({ status: 'rejected', decision: '维持原判' });
    }

    // 禁言仍在、文章仍是软删除态
    const u = await prisma.user.findUnique({ where: { id: target.id } });
    expect(isCurrentlyBanned({ isBanned: u!.isBanned, banUntil: u!.banUntil })).toBe(true);
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.ignore).toBe(true);
    expect(await latestLog('unban_user')).toBeNull();

    const note = await prisma.notification.findFirst({
      where: { recipientId: target.id, action: '申诉结果' },
    });
    expect(note!.detail).toContain('申诉驳回');
  });

  it('重复裁决 → 400「申诉已处理」，不二次撤销、不二次通知', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ role: 'core' });

    await banUser({ actor: asActor(admin), targetId: target.id, hours: 24, reason: '刷屏' });
    const { appealId } = await makePendingAppeal({
      action: 'ban_user',
      adminId: admin.id,
      appellantId: target.id,
      targetUserId: target.id,
    });

    expect((await adjudicate({ actor: asActor(admin), appealId, decision: 'accept' })).ok).toBe(true);
    const decideLogs = await prisma.adminActionLog.count({ where: { action: 'decide_appeal' } });

    // 第二次：不管 accept 还是 reject 都应被挡在门外
    expect(await adjudicate({ actor: asActor(admin), appealId, decision: 'reject' })).toMatchObject({
      ok: false,
      code: 400,
      message: '申诉已处理',
    });
    expect(await prisma.adminActionLog.count({ where: { action: 'decide_appeal' } })).toBe(
      decideLogs
    );
    // 状态没被 reject 覆盖
    expect((await prisma.adminActionAppeal.findUnique({ where: { id: appealId } }))!.status).toBe(
      'accepted'
    );
  });

  it('裁决不存在的申诉 → 404；无效 decision → 400', async () => {
    const admin = await makeUser({ role: 'admin' });

    expect(
      await adjudicate({ actor: asActor(admin), appealId: 999999, decision: 'accept' })
    ).toMatchObject({ ok: false, code: 404 });

    expect(
      await adjudicate({
        actor: asActor(admin),
        appealId: 999999,
        decision: 'maybe' as 'accept',
      })
    ).toMatchObject({ ok: false, code: 400, message: '无效处理结果' });
  });

  it('不带 note 时 decision 落空串、日志 reason 用默认文案', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'core' });
    const { appealId } = await makePendingAppeal({
      action: 'other_action',
      adminId: admin.id,
      appellantId: user.id,
    });

    await adjudicate({ actor: asActor(admin), appealId, decision: 'reject' });

    expect((await prisma.adminActionAppeal.findUnique({ where: { id: appealId } }))!.decision).toBe(
      ''
    );
    expect((await latestLog('decide_appeal'))!.reason).toBe('申诉驳回');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listAppeals —— 裁决前后在列表里的呈现
// ═══════════════════════════════════════════════════════════════════════════

describe('listAppeals（申诉列表）', () => {
  it('按 status 过滤，带出日志/申诉人/裁决人；裁决后从 pending 移到 accepted', async () => {
    const admin = await makeUser({ role: 'admin', username: 'the_admin' });
    const user = await makeUser({ role: 'core', username: 'the_user' });
    const logId = await makeLog({
      action: 'delete_blog',
      adminId: admin.id,
      targetUserId: user.id,
      objectType: 'blog',
      objectId: 'b1',
    });
    const appeal = await prisma.adminActionAppeal.create({
      data: {
        logId,
        appellantId: user.id,
        content: '求恢复',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      select: { id: true },
    });

    const before = await listAppeals({ status: 'pending' });
    expect(before.total).toBe(1);
    expect(before.items[0]).toMatchObject({
      id: appeal.id,
      content: '求恢复',
      status: 'pending',
      decider: null,
    });
    expect(before.items[0].appellant.username).toBe('the_user');
    expect(before.items[0].log).toMatchObject({
      id: logId,
      action: 'delete_blog',
      objectType: 'blog',
      objectId: 'b1',
    });
    expect(before.items[0].log!.admin.username).toBe('the_admin');

    await adjudicate({ actor: asActor(admin), appealId: appeal.id, decision: 'accept', note: 'ok' });

    expect((await listAppeals({ status: 'pending' })).total).toBe(0);
    const after = await listAppeals({ status: 'accepted' });
    expect(after.total).toBe(1);
    expect(after.items[0].decider!.username).toBe('the_admin');
    expect(after.items[0].decidedAt).not.toBeNull();
  });
});
