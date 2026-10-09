import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, appeals } = vi.hoisted(() => ({
  auth: { user: null as { id: string; role: string; isBanned: boolean | null; banUntil: Date | null } | null },
  appeals: vi.fn(async () => ({ items: [{ appellant: { id: 'private-author' } }], page: 1, pages: 1, total: 1 })),
}));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(), getCurrentUser: async () => auth.user }));
vi.mock('@/lib/admin-appeal-service', () => ({ listAppeals: appeals }));

import { GET as getAppeals } from '@/app/api/admin/appeals/route';
import { POST as authorize } from '@/app/api/oauth/authorize/route';
import { GET as getCheckin, POST as postCheckin } from '@/app/api/checkin/route';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';
import { nowForDb } from '@/lib/db-time';

beforeEach(() => { auth.user = null; appeals.mockClear(); });

describe('申诉列表档位', () => {
  it.each([null, 'user', 'core', 'admin'])('%s 不得读取站长申诉列表', async (role) => {
    auth.user = role ? { id: 'actor', role, isBanned: false, banUntil: null } : null;
    const response = await getAppeals(new Request('http://localhost/api/admin/appeals'));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('private-author');
    expect(appeals).not.toHaveBeenCalled();
  });
  it('站长仍可读取', async () => {
    auth.user = { id: 'actor', role: 'owner', isBanned: false, banUntil: null };
    expect((await getAppeals(new Request('http://localhost/api/admin/appeals'))).status).toBe(200);
    expect(appeals).toHaveBeenCalledOnce();
  });
});

describe('OAuth 授权请求的运行时类型', () => {
  beforeEach(async () => { await resetDb(); auth.user = { id: 'actor', role: 'core', isBanned: false, banUntil: null }; });
  it.each([null, [], { client_id: 12 }, { client_id: 'client', scope: [] }, { client_id: 'client', state: {} }])('非法 JSON %j 返回 400 而非 500', async (body) => {
    const response = await authorize(new Request('http://localhost/api/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(response.status).toBe(400);
    expect(await prisma.oAuthAuthorizationCode.count()).toBe(0);
  });
});

describe('签到禁言闸', () => {
  beforeEach(async () => { await resetDb(); });
  it.each([null, 60_000])('永久或未到期禁言不能领取签到鱼干 (%s)', async (duration) => {
    const user = await makeUser({ role: 'core', isBanned: true, banUntil: duration === null ? null : new Date(nowForDb().getTime() + duration) });
    await makeBlog({ authorId: user.id });
    auth.user = user;
    expect((await getCheckin()).status).toBe(200);
    expect(await (await getCheckin()).json()).toMatchObject({ can_check_in: false });
    expect((await postCheckin()).status).toBe(403);
    expect(await prisma.dailyCheckIn.count()).toBe(0);
    expect(await prisma.fishTransaction.count()).toBe(0);
    await expectLedgerConsistent('禁言签到拒绝后');
  });
  it('禁言已到期仍可正常签到', async () => {
    const user = await makeUser({ role: 'core', isBanned: true, banUntil: new Date(nowForDb().getTime() - 60_000) });
    await makeBlog({ authorId: user.id });
    auth.user = user;
    expect((await postCheckin()).status).toBe(200);
    await expectLedgerConsistent('禁言到期后签到');
  });
});
