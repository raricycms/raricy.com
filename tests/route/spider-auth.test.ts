// 免认证读口的档位 —— route handler 层
//
// 【为什么单独一个文件】spider 命名空间此前**几乎没有测试**（只有 favorites 那条有），
// 而本次给五条路由都加了 core+ 档位。没有这层断言，以后谁把鉴权删回去都不会有人发现。
//
// 【防的回归】这几条曾以「读公开数据不该先要账号」为由免认证。本站的机器人模型实际是
// 「一个 core+ 账号 + 会话 cookie」（提权步骤见 docs/bot/chat-bot.md §2）—— 现在一致了。
// 对外的唯一口径写在 docs/bot/comment-bot.md §6。
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
import { GET as spiderBlog } from '@/app/api/spider/blogs/[id]/route';
import { GET as spiderComments } from '@/app/api/spider/comments/route';
import { GET as spiderComment } from '@/app/api/spider/comments/[id]/route';
import { GET as blogComments } from '@/app/api/blogs/[id]/comments/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

const req = () => new Request('http://localhost/');

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('免认证读口已收紧为 core+', () => {
  // 四条路由一组三连：匿名 401 / 非 core 403 / core 放行。
  // 显式写出 call 的类型，让每条都能接收同一个 id 参数（有的路由用不到）。
  const cases: { name: string; call: (id: string) => Promise<Response> }[] = [
    { name: 'GET /api/spider/blogs/:id', call: (id) => spiderBlog(req(), ctx({ id })) },
    { name: 'GET /api/spider/comments', call: () => spiderComments() },
    { name: 'GET /api/spider/comments/:id', call: (id) => spiderComment(req(), ctx({ id })) },
    { name: 'GET /api/blogs/:id/comments', call: (id) => blogComments(req(), ctx({ id })) },
  ];

  for (const c of cases) {
    it(`${c.name}：匿名 → 401`, async () => {
      const u = await makeUser({ role: 'core' });
      const blog = await makeBlog({ authorId: u.id, title: 'T' });
      expect((await c.call(blog.id)).status).toBe(401);
    });

    it(`${c.name}：非 core → 403`, async () => {
      const u = await makeUser({ role: 'core' });
      const blog = await makeBlog({ authorId: u.id, title: 'T' });
      const plain = await makeUser({ role: 'user' });
      await login(plain.id);
      expect((await c.call(blog.id)).status).toBe(403);
    });

    it(`${c.name}：core → 放行（不再是 401/403）`, async () => {
      const u = await makeUser({ role: 'core' });
      const blog = await makeBlog({ authorId: u.id, title: 'T' });
      await login(u.id);
      const status = (await c.call(blog.id)).status;
      expect(status, '档位应放行').not.toBe(401);
      expect(status, '档位应放行').not.toBe(403);
    });
  }

  it('core 读 spider/blogs/:id 拿到 meta 与正文（成功路径的形状不变）', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: '甲文', content: '正文内容' });
    await login(u.id);

    const res = await spiderBlog(req(), ctx({ id: blog.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { title: string }; content: string };
    // 成功路径仍是裸 JSON —— 加鉴权不该顺带改掉本命名空间的响应形状
    expect(body).not.toHaveProperty('code');
    expect(body.meta.title).toBe('甲文');
    expect(body.content).toContain('正文内容');
  });

  it('core 读 spider/comments 拿到裸数组', async () => {
    const u = await makeUser({ role: 'core' });
    await login(u.id);
    const res = await spiderComments();
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('core 读 /api/blogs/:id/comments 拿到信封里的 comments', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, title: 'T' });
    await login(u.id);
    const res = await blogComments(req(), ctx({ id: blog.id }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { comments: unknown[] }).toHaveProperty('comments');
  });
});
