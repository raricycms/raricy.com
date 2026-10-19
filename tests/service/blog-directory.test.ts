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
    await prisma.blog.update({ where: { id: own.id }, data: { likesCount: 7, fishCount: 3 } });
    await makeBlog({ authorId: me.id, categoryId: hidden.id });
    const ignored = await makeBlog({ authorId: me.id, ignore: true });
    await prisma.blog.update({ where: { id: ignored.id }, data: { likesCount: 100, fishCount: 100 } });
    await prisma.blogLike.create({ data: { blogId: own.id, userId: me.id } });
    await prisma.blogFeed.create({ data: { blogId: own.id, userId: me.id, amount: fishToUnits(1) } });
    const summary = await getBlogDirectorySummary(me.id, true);
    expect(summary).toEqual({ counts: { all: 0, mine: 1, liked: 1, fed: 1 }, likesReceived: 7, fishReceived: 3 });
    for (const kind of ['mine', 'liked', 'fed'] as const) {
      expect((await listBlogs({ focusMode: true, personalScope: { kind, userId: me.id } })).total).toBe(summary.counts[kind]);
    }
    expect((await listBlogs({ focusMode: true })).total).toBe(summary.counts.all);
  });
});
