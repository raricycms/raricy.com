// ─────────────────────────────────────────────────────────────────────────────
// admin-ops-services.test.ts —— 运维侧的最后一批服务
//   重置密码 / 强制下线 / 邀请码列表与撤销 / 管理端审计检索 / 文章搜索范围
//
// 最值得盯的不是「功能通不通」，而是两条**安全**断言：
//   ★ 审计日志里绝不能出现新密码
//   ★ 审计日志里绝不能出现邀请码本身（/audit 是公开页，码就是注册凭证）
// 这两条一旦破了不会有任何报错，只会静默地把凭证晒在公开页上。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeBlog, makeUser, prisma, resetDb } from '../helpers/db';
import { forceLogout, resetUserPassword } from '@/lib/admin-user-service';
import { listInviteCodes, revokeInviteCode } from '@/lib/invite-code';
import { listAdminLogs } from '@/lib/audit-service';
import { listAdminBlogs } from '@/lib/admin-blog-service';
import { verifyPassword } from '@/lib/password';
import { nowForDb } from '@/lib/db-time';
import type { SafeUser } from '@/lib/auth';

function asActor(u: { id: string; role: string }): SafeUser {
  return u as unknown as SafeUser;
}

beforeEach(async () => {
  await resetDb();
});

// ── 重置密码 ─────────────────────────────────────────────────────────────────

describe('resetUserPassword', () => {
  it('★ 递增 sessionVersion（旧会话立即失效）+ 新密码真的能验过', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser({ role: 'core', sessionVersion: 5 });

    const r = await resetUserPassword({
      actor: asActor(owner),
      targetId: target.id,
      newPassword: 'brand-new-pass',
      reason: '用户申诉邮箱被盗',
    });

    expect(r.ok).toBe(true);
    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.sessionVersion).toBe(6);
    expect(await verifyPassword('brand-new-pass', after!.passwordHash)).toBe(true);
  });

  it('★ 审计日志里搜不到新密码', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser({ role: 'core' });
    const pw = 'super-secret-pw-123';

    await resetUserPassword({
      actor: asActor(owner),
      targetId: target.id,
      newPassword: pw,
      reason: '测试',
    });

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'reset_password' } });
    expect(log).not.toBeNull();
    // reason 与 extra 里都不能有 —— /audit 是公开页
    expect(log!.reason).not.toContain(pw);
    const extra = await prisma.$queryRawUnsafe<Array<{ extra: string | null }>>(
      `SELECT CAST(extra AS TEXT) AS extra FROM admin_action_logs WHERE id = ${log!.id}`
    );
    expect(JSON.stringify(extra)).not.toContain(pw);
  });

  it('newPassword=null → 生成随机密码，且长度足够', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser();
    const r = await resetUserPassword({
      actor: asActor(owner),
      targetId: target.id,
      newPassword: null,
      reason: '忘了密码',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.generated).toBe(true);
      expect(r.password.length).toBe(16);
      const after = await prisma.user.findUnique({ where: { id: target.id } });
      expect(await verifyPassword(r.password, after!.passwordHash)).toBe(true);
    }
  });

  it('两次生成的随机密码不同（不是固定串）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const a = await makeUser();
    const b = await makeUser();
    const r1 = await resetUserPassword({ actor: asActor(owner), targetId: a.id, newPassword: null, reason: 'x' });
    const r2 = await resetUserPassword({ actor: asActor(owner), targetId: b.id, newPassword: null, reason: 'x' });
    expect(r1.ok && r2.ok && r1.password !== r2.password).toBe(true);
  });

  it('★ 不能重置自己的密码（CLI 免密重置自己 = 会话劫持原语）', async () => {
    const owner = await makeUser({ role: 'owner' });
    expect(
      await resetUserPassword({ actor: asActor(owner), targetId: owner.id, newPassword: null, reason: 'x' })
    ).toMatchObject({ ok: false, code: 403 });
  });

  it('非站长不能重置他人密码', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser();
    expect(
      await resetUserPassword({ actor: asActor(admin), targetId: target.id, newPassword: null, reason: 'x' })
    ).toMatchObject({ ok: false, code: 403 });
  });

  it('新密码短于 8 位 → 400（与网页端改密同一条底线）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser();
    expect(
      await resetUserPassword({ actor: asActor(owner), targetId: target.id, newPassword: '1234567', reason: 'x' })
    ).toMatchObject({ ok: false, code: 400, message: '新密码长度至少为 8 位' });
  });

  it('缺原因 → 400（原因会进公开审计，不能空着）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser();
    expect(
      await resetUserPassword({ actor: asActor(owner), targetId: target.id, newPassword: null, reason: '  ' })
    ).toMatchObject({ ok: false, code: 400 });
  });
});

