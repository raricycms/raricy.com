import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, appeals } = vi.hoisted(() => ({
  auth: { user: null as { id: string; role: string; isBanned: boolean | null; banUntil: Date | null } | null },
  appeals: vi.fn(async () => ({ items: [{ appellant: { id: 'private-author' } }], page: 1, pages: 1, total: 1 })),
}));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(), getCurrentUser: async () => auth.user }));
vi.mock('@/lib/admin-appeal-service', () => ({ listAppeals: appeals }));

import { GET as getAppeals } from '@/app/api/admin/appeals/route';

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
