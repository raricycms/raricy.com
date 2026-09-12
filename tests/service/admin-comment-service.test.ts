// ─────────────────────────────────────────────────────────────────────────────
// admin-comment-service.test.ts —— 管理端评论检索
//
// 这层的存在理由只有一个：**能看见被软删的评论**。所以核心断言是
// 「status 三态过滤是否真的把已删的行算进来」，而不是「能不能查到」。
// 另一条是载荷形状：列表不该带 contentHtml（服务端转义的 HTML，列表用不上）。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeBlog, makeUser, prisma, resetDb } from '../helpers/db';
import { getCommentForAdmin, listAdminComments } from '@/lib/admin-comment-service';
import { nowForDb } from '@/lib/db-time';

async function makeComment(opts: {
  blogId: string;
  authorId: string;
  content?: string;
  isDeleted?: boolean;
}) {
  return prisma.blogComment.create({
    data: {
      id: `c-${Math.random().toString(36).slice(2, 10)}`,
      blogId: opts.blogId,
      authorId: opts.authorId,
      content: opts.content ?? '评论正文',
      contentHtml: `<p>${opts.content ?? '评论正文'}</p>`,
      status: 'approved',
      isDeleted: opts.isDeleted ?? false,
      createdAt: nowForDb(),
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('listAdminComments：能看见被软删的评论', () => {
  it('★ status 三态：all 含已删 / active 只剩活的 / deleted 只剩已删', async () => {
    const author = await makeUser({ username: 'alice' });
    const blog = await makeBlog({ authorId: author.id, title: '构建报错排查' });
    const alive = await makeComment({ blogId: blog.id, authorId: author.id, content: '还活着' });
    const gone = await makeComment({
      blogId: blog.id,
      authorId: author.id,
      content: '被删了',
      isDeleted: true,
    });

    const all = await listAdminComments({ status: 'all' });
    expect(all.total).toBe(2);
    expect(all.comments.map((c) => c.id).sort()).toEqual([alive.id, gone.id].sort());

    const active = await listAdminComments({ status: 'active' });
    expect(active.comments.map((c) => c.id)).toEqual([alive.id]);

    const deleted = await listAdminComments({ status: 'deleted' });
    expect(deleted.comments.map((c) => c.id)).toEqual([gone.id]);
  });

  it('未指定 status 时不过滤（与「含已删」同义）', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: blog.id, authorId: author.id, isDeleted: true });
    expect((await listAdminComments({})).total).toBe(1);
  });

  it('★ 列表载荷里没有 contentHtml（转义 HTML，列表用不上）', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: blog.id, authorId: author.id });

    const { comments } = await listAdminComments({});
    expect(Object.keys(comments[0])).not.toContain('contentHtml');
    // 正文预览要留着，否则搜到了也不知道是不是要找的那条
    expect(Object.keys(comments[0])).toContain('content');
  });
});

describe('listAdminComments：筛选与搜索', () => {
  it('按正文关键词搜（含已删的正文）', async () => {
    const author = await makeUser();
    const blog = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: blog.id, authorId: author.id, content: '这个问题报错在第三行' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: '无关内容', isDeleted: true });

    const r = await listAdminComments({ search: '报错' });
    expect(r.total).toBe(1);
    expect(r.comments[0].content).toContain('报错');
  });

  it('按作者用户名搜', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const blog = await makeBlog({ authorId: alice.id });
    await makeComment({ blogId: blog.id, authorId: bob.id, content: 'bob 的评论' });
    await makeComment({ blogId: blog.id, authorId: alice.id, content: 'alice 的评论' });

    const r = await listAdminComments({ search: 'bob' });
    expect(r.total).toBe(1);
    expect(r.comments[0].author?.username).toBe('bob');
  });

  it('按所属文章标题搜', async () => {
    const author = await makeUser();
    const target = await makeBlog({ authorId: author.id, title: '构建报错排查' });
    const other = await makeBlog({ authorId: author.id, title: '无关文章' });
    await makeComment({ blogId: target.id, authorId: author.id, content: 'a' });
    await makeComment({ blogId: other.id, authorId: author.id, content: 'b' });

    const r = await listAdminComments({ search: '构建报错' });
    expect(r.total).toBe(1);
  });

  it('按 blogId 精确筛（楼中楼排查用）', async () => {
    const author = await makeUser();
    const a = await makeBlog({ authorId: author.id });
    const b = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: a.id, authorId: author.id });
    await makeComment({ blogId: b.id, authorId: author.id });

    expect((await listAdminComments({ blogId: a.id })).total).toBe(1);
  });
});

describe('getCommentForAdmin', () => {
  it('★ 不过滤 isDeleted —— 要恢复的正是被删的那些', async () => {
    const author = await makeUser({ username: 'alice' });
    const blog = await makeBlog({ authorId: author.id, title: '标题' });
    const gone = await makeComment({
      blogId: blog.id,
      authorId: author.id,
      content: '被删的正文',
      isDeleted: true,
    });

    const row = await getCommentForAdmin(gone.id);
    expect(row).not.toBeNull();
    expect(row!.isDeleted).toBe(true);
    expect(row!.content).toBe('被删的正文');
    expect(row!.author?.username).toBe('alice');
    expect(row!.blog?.title).toBe('标题');
  });

  it('不存在的 id → null', async () => {
    expect(await getCommentForAdmin('nope')).toBeNull();
  });
});