// ── 强制下线 ─────────────────────────────────────────────────────────────────

describe('forceLogout', () => {
  it('递增 sessionVersion + 写审计 + 通知本人', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ sessionVersion: 3 });

    expect((await forceLogout({ actor: asActor(admin), targetId: target.id, reason: '排查中' })).ok).toBe(true);

    expect((await prisma.user.findUnique({ where: { id: target.id } }))!.sessionVersion).toBe(4);
    expect(await prisma.adminActionLog.count({ where: { action: 'force_logout' } })).toBe(1);
    expect(
      await prisma.notification.count({ where: { recipientId: target.id, action: '强制下线' } })
    ).toBe(1);
  });

  it('★ 不能强制自己下线', async () => {
    const admin = await makeUser({ role: 'admin' });
    expect(await forceLogout({ actor: asActor(admin), targetId: admin.id })).toMatchObject({
      ok: false,
      code: 403,
    });
  });

  it('普通用户不能强制他人下线', async () => {
    const plain = await makeUser({ role: 'user' });
    const target = await makeUser();
    expect(await forceLogout({ actor: asActor(plain), targetId: target.id })).toMatchObject({
      ok: false,
      code: 403,
    });
  });
});

// ── 邀请码 ───────────────────────────────────────────────────────────────────

describe('邀请码：列表与撤销', () => {
  async function makeCode(code: string, opts: { isUsed?: boolean | null; usedBy?: string | null } = {}) {
    return prisma.inviteCode.create({
      data: { code, isUsed: opts.isUsed ?? false, usedBy: opts.usedBy ?? null, createdAt: nowForDb() },
      select: { id: true },
    });
  }

  it('isUsed 为 null（历史数据）视同未使用', async () => {
    await makeCode('AAAAAAAAAAAA', { isUsed: null });
    await makeCode('BBBBBBBBBBBB', { isUsed: true });

    expect((await listInviteCodes({ filter: 'unused' })).total).toBe(1);
    expect((await listInviteCodes({ filter: 'used' })).total).toBe(1);
    expect((await listInviteCodes({ filter: 'all' })).total).toBe(2);
  });

  it('★ 撤销未使用的码 → 物理删除', async () => {
    const owner = await makeUser({ role: 'owner' });
    const row = await makeCode('CCCCCCCCCCCC');

    const r = await revokeInviteCode('CCCCCCCCCCCC', { id: owner.id, username: owner.username });
    expect(r.ok).toBe(true);
    expect(await prisma.inviteCode.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it('★ 拒绝撤销已使用的码（used_by 是「谁邀请了谁」的唯一记录）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const invitee = await makeUser();
    await makeCode('DDDDDDDDDDDD', { isUsed: true, usedBy: invitee.id });

    const r = await revokeInviteCode('DDDDDDDDDDDD', { id: owner.id, username: owner.username });
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.inviteCode.count()).toBe(1); // 还在
  });

  it('★ 审计日志里不出现码值（/audit 是公开页，码就是注册凭证）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const secretCode = 'EEEEEEEEEEEE';
    await makeCode(secretCode);

    await revokeInviteCode(secretCode, { id: owner.id, username: owner.username });

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'revoke_invite_code' } });
    expect(log).not.toBeNull();
    expect(log!.reason ?? '').not.toContain(secretCode);
    expect(log!.objectId ?? '').not.toContain(secretCode); // objectId 是数字 id
    const extra = await prisma.$queryRawUnsafe<Array<{ extra: string | null }>>(
      `SELECT CAST(extra AS TEXT) AS extra FROM admin_action_logs WHERE id = ${log!.id}`
    );
    expect(JSON.stringify(extra)).not.toContain(secretCode);
  });

  it('不存在的码 → 404', async () => {
    const owner = await makeUser({ role: 'owner' });
    expect(await revokeInviteCode('ZZZZZZZZZZZZ', { id: owner.id, username: owner.username })).toMatchObject(
      { ok: false, code: 404 }
    );
  });
});

// ── 管理端审计检索 ───────────────────────────────────────────────────────────

