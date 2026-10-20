import { beforeEach, describe, expect, it } from 'vitest';
import { makeBlog, makeCategory, makeUser, prisma, resetDb } from '../helpers/db';
import { getBlogDirectorySummary, listBlogs } from '@/lib/blog-service';
import { fishToUnits } from '@/lib/fish-units';
import { nowForDb } from '@/lib/db-time';

beforeEach(resetDb);

describe('博客目录个人范围', () => {
  it('点赞排除已撤销记录，投喂排除零额记录，所有范围排除软删文章且按本人取数', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const own = await makeBlog({ authorId: me.id });
    const liked = await makeBlog({ authorId: other.id });
    const removedLike = await makeBlog({ authorId: other.id });
    const fed = await makeBlog({ authorId: other.id });
    const zeroFeed = await makeBlog({ authorId: other.id });
    const ignored = await makeBlog({ authorId: me.id, ignore: true });
    await prisma.blogLike.createMany({ data: [
      { userId: me.id, blogId: liked.id },
      { userId: me.id, blogId: removedLike.id, deleted: true },
      { userId: me.id, blogId: ignored.id },
      { userId: other.id, blogId: own.id },
    ] });
    await prisma.blogFeed.createMany({ data: [
      { userId: me.id, blogId: fed.id, amount: fishToUnits(2) },
      { userId: me.id, blogId: zeroFeed.id, amount: 0 },
      { userId: me.id, blogId: ignored.id, amount: fishToUnits(1) },
      { userId: other.id, blogId: own.id, amount: fishToUnits(1) },
    ] });
    for (const [kind, expected] of [['mine', own], ['liked', liked], ['fed', fed]] as const) {
      const result = await listBlogs({ personalScope: { kind, userId: me.id } });
      expect(result.blogs.map((blog) => blog.id)).toEqual([expected.id]);
      expect(result.total).toBe(1);
    }
  });

  it('范围与栏目、搜索、精选、排序和分页取交集', async () => {
    const me = await makeUser();
    const parent = await makeCategory();
    const child = await makeCategory({ parentId: parent.id });
    const now = nowForDb();
    const first = await makeBlog({ authorId: me.id, categoryId: child.id, title: '目录命中一', contentUpdatedAt: now });
    const second = await makeBlog({ authorId: me.id, categoryId: child.id, title: '目录命中二', contentUpdatedAt: new Date(now.getTime() - 1000) });
    await prisma.blog.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { isFeatured: true } });
    await makeBlog({ authorId: me.id, categoryId: child.id, title: '目录命中但非精选' });
    await makeBlog({ categoryId: child.id, title: '目录命中但不是本人' });
    const result = await listBlogs({
      personalScope: { kind: 'mine', userId: me.id }, categorySlug: parent.slug,
      search: '目录命中', featured: true, sort: 'updated', perPage: 1, page: 2,
    });
    expect(result.blogs.map((blog) => blog.id)).toEqual([second.id]);
    expect(result).toMatchObject({ total: 2, pages: 2, page: 2, hasPrev: true, hasNext: false });
  });

  it('个人范围包含从全部文章隐藏的栏目，专注规则仍生效；摘要计数与列表一致', async () => {
    const me = await makeUser();
    const excluded = await makeCategory({ excludeFromAll: true });
    const hidden = await makeCategory({ focusHidden: true });
    const own = await makeBlog({ authorId: me.id, categoryId: excluded.id });
    await prisma.blog.update({ where: { id: own.id }, data: { likesCount: 7, commentsCount: 9, fishCount: 3 } });
    await makeBlog({ authorId: me.id, categoryId: hidden.id });
    const ignored = await makeBlog({ authorId: me.id, ignore: true });
    await prisma.blog.update({ where: { id: ignored.id }, data: { likesCount: 100, commentsCount: 100, fishCount: 100 } });
    await prisma.blogLike.create({ data: { blogId: own.id, userId: me.id } });
    await prisma.blogFeed.create({ data: { blogId: own.id, userId: me.id, amount: fishToUnits(1) } });
    await prisma.blogComment.create({ data: { id: 'focus-comment', blogId: own.id, authorId: me.id, content: '评论' } });
    const summary = await getBlogDirectorySummary(me.id, true);
    expect(summary).toEqual({ counts: { all: 0, mine: 1, liked: 1, commented: 1, fed: 1 }, likesReceived: 7, commentsReceived: 9, fishReceived: 3 });
    for (const kind of ['mine', 'liked', 'commented', 'fed'] as const) {
      expect((await listBlogs({ focusMode: true, personalScope: { kind, userId: me.id } })).total).toBe(summary.counts[kind]);
    }
    expect((await listBlogs({ focusMode: true })).total).toBe(summary.counts.all);
  });

  it('评论范围按文章去重，包含本人匿名评论，排除删除、未通过及他人评论，并支持筛选和分页', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const category = await makeCategory({ excludeFromAll: true });
    const now = nowForDb();
    const blogs = await Promise.all(Array.from({ length: 6 }, (_, i) => makeBlog({ title: `评论范围${i}`, categoryId: category.id, ignore: i === 5, createdAt: new Date(now.getTime() - i * 1000) })));
    await prisma.blogComment.createMany({ data: [
      { id: 'c1', blogId: blogs[0].id, authorId: me.id, content: '第一条' },
      { id: 'c2', blogId: blogs[0].id, authorId: me.id, content: '同文第二条', anonSeq: 1 },
      { id: 'c3', blogId: blogs[1].id, authorId: me.id, content: '匿名', anonSeq: 1 },
      { id: 'c4', blogId: blogs[2].id, authorId: me.id, content: '已删', isDeleted: true },
      { id: 'c5', blogId: blogs[3].id, authorId: me.id, content: '未通过', status: 'pending' },
      { id: 'c6', blogId: blogs[4].id, authorId: other.id, content: '他人' },
      { id: 'c7', blogId: blogs[5].id, authorId: me.id, content: '文章已删' },
    ] });
    const params = { personalScope: { kind: 'commented' as const, userId: me.id }, categorySlug: category.slug, search: '评论范围', sort: 'created' as const };
    const result = await listBlogs(params);
    expect(new Set(result.blogs.map((b) => b.id))).toEqual(new Set([blogs[0].id, blogs[1].id]));
    const second = await listBlogs({ ...params, perPage: 1, page: 2 });
    expect(second).toMatchObject({ total: 2, pages: 2, page: 2 });
    expect(second.blogs[0].id).toBe(result.blogs[1].id);
    expect((await getBlogDirectorySummary(me.id, false)).counts.commented).toBe(2);
  });

  it('没有有效评论时个人列表与侧栏均为空，不会退回全部文章', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const blog = await makeBlog({ authorId: me.id });
    await prisma.blogComment.createMany({ data: [
      { id: 'empty-other', blogId: blog.id, authorId: other.id, content: '他人评论' },
      { id: 'empty-deleted', blogId: blog.id, authorId: me.id, content: '已删评论', isDeleted: true },
      { id: 'empty-pending', blogId: blog.id, authorId: me.id, content: '待审核', status: 'pending' },
    ] });

    const result = await listBlogs({ personalScope: { kind: 'commented', userId: me.id } });
    expect(result).toMatchObject({ blogs: [], total: 0, pages: 1 });
    expect((await getBlogDirectorySummary(me.id, false)).counts.commented).toBe(0);
  });

  it('评论范围超过 SQLite 单批参数数目时，仍按筛选后的全集排序、计数和分页', async () => {
    const me = await makeUser();
    const author = await makeUser();
    const category = await makeCategory({ excludeFromAll: true });
    const now = nowForDb();
    const ids = Array.from({ length: 1100 }, (_, i) => `bulk-commented-${String(i).padStart(4, '0')}`);
    await prisma.blog.createMany({ data: ids.map((id, i) => ({
      id, authorId: author.id, title: '批量评论文章', categoryId: category.id,
      isFeatured: i % 2 === 0, createdAt: new Date(now.getTime() - i * 1000),
    })) });
    await prisma.blogContent.createMany({ data: ids.map((blogId, i) => ({
      blogId, content: '正文', updatedAt: new Date(now.getTime() - ((i * 37) % ids.length) * 1000),
    })) });
    await prisma.blogComment.createMany({ data: ids.map((blogId, i) => ({
      id: `bulk-comment-${i}`, blogId, authorId: me.id, content: '评论',
    })) });

    for (const [sort, expected] of [
      ['created', [14, 16, 18, 20, 22, 24, 26]],
      ['updated', [922, 268, 714, 60, 506, 952, 298]],
    ] as const) {
      const result = await listBlogs({
        personalScope: { kind: 'commented', userId: me.id },
        categorySlug: category.slug, search: '批量评论', featured: true,
        sort, page: 2, perPage: 7,
      });
      expect(result).toMatchObject({ total: 550, pages: 79, page: 2, hasPrev: true, hasNext: true });
      expect(result.blogs.map((blog) => blog.id)).toEqual(expected.map((i) => ids[i]));
    }
    expect((await getBlogDirectorySummary(me.id, false)).counts.commented).toBe(ids.length);
  });

  it('评论范围排除归档作者的文章，专注模式同时过滤列表与侧栏计数', async () => {
    const me = await makeUser();
    const archived = await makeUser();
    const hidden = await makeCategory({ focusHidden: true });
    const visible = await makeBlog();
    const focused = await makeBlog({ categoryId: hidden.id });
    const archivedBlog = await makeBlog({ authorId: archived.id });
    await prisma.blogComment.createMany({ data: [
      { id: 'scope-visible', blogId: visible.id, authorId: me.id, content: '可见' },
      { id: 'scope-focus', blogId: focused.id, authorId: me.id, content: '专注隐藏' },
      { id: 'scope-archived', blogId: archivedBlog.id, authorId: me.id, content: '作者归档' },
    ] });
    await prisma.user.update({ where: { id: archived.id }, data: { archivedAt: nowForDb() } });

    for (const focusMode of [false, true]) {
      const expected = focusMode ? [visible.id] : [visible.id, focused.id];
      const result = await listBlogs({ focusMode, personalScope: { kind: 'commented', userId: me.id } });
      expect(new Set(result.blogs.map((blog) => blog.id))).toEqual(new Set(expected));
      expect(result.total).toBe(expected.length);
      expect((await getBlogDirectorySummary(me.id, focusMode)).counts.commented).toBe(expected.length);
    }
  });
});
