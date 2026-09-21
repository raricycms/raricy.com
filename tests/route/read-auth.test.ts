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
import { nowForDb } from '@/lib/db-time';
import { prisma } from '@/lib/db';
import { GET as blogDetail } from '@/app/api/blogs/[id]/route';
import { GET as userProfile } from '@/app/api/users/[id]/route';
import { GET as auditLogs } from '@/app/api/audit/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

const getBlog = (id: string) => blogDetail(new Request('http://localhost/'), ctx({ id }));
const getUser = (id: string) => userProfile(new Request('http://localhost/'), ctx({ id }));
const getAudit = () => auditLogs(new Request('http://localhost/api/audit'));

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
    // ⚠️ 句柄是 id 还是用户名由**实际命中了哪一列**决定（见 resolveProfileHandle），
    // 所以 `ghost` 这种串走的是「按用户名查」那条路 —— 查不到仍然是 404（对外契约，
    // 见 docs/bot/account-bot.md §6），与按 id 查不到同形。
    expect((await getUser('ghost')).status).toBe(404);
    expect((await getUser('00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
});

describe('GET /api/users/<用户名> — 同上，但按名字查要 core+', () => {
  it('★ 按 id 查照旧匿名可达（别把公开主页那条路一起关掉）', async () => {
    const u = await makeUser({ role: 'core', username: 'boss' });
    const res = await getUser(u.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('boss');
  });

  it('★ 匿名按名字查 → 403（id 是 UUID，只能从链接里捡；名字到处都是、可以枚举）', async () => {
    await makeUser({ role: 'core', username: 'boss' });
    expect((await getUser('boss')).status).toBe(403);
  });

  it('非 core 登录用户按名字查 → 403（有账号不等于有权限，与其它档位同口径）', async () => {
    await makeUser({ role: 'core', username: 'boss' });
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await getUser('boss')).status).toBe(403);
  });

  it('★ core 按名字查：拿到的载荷与按 id 查**逐字一致**（名片就靠它渲染）', async () => {
    const target = await makeUser({ role: 'core', username: 'boss' });
    await makeBlog({ authorId: target.id, title: '一篇文章' });
    const viewer = await makeUser({ role: 'core' });
    await login(viewer.id);

    const byId = await (await getUser(target.id)).json();
    const byName = await (await getUser('boss')).json();
    expect(byName).toEqual(byId);
    expect((byName as { user: { id: string } }).user.id).toBe(target.id);
  });

  it('★ 中文用户名同样认（名片 token 里的名字可以有中文）', async () => {
    const target = await makeUser({ role: 'core', username: '张三丰' });
    await login(target.id);
    const body = (await (await getUser('张三丰')).json()) as { user: { id: string } };
    expect(body.user.id).toBe(target.id);
  });

  it('★ 用户名大小写敏感（不做归一化：折叠会把两个不同的号变成一个）', async () => {
    await makeUser({ role: 'core', username: 'ZhangSan' });
    const viewer = await makeUser({ role: 'core' });
    await login(viewer.id);

    expect((await getUser('ZhangSan')).status).toBe(200);
    expect((await getUser('zhangsan')).status).toBe(404);
  });

  it('core 按不存在的名字查 → 404（与「不存在 → 404」那条对外口诀同形）', async () => {
    const viewer = await makeUser({ role: 'core' });
    await login(viewer.id);
    expect((await getUser('ghost')).status).toBe(404);
  });

  it('非 core 按不存在的名字查 → 也是 404（档位不改变「不存在」的答案）', async () => {
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await getUser('ghost')).status).toBe(404);
  });
});

describe('GET /api/audit — 已收紧为 core+', () => {
  /** 造一条会进公示页的日志（visibility=public 且在 30 天窗口内）。 */
  const seedLog = async (adminId: string) =>
    prisma.adminActionLog.create({
      data: {
        action: '禁言',
        adminId,
        visibility: 'public',
        reason: '测试',
        createdAt: nowForDb(), // 窗口按 nowForDb 口径算，别用真 UTC
      },
    });

  it('★ 匿名拿不到处置记录（含管理员与被处置用户的用户名）', async () => {
    const admin = await makeUser({ role: 'admin' });
    await seedLog(admin.id);

    expect((await getAudit()).status).toBe(401);
  });

  it('非 core → 403', async () => {
    const admin = await makeUser({ role: 'admin' });
    await seedLog(admin.id);
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);

    expect((await getAudit()).status).toBe(403);
  });

  it('core 放行，且真的读得到那条日志（形状不变）', async () => {
    const admin = await makeUser({ role: 'admin', username: 'mod' });
    await seedLog(admin.id);
    const viewer = await makeUser({ role: 'core' });
    await login(viewer.id);

    const res = await getAudit();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      logs: { action: string; admin: { username: string | null } }[];
      pagination: { total: number };
    };
    expect(body.code).toBe(200);
    expect(body.logs.map((l) => l.action)).toContain('禁言');
    expect(body.logs[0].admin.username).toBe('mod');
    expect(body.pagination.total).toBe(1);
  });
});
