// 两条「读口」的档位 —— route handler 层
//
// 【为什么单独一个文件】
//   · `GET /api/blogs/:id` 此前**完全免认证**：页面那道 `requireCoreUser()` 只挡浏览器，
//     匿名 curl 一下就是全文 Markdown。这条补上 core+ 档位。
//   · `GET /api/users/:id` **刻意不设档**（`/u/:id` 是匿名可达的公开主页，主页画报的
//     二维码把站外人引到这里），但内容要按查看者收敛 —— 而收敛发生在 service 层。
//     **route 层漏传 viewer 时，service 的单测照样全绿**（它自己测得没错），线上却是把
//     文章标题与评论片段发给全互联网。所以这条集成缝必须在这里钉死。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb, makeUser, makeBlog } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { GET as blogDetail } from '@/app/api/blogs/[id]/route';
import { GET as userProfile } from '@/app/api/users/[id]/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

const getBlog = (id: string) => blogDetail(new Request('http://localhost/'), ctx({ id }));
const getUser = (id: string) => userProfile(new Request('http://localhost/'), ctx({ id }));

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('GET /api/blogs/:id — 已收紧为 core+', () => {
  it('★ 匿名拿不到正文（此前是免认证的全文接口）', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: 'T', content: '正文内容' });

    expect((await getBlog(blog.id)).status).toBe(401);
  });

  it('非 core → 403', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: 'T' });
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);

    expect((await getBlog(blog.id)).status).toBe(403);
  });

  it('core 放行，且成功路径的形状与改动前逐字一致', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: '甲文', content: '正文内容' });
    await login(u.id);

    const res = await getBlog(blog.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; blog: { title: string; content: string } };
    expect(body.code).toBe(200);
    expect(body.blog.title).toBe('甲文');
    expect(body.blog.content).toContain('正文内容');
  });

  it('core 读已软删的文章仍是 404', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: 'T', ignore: true });
    await login(u.id);

    expect((await getBlog(blog.id)).status).toBe(404);
  });
});

describe('GET /api/users/:id — 匿名可达，但内容按查看者收敛', () => {
  it('★ 匿名：拿得到身份字段，拿不到 role / 文章 / 评论', async () => {
    const u = await makeUser({ role: 'admin', username: 'boss' });
    await makeBlog({ authorId: u.id, title: '不该外泄的标题' });

    const res = await getUser(u.id);
    expect(res.status, '公开主页必须匿名可达（主页画报的二维码依赖它）').toBe(200);

    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.username).toBe('boss');
    expect(body.user.role, 'role 泄露 = 游客能枚举出谁是管理员').toBeNull();
    expect(body.user.recentBlogs).toEqual([]);
    expect(body.user.recentComments).toEqual([]);
    expect(JSON.stringify(body), '标题都不该出现在载荷里').not.toContain('不该外泄的标题');
  });

  it('★ core 查看者：拿到与收敛前一致的内容（这条防的是 route 漏传 viewer）', async () => {
    const target = await makeUser({ role: 'core' });
    await makeBlog({ authorId: target.id, title: '一篇文章' });
    const viewer = await makeUser({ role: 'core' });
    await login(viewer.id);

    const res = await getUser(target.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { role: string | null; recentBlogs: { title: string }[] };
    };
    expect(body.user.role).toBe('core');
    expect(body.user.recentBlogs.map((b) => b.title)).toEqual(['一篇文章']);
  });

  it('本人看自己不受档位影响（role=user 的账号主页不是空壳）', async () => {
    const u = await makeUser({ role: 'user' });
    await makeBlog({ authorId: u.id, title: '我的文章' });
    await login(u.id);

    const body = (await (await getUser(u.id)).json()) as {
      user: { role: string | null; recentBlogs: { title: string }[] };
    };
    expect(body.user.role).toBe('user');
    expect(body.user.recentBlogs).toHaveLength(1);
  });

  it('非 core 登录用户看别人：与游客同档（有账号不等于有权限）', async () => {
    const target = await makeUser({ role: 'core' });
    await makeBlog({ authorId: target.id, title: 'T' });
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);

    const body = (await (await getUser(target.id)).json()) as {
      user: { role: string | null; recentBlogs: unknown[] };
    };
    expect(body.user.role).toBeNull();
    expect(body.user.recentBlogs).toEqual([]);
  });

  it('用户不存在 → 404', async () => {
    expect((await getUser('ghost')).status).toBe(404);
  });
});
