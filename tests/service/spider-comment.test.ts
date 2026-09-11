// spider-service.ts —— 爬虫只读 API 的评论序列化
//
// 【为什么单独盯「键集合」】这是**对外契约**：无认证、供搜索引擎抓取，使用方是站外
// 的爬虫/聚合器，我们看不到它们。站内给评论 DTO 加字段（content / image / blog …）
// 时，如果 spider 直接复用了站内的序列化结果，这些字段会**顺着漏出去** —— 站内一次
// 「无害」的新增，会静默改变外部接口的形状。
//
// 所以这里的第一条断言就是键集合逐字相等，而不是「包含」。
//
// 【为什么这条测试是本次加的】spider-service 原本自带一份 serializeComment（与
// comment-service.serializeRow 逐字重复），本次改成复用后者 + 只投影契约内字段。
// 重构前先立契约，重构后它必须原样通过 —— 这就是「没改到对外行为」的证据。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { getRecentComments, getSpiderComment } from '@/lib/spider-service';
import { toContentHtml, createComment } from '@/lib/comment-service';

beforeEach(async () => {
  await resetDb();
});

/** spider 契约里**唯一允许**出现的字段（多一个都算破坏对外契约）。 */
const CONTRACT_KEYS = [
  'author',
  'blog_id',
  'children',
  'content_html',
  'created_at',
  'id',
  'is_deleted',
  'likes_count',
  'parent_id',
  'root_id',
  'status',
  'updated_at',
];

/** 直接落库造评论（绕开 createComment 的毫秒级时间戳，保证排序确定）。 */
let clock = 0;
async function makeComment(opts: {
  blogId: string;
  authorId: string;
  content?: string;
  parentId?: string | null;
  rootId?: string | null;
  isDeleted?: boolean;
}) {
  const content = opts.content ?? 'c';
  return prisma.blogComment.create({
    data: {
      id: crypto.randomUUID(),
      blogId: opts.blogId,
      authorId: opts.authorId,
      parentId: opts.parentId ?? null,
      rootId: opts.rootId ?? null,
      content,
      contentHtml: toContentHtml(content),
      status: 'approved',
      isDeleted: opts.isDeleted ?? false,
      likesCount: 0,
      createdAt: new Date(1700000000000 + ++clock * 1000),
      updatedAt: new Date(1700000000000 + clock * 1000),
    },
  });
}

async function seed() {
  const author = await makeUser({ role: 'core' });
  const blog = await makeBlog({ authorId: author.id });
  return { author, blog };
}

describe('spider 评论契约：键集合', () => {
  it('★ 单条评论的键与契约逐字相等（站内新增字段不得漏出）', async () => {
    const { author, blog } = await seed();
    const c = await makeComment({ blogId: blog.id, authorId: author.id, content: 'x' });

    const out = await getSpiderComment(c.id);
    expect(out).not.toBeNull();
    expect(Object.keys(out!).sort()).toEqual(CONTRACT_KEYS);
    // 站内 DTO 的字段一个都不许出现在这里
    for (const leaked of ['content', 'image', 'image_missing', 'blog', 'blog_missing']) {
      expect(out, `站内字段 ${leaked} 漏进了 spider 契约`).not.toHaveProperty(leaked);
    }
  });

  it('★ 列表里每条评论同样只带契约字段', async () => {
    const { author, blog } = await seed();
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'a' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'b' });

    const list = await getRecentComments();
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(CONTRACT_KEYS);
    }
  });

  it('children 恒为空数组（spider 出的是扁平列表，不是树）', async () => {
    const { author, blog } = await seed();
    const parent = await makeComment({ blogId: blog.id, authorId: author.id, content: 'parent' });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'child',
      parentId: parent.id, rootId: parent.id,
    });

    const list = await getRecentComments();
    for (const item of list) expect(item.children).toEqual([]);
  });
});

describe('spider 评论语义', () => {
  it('按创建时间倒序，取最近 N 条', async () => {
    const { author, blog } = await seed();
    await makeComment({ blogId: blog.id, authorId: author.id, content: '早' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: '中' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: '晚' });

    const list = await getRecentComments(2);
    expect(list.map((c) => c.content_html)).toEqual(['晚', '中']);
  });

  it('★ 已删除的评论也出现在列表里，但只给占位文案（不泄露原文）', async () => {
    const { author, blog } = await seed();
    await makeComment({ blogId: blog.id, authorId: author.id, content: '机密原文', isDeleted: true });

    const list = await getRecentComments();
    expect(list).toHaveLength(1);
    expect(list[0].is_deleted).toBe(true);
    expect(list[0].content_html).toBe('[该评论已删除]');
    expect(JSON.stringify(list)).not.toContain('机密原文');
  });

  it('单条查询：已删除 / 不存在一律 null（不是占位对象）', async () => {
    const { author, blog } = await seed();
    const dead = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'x', isDeleted: true,
    });

    expect(await getSpiderComment(dead.id)).toBeNull();
    expect(await getSpiderComment(crypto.randomUUID())).toBeNull();
  });

  it('作者信息与站内口径一致（is_admin / 头像 URL）', async () => {
    const { author, blog } = await seed();
    const c = await createComment({ blogId: blog.id, authorId: author.id, content: 'hello' });
    if (!c.ok) throw new Error('前置失败');

    const out = await getSpiderComment(c.comment.id);
    expect(out!.author.id).toBe(author.id);
    expect(out!.author.username).toBe(author.username);
    expect(out!.author.avatar_url).toBe(`/api/avatar/${author.id}`);
    expect(out!.author.is_admin).toBe(false);
    // 时间也是 ISO 字符串（与站内同一口径）
    expect(out!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