describe('listAdminLogs', () => {
  async function makeLog(opts: {
    action: string;
    adminId: string;
    visibility?: string;
    createdAt?: Date;
    extra?: string;
  }) {
    const log = await prisma.adminActionLog.create({
      data: {
        action: opts.action,
        adminId: opts.adminId,
        visibility: opts.visibility ?? 'public',
        createdAt: opts.createdAt ?? nowForDb(),
      },
      select: { id: true },
    });
    if (opts.extra) {
      await prisma.$executeRawUnsafe(
        'UPDATE admin_action_logs SET extra = ? WHERE id = ?',
        opts.extra,
        log.id
      );
    }
    return log;
  }

  it('★ 默认看得到 visibility=internal 的行（公示页看不到，运维要看到）', async () => {
    const owner = await makeUser({ role: 'owner' });
    await makeLog({ action: 'a', adminId: owner.id, visibility: 'public' });
    await makeLog({ action: 'b', adminId: owner.id, visibility: 'internal' });

    expect((await listAdminLogs({})).total).toBe(2);
    expect((await listAdminLogs({ visibility: 'internal' })).total).toBe(1);
    expect((await listAdminLogs({ visibility: 'public' })).total).toBe(1);
  });

  it('★ 不设 30 天窗口 —— 陈年日志也翻得到', async () => {
    const owner = await makeUser({ role: 'owner' });
    const old = new Date(nowForDb().getTime() - 90 * 24 * 3600 * 1000);
    await makeLog({ action: 'old', adminId: owner.id, createdAt: old });

    expect((await listAdminLogs({})).total).toBe(1);
    // 对照：公示页那条 30 天窗口会把它挡掉
    const { listPublicLogs } = await import('@/lib/audit-service');
    expect((await listPublicLogs({})).total).toBe(0);
  });

  it('extra 走 CAST 绕行能正常读回并解析（这列直接 select 会在运行时炸）', async () => {
    const owner = await makeUser({ role: 'owner' });
    await makeLog({
      action: 'with_extra',
      adminId: owner.id,
      extra: JSON.stringify({ from: 'user', to: 'core' }),
    });

    const { items } = await listAdminLogs({ action: 'with_extra' });
    expect(items[0].extra).toEqual({ from: 'user', to: 'core' });
  });

  it('按动作 / 执行者 / 时间窗筛', async () => {
    const alice = await makeUser({ username: 'alice', role: 'owner' });
    const bob = await makeUser({ username: 'bob', role: 'admin' });
    const old = new Date(nowForDb().getTime() - 10 * 24 * 3600 * 1000);
    await makeLog({ action: 'x', adminId: alice.id });
    await makeLog({ action: 'y', adminId: bob.id });
    await makeLog({ action: 'z', adminId: alice.id, createdAt: old });

    expect((await listAdminLogs({ action: 'x' })).total).toBe(1);
    expect((await listAdminLogs({ adminUsername: 'alice' })).total).toBe(2);
    expect((await listAdminLogs({ since: new Date(nowForDb().getTime() - 86_400_000) })).total).toBe(2);
  });
});

// ── 文章搜索范围 ─────────────────────────────────────────────────────────────

describe('listAdminBlogs 的 searchScope', () => {
  it('★ 默认（title）搜不到只出现在正文里的词 —— 网页后台行为不变', async () => {
    const author = await makeUser();
    await makeBlog({ authorId: author.id, title: '标题里没有那个词', content: '正文里有恐龙化石' });

    expect((await listAdminBlogs({ search: '恐龙' })).total).toBe(0);
  });

  it('★ searchScope=all 时正文、描述、作者、精确 id 都能命中', async () => {
    const author = await makeUser({ username: 'alice' });
    const target = await makeBlog({
      authorId: author.id,
      title: '标题甲',
      description: '描述里有翼龙',
      content: '正文里有恐龙化石',
    });

    expect((await listAdminBlogs({ search: '恐龙', searchScope: 'all' })).total).toBe(1);
    expect((await listAdminBlogs({ search: '翼龙', searchScope: 'all' })).total).toBe(1);
    expect((await listAdminBlogs({ search: 'alice', searchScope: 'all' })).total).toBe(1);
    expect((await listAdminBlogs({ search: target.id, searchScope: 'all' })).total).toBe(1);
  });

  it('标题命中在两种范围下都能搜到（放宽是超集，不是替换）', async () => {
    const author = await makeUser();
    await makeBlog({ authorId: author.id, title: '构建报错排查' });

    expect((await listAdminBlogs({ search: '报错' })).total).toBe(1);
    expect((await listAdminBlogs({ search: '报错', searchScope: 'all' })).total).toBe(1);
  });
});
