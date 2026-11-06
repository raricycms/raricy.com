// ─────────────────────────────────────────────────────────────────────────────
// admin-get-no-store.test.ts —— 管理端四条 GET 的成功响应必须带 no-store
//
// 【bug 形状】`GET /api/admin/appeals`、`/api/admin/blogs`、`/api/admin/users` 与
// `GET /api/audit` 成功时用的是裸 `Response.json`，没有 `Cache-Control` —— 而全站
// 约定写死在 `format.ts`：「这些响应大多按 cookie 现算，一律 no-store」。其中
// `/api/admin/users` 的响应含全体用户的 email / lastLogin / banReason，是四条里
// 最敏感的一条（R3-411）。失败路径早已走 apiErr（带 no-store），只有成功路径漏了。
//
// 【判据】走 apiOk 后：状态/payload 形状逐字不变（code/message/字段名/分页），
// 只多一个 Cache-Control: no-store。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { auth } = vi.hoisted(() => ({
  auth: { user: null as { id: string; role: string; archivedAt: Date | null } | null },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getCurrentUser: async () => auth.user,
}));

import { resetDb } from '../helpers/db';
import { GET as getAppeals } from '@/app/api/admin/appeals/route';
import { GET as getAdminBlogs } from '@/app/api/admin/blogs/route';
import { GET as getAdminUsers } from '@/app/api/admin/users/route';
import { GET as getAuditLogs } from '@/app/api/audit/route';

const req = (p: string) => new Request(`http://localhost${p}`);

beforeEach(async () => {
  await resetDb();
  auth.user = null;
});

const cases: Array<{
  label: string;
  role: string;
  key: string;
  call: () => Promise<Response>;
}> = [
  {
    label: 'GET /api/admin/appeals（站长档）',
    role: 'owner',
    key: 'appeals',
    call: () => getAppeals(req('/api/admin/appeals')),
  },
  {
    label: 'GET /api/admin/blogs（管理员档）',
    role: 'admin',
    key: 'blogs',
    call: () => getAdminBlogs(req('/api/admin/blogs')),
  },
  {
    label: 'GET /api/admin/users（管理员档，含 email/lastLogin/banReason）',
    role: 'admin',
    key: 'users',
    call: () => getAdminUsers(req('/api/admin/users')),
  },
  {
    label: 'GET /api/audit（core+ 档，公示面）',
    role: 'core',
    key: 'logs',
    call: () => getAuditLogs(req('/api/audit')),
  },
];

describe('四条管理端 GET：成功路径也必须是 no-store（R3-411）', () => {
  for (const c of cases) {
    it(`${c.label} → 200 + Cache-Control: no-store，payload 形状不变`, async () => {
      auth.user = { id: 'actor', role: c.role, archivedAt: null };

      const res = await c.call();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control'), '成功响应必须 no-store').toContain('no-store');

      const body = (await res.json()) as Record<string, unknown>;
      // 改 apiOk 不是改契约：code/message 与分页字段名都保持不变
      expect(body.code).toBe(200);
      expect(body.message).toBe('ok');
      expect(body).toHaveProperty(c.key);
      expect(body).toHaveProperty('pagination');
      expect(body.pagination).toMatchObject({
        page: 1,
        pages: 1,
        total: 0,
        has_prev: false,
        has_next: false,
      });
    });
  }
});
