// ─────────────────────────────────────────────────────────────────────────────
// likers-feeders.test.ts —— 点赞者 / 投喂者列表
//
// 【为什么有这个文件】这两个端点原本**根本不存在**：前端 FeedButton 一直在请求
// /api/blogs/:id/likers 和 /feeders，而 Next 侧没有对应路由 —— 点开「谁点了赞」
// 必然 404。构建不会报错、单测不会红，只有真点进去才发现。补实现的同时把语义钉死。
//
// 重点钉三条（都是 Flask 的既有语义，漂了就是行为不一致）：
//   1. 软删除的赞必须排除 —— 取消赞的人不该还挂在列表里
//   2. 投喂者按投喂量倒序（不是时间序）—— 这个列表是给作者看「谁投得最多」
//   3. limit 上限 200、下限 1，offset 不接受负数 —— 防止一次拉爆整张表
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { getLikers } from '@/lib/blog-service';
import { getFeeders } from '@/lib/feed-service';
import { nowForDb } from '@/lib/db-time';

beforeEach(resetDb);

/** 直接造点赞记录（绕开 toggleLike 的限频，测的是读路径） */
async function like(blogId: string, userId: string, opts: { deleted?: boolean; at?: Date } = {}) {
  return prisma.blogLike.create({
    data: {
      blogId,
      userId,
      deleted: opts.deleted ?? false,
      createdAt: opts.at ?? nowForDb(),
    },
  });
}

describe('getLikers', () => {
  it('文章不存在 → 返回 null（路由据此 404，而不是给个空列表假装成功）', async () => {
    expect(await getLikers('no-such-blog')).toBeNull();
  });

  it('列出点赞者，字段形状对齐 Flask 的 JSON', async () => {
    const author = await makeUser({ username: 'a1' });
    const blog = await makeBlog({ authorId: author.id });
    const u = await makeUser({ username: 'liker1' });
    await like(blog.id, u.id, { at: new Date('2026-07-16T22:30:15.000Z') });

    const r = await getLikers(blog.id);
    expect(r).not.toBeNull();
    expect(r!.total).toBe(1);
    expect(r!.users).toEqual([
      {
        id: u.id,
        username: 'liker1',
        avatar_url: `/api/avatar/${u.id}`,
        liked_at: '2026-07-16 22:30:15',
      },
    ]);
  });

  it('★ 软删除的赞被排除（取消赞的人不该还在列表里）', async () => {
    const blog = await makeBlog();
    const kept = await makeUser({ username: 'kept' });
    const gone = await makeUser({ username: 'gone' });
    await like(blog.id, kept.id);
    await like(blog.id, gone.id, { deleted: true });

    const r = await getLikers(blog.id);
    expect(r!.total).toBe(1);
    expect(r!.users.map((x) => x.username)).toEqual(['kept']);
  });

  it('按点赞时间倒序（最新的在前）', async () => {
    const blog = await makeBlog();
    const older = await makeUser({ username: 'older' });
    const newer = await makeUser({ username: 'newer' });
    await like(blog.id, older.id, { at: new Date('2026-01-01T00:00:00.000Z') });
    await like(blog.id, newer.id, { at: new Date('2026-07-01T00:00:00.000Z') });

    const r = await getLikers(blog.id);
    expect(r!.users.map((x) => x.username)).toEqual(['newer', 'older']);
  });

  it('分页：offset/limit 生效，total 是全量而非当页', async () => {
    const blog = await makeBlog();
    for (let i = 0; i < 5; i++) {
      const u = await makeUser({ username: `u${i}` });
      await like(blog.id, u.id, { at: new Date(Date.UTC(2026, 0, i + 1)) });
    }
    const r = await getLikers(blog.id, 1, 2);
    expect(r!.total).toBe(5); // 全量
    expect(r!.users).toHaveLength(2); // 当页
    expect(r!.offset).toBe(1);
    expect(r!.limit).toBe(2);
  });

  it('limit 被夹在 1..200，offset 不接受负数（对齐 Flask，防一次拉爆整表）', async () => {
    const blog = await makeBlog();
    expect((await getLikers(blog.id, 0, 9999))!.limit).toBe(200);
    expect((await getLikers(blog.id, 0, 0))!.limit).toBe(1);
    expect((await getLikers(blog.id, -5, 50))!.offset).toBe(0);
  });

});

describe('getFeeders', () => {
  async function feed(blogId: string, userId: string, amount: number) {
    return prisma.blogFeed.create({
      data: { blogId, userId, amount, createdAt: nowForDb(), updatedAt: nowForDb() },
    });
  }

  it('空列表时 total=0，不抛错', async () => {
    const blog = await makeBlog();
    const r = await getFeeders(blog.id);
    expect(r.total).toBe(0);
    expect(r.feeders).toEqual([]);
  });

  it('★ 按投喂量倒序（不是时间序）—— 作者要看的是谁投得最多', async () => {
    const blog = await makeBlog();
    const small = await makeUser({ username: 'small' });
    const big = await makeUser({ username: 'big' });
    const mid = await makeUser({ username: 'mid' });
    await feed(blog.id, small.id, 1);
    await feed(blog.id, big.id, 5);
    await feed(blog.id, mid.id, 3);

    const r = await getFeeders(blog.id);
    expect(r.feeders.map((f) => f.username)).toEqual(['big', 'mid', 'small']);
    expect(r.feeders.map((f) => f.amount)).toEqual([5, 3, 1]);
  });

  it('字段形状对齐 Flask 的 JSON', async () => {
    const blog = await makeBlog();
    const u = await makeUser({ username: 'feeder1' });
    await feed(blog.id, u.id, 2);

    const r = await getFeeders(blog.id);
    expect(r.feeders).toEqual([
      { user_id: u.id, username: 'feeder1', avatar_path: null, amount: 2 },
    ]);
  });

  it('limit 被夹在 1..200，offset 不接受负数', async () => {
    const blog = await makeBlog();
    expect((await getFeeders(blog.id, 0, 9999)).limit).toBe(200);
    expect((await getFeeders(blog.id, 0, 0)).limit).toBe(1);
    expect((await getFeeders(blog.id, -5, 50)).offset).toBe(0);
  });

  it('分页：total 是全量而非当页', async () => {
    const blog = await makeBlog();
    for (let i = 0; i < 4; i++) {
      const u = await makeUser({ username: `f${i}` });
      await feed(blog.id, u.id, i + 1);
    }
    const r = await getFeeders(blog.id, 1, 2);
    expect(r.total).toBe(4);
    expect(r.feeders).toHaveLength(2);
  });
});
