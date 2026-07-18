// ─────────────────────────────────────────────────────────────────────────────
// broadcast-service.test.ts —— 群发通知
//
// 【为什么补】群发此前一个测试都没有，于是权限写错了也没人发现：
// 路由只判 hasAdminRights，任何**管理员**都能给全站发通知 —— 而 Flask 在三处
// 都卡了**站长**（页面 @owner_required、接口 @owner_required、service 层显式判
// is_owner）。群发是本项目影响面最大的操作（一次触达全部 465 个用户），
// 权限松一级就是实打实的越权。
//
// 这里钉死的是「谁能群发」与「发给谁」，前者防越权，后者防错投。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { broadcast } from '@/lib/broadcast-service';
import type { SafeUser } from '@/lib/auth';

beforeEach(resetDb);

const asActor = (u: { id: string; role: string }): SafeUser => u as SafeUser;

describe('broadcast 权限（对齐 Flask 的仅站长可群发）', () => {
  it('★ 站长可以群发', async () => {
    const owner = await makeUser({ username: 'o', role: 'owner' });
    await makeUser({ username: 'u1', role: 'user' });

    const r = await broadcast({ actor: asActor(owner), detail: '全站公告' });
    expect(r.ok).toBe(true);
  });

  it('★ 管理员不能群发（此前是能的 —— 比 Flask 松了一级）', async () => {
    const admin = await makeUser({ username: 'a', role: 'admin' });
    await makeUser({ username: 'u1', role: 'user' });

    const r = await broadcast({ actor: asActor(admin), detail: '我是管理员' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(403);
      expect(r.message).toBe('没有站长权限');
    }
    // 一条都不该发出去
    expect(await prisma.notification.count()).toBe(0);
  });

  it('core 用户不能群发', async () => {
    const core = await makeUser({ username: 'c', role: 'core' });
    await makeUser({ username: 'u1', role: 'user' });
    const r = await broadcast({ actor: asActor(core), detail: 'x' });
    expect(r.ok).toBe(false);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('普通用户不能群发', async () => {
    const plain = await makeUser({ username: 'p', role: 'user' });
    await makeUser({ username: 'u1', role: 'user' });
    const r = await broadcast({ actor: asActor(plain), detail: 'x' });
    expect(r.ok).toBe(false);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('权限检查在参数校验之前 —— 非站长即便传空内容也是 403 而非 400（不泄露校验逻辑）', async () => {
    const admin = await makeUser({ username: 'a', role: 'admin' });
    const r = await broadcast({ actor: asActor(admin), detail: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(403);
  });
});

describe('broadcast 目标用户组', () => {
  async function seed() {
    const owner = await makeUser({ username: 'owner1', role: 'owner' });
    await makeUser({ username: 'core1', role: 'core' });
    await makeUser({ username: 'admin1', role: 'admin' });
    await makeUser({ username: 'user1', role: 'user' });
    await makeUser({ username: 'user2', role: 'user' });
    return owner;
  }

  it("'all' → 除发送者外的全部用户", async () => {
    const owner = await seed();
    const r = await broadcast({ actor: asActor(owner), detail: 'x', targetGroup: 'all' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sentCount).toBe(4); // core1 + admin1 + user1 + user2，不含 owner 自己

    // 发送者自己不该收到
    expect(await prisma.notification.count({ where: { recipientId: owner.id } })).toBe(0);
  });

  it("'authenticated' → 仅 core/admin/owner", async () => {
    const owner = await seed();
    const r = await broadcast({ actor: asActor(owner), detail: 'x', targetGroup: 'authenticated' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sentCount).toBe(2); // core1 + admin1（owner 是自己，排除）

    const got = await prisma.notification.findMany({ select: { recipient: { select: { role: true } } } });
    expect(got.every((n) => ['core', 'admin', 'owner'].includes(n.recipient.role))).toBe(true);
  });

  it("'normal' → 仅 role='user'", async () => {
    const owner = await seed();
    const r = await broadcast({ actor: asActor(owner), detail: 'x', targetGroup: 'normal' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sentCount).toBe(2); // user1 + user2

    const got = await prisma.notification.findMany({ select: { recipient: { select: { role: true } } } });
    expect(got.every((n) => n.recipient.role === 'user')).toBe(true);
  });

  it('内容为空 → 400，且不发任何通知', async () => {
    const owner = await seed();
    const r = await broadcast({ actor: asActor(owner), detail: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(400);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('force 发送：无视接收者的通知偏好（群发是公告，不该被个人开关吞掉）', async () => {
    const owner = await makeUser({ username: 'o', role: 'owner' });
    const u = await makeUser({ username: 'u', role: 'user' });
    // 把该用户的通知偏好全关掉
    await prisma.user.update({
      where: { id: u.id },
      data: { notifyLike: false, notifyEdit: false, notifyDelete: false, notifyAdmin: false },
    });

    const r = await broadcast({ actor: asActor(owner), detail: '重要公告' });
    expect(r.ok).toBe(true);
    expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(1);
  });
});
