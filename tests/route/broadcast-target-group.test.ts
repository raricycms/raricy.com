// ─────────────────────────────────────────────────────────────────────────────
// broadcast-target-group.test.ts —— POST /api/admin/broadcast 的 targetGroup 校验
//
// 【bug 形状】路由把非法 targetGroup 静默回落 'all'：body `{targetGroup:"core"}`
// （或将来新增组名却没同步白名单）会在**不报错**的情况下发给全站 —— 一次参数错就是
// 不可撤回的全站打扰（R3-417）。service 层本来有 400 分支，但被路由的回落绕过了。
//
// 【判据】非空非法值必须 400 且一条通知都不发；缺省（未传/null/空串）仍按 'all'
// 保持既有调用方；组名常量与页面共用一份（broadcast-groups.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { auth } = vi.hoisted(() => ({
  auth: {
    user: null as { id: string; role: string; archivedAt: Date | null } | null,
  },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getCurrentUser: async () => auth.user,
}));

import { resetDb, makeUser, prisma } from '../helpers/db';
import { POST as broadcastRoute } from '@/app/api/admin/broadcast/route';

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 站长 + 各档用户各一名：owner(自己) / core / admin / user1 / user2。 */
async function seed() {
  const owner = await makeUser({ username: 'owner1', role: 'owner' });
  const core = await makeUser({ username: 'core1', role: 'core' });
  const admin = await makeUser({ username: 'admin1', role: 'admin' });
  const u1 = await makeUser({ username: 'user1', role: 'user' });
  const u2 = await makeUser({ username: 'user2', role: 'user' });
  auth.user = { id: owner.id, role: owner.role, archivedAt: owner.archivedAt };
  return { owner, core, admin, u1, u2 };
}

beforeEach(async () => {
  await resetDb();
  auth.user = null;
});

describe('POST /api/admin/broadcast：非法 targetGroup 不再静默回落 all', () => {
  it.each(['core', 'ALL', 'everyone', ' authenticated '])(
    '非空非法值 %j → 400，且一条通知都不发',
    async (targetGroup) => {
      const { owner } = await seed();
      const res = await broadcastRoute(post({ detail: '全站公告', targetGroup }));
      expect(res.status, `${targetGroup} 应 400`).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('无效的目标用户组');
      expect(await prisma.notification.count(), '参数错的请求不许触发任何发送').toBe(0);
      expect(await prisma.notification.count({ where: { recipientId: owner.id } })).toBe(0);
    }
  );

  it('非字符串 targetGroup（数字 / 布尔）同样 400', async () => {
    await seed();
    for (const targetGroup of [42, true, {}]) {
      const res = await broadcastRoute(post({ detail: 'x', targetGroup }));
      expect(res.status, `${JSON.stringify(targetGroup)} 应 400`).toBe(400);
    }
    expect(await prisma.notification.count()).toBe(0);
  });

  it('缺省 / null / 空串 → 仍按 all（除发送者外全部用户，保持既有调用方）', async () => {
    for (const body of [
      { detail: '全站公告' },
      { detail: '全站公告', targetGroup: null },
      { detail: '全站公告', targetGroup: '' },
    ]) {
      await resetDb();
      const { owner } = await seed();

      const res = await broadcastRoute(post(body));
      expect(res.status, `${JSON.stringify(body)} 应 200`).toBe(200);
      const data = (await res.json()) as { code: number; sent_count: number; failed_count: number };
      expect(data.code).toBe(200);
      expect(data.sent_count).toBe(4); // core1 + admin1 + user1 + user2，不含 owner 自己
      expect(await prisma.notification.count({ where: { recipientId: owner.id } })).toBe(0);
    }
  });

  it('合法分组照常发送：normal 只发给 role=user', async () => {
    await seed();
    const res = await broadcastRoute(post({ detail: '给普通用户', targetGroup: 'normal' }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sent_count: number };
    expect(data.sent_count).toBe(2);

    const got = await prisma.notification.findMany({
      select: { recipient: { select: { role: true } } },
    });
    expect(got).toHaveLength(2);
    expect(got.every((n) => n.recipient.role === 'user')).toBe(true);
  });
});
