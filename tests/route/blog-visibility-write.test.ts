// 可见性的**写入契约** —— route handler 层
//
// 【为什么单独一个文件】`visibility` 是 blogs 的第五个键，而 PUT 是**整体覆盖**：
// 「缺键」这一种输入在两条路径上的正确语义**不同**，而它们共用同一个
// `validateBlogData`（它对缺键一律回 `'internal'` 这个默认档）：
//
//   · **创建**（`POST /api/blogs`）—— 缺键 = 默认档 internal。正确：新文章本来就该
//     fail-closed（`docs/architecture.md` §6.11 的表里 internal 就是「默认」）。
//   · **编辑**（`PUT /api/blogs/:id`）—— 缺键 = **不改动这一列**。默认档在这里是错的：
//     一个只认识旧那 4 个键的调用方（`parseVisibility` 的注释点名要保护的
//     「不带这个字段的 bot」）改一次标题就会把 link/public 的文章静默改回私密 ——
//     对外消失、退出 sitemap，而已被抓走的副本收不回来。
//
// 这条差异只存在于**路由层**（service 分不出调用方是建还是改），所以守卫必须钉在这里：
// 把路由里那段回填删掉，本文件必须变红。
//
// 【与 tests/route/blog-auth.test.ts 的分工】那边钉的是**档位**（谁能调），
// 这边钉的是**业务语义**（缺键时写什么）。两件事，别混。
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
import { prisma } from '@/lib/db';
import { POST as createBlog } from '@/app/api/blogs/route';
import { GET as getBlog, PUT as updateBlog } from '@/app/api/blogs/[id]/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const withBody = (method: string) => (body: unknown) =>
  new Request('http://localhost/api/blogs/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const post = withBody('POST');
const put = withBody('PUT');

/** 合法的三件套（PUT 是整体覆盖，缺一件就 400，测别的之前先把它们补齐）。 */
const base = { title: '标题', description: '摘要', content: '正文' };

const visibilityOf = async (id: string) => {
  const row = await prisma.blog.findUnique({ where: { id }, select: { visibility: true } });
  return row?.visibility;
};

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('PUT /api/blogs/:id —— 缺 visibility = 不改动这一列', () => {
  for (const tier of ['link', 'public'] as const) {
    it(`★ 只传旧那 4 个键改标题，${tier} 的文章必须仍是 ${tier}`, async () => {
      const author = await makeUser({ role: 'core' });
      const blog = await makeBlog({ authorId: author.id, title: '旧标题' });
      await prisma.blog.update({ where: { id: blog.id }, data: { visibility: tier } });
      await login(author.id);

      const res = await updateBlog(put({ ...base, title: '新标题' }), ctx(blog.id));
      expect(res.status).toBe(200);

      expect(
        await visibilityOf(blog.id),
        `缺键时被打回了默认档 —— 一个只认识旧键的调用方改一次标题就把 ${tier} 的文章静默下架了`
      ).toBe(tier);
      const row = await prisma.blog.findUnique({
        where: { id: blog.id },
        select: { title: true },
      });
      expect(row?.title, '标题还是要改的 —— 回填不该顺手把整次编辑吞掉').toBe('新标题');
    });
  }

  it('显式传 internal 仍然照改（明确意图与「没提这件事」不是一回事）', async () => {
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id, title: 'T' });
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'public' } });
    await login(author.id);

    const res = await updateBlog(put({ ...base, visibility: 'internal' }), ctx(blog.id));
    expect(res.status).toBe(200);
    expect(await visibilityOf(blog.id)).toBe('internal');
  });

  it('显式传非法值 → 400，且库里不变（回填不得把校验短路掉）', async () => {
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id, title: 'T' });
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'link' } });
    await login(author.id);

    const res = await updateBlog(put({ ...base, visibility: 'pulbic' }), ctx(blog.id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      '可见性取值不合法，可选：internal / link / public'
    );
    expect(await visibilityOf(blog.id)).toBe('link');
  });
});

describe('POST /api/blogs —— 缺 visibility = 默认档 internal（与 PUT 相反，别一起改）', () => {
  it('不传 visibility 建出来的文章是 internal', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);

    const res = await createBlog(post(base));
    expect(res.status).toBe(200);
    const { blog_id } = (await res.json()) as { blog_id: string };

    expect(
      await visibilityOf(blog_id),
      '创建路径的缺省必须是 fail-closed 的 internal —— 回填逻辑不许蔓延到这里'
    ).toBe('internal');
  });

  it('传 visibility: public 建出来就是 public', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);

    const res = await createBlog(post({ ...base, visibility: 'public' }));
    const { blog_id } = (await res.json()) as { blog_id: string };
    expect(await visibilityOf(blog_id)).toBe('public');
  });
});

describe('GET /api/blogs/:id —— 下发 visibility（读-改-写的前提）', () => {
  it('返回体里带着当前档位', async () => {
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id, title: 'T' });
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'public' } });
    await login(author.id);

    const res = await getBlog(new Request('http://localhost/api/blogs/x'), ctx(blog.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blog: { visibility: string } };
    expect(
      body.blog.visibility,
      '读不到档位，调用方就没法「读-改-写」—— PUT 是整体覆盖，回填也只能靠这个字段'
    ).toBe('public');
  });
});
