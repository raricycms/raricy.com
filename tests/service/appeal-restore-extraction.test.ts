// ─────────────────────────────────────────────────────────────────────────────
// appeal-restore-extraction.test.ts —— 钉死「裁决通过」的审计行为
//
// 【为什么单独一个文件】decideAppeal 里内联着一段「恢复被删评论」的事务
// （设 isDeleted=false + 重算 commentsCount / lastCommentAt），它要被抽成
// comment-service 的 restoreCommentRow 供运维 CLI 复用。
//
// 现有用例（admin-user-and-appeal.test.ts）覆盖的是**数据效果**：isDeleted 复位、
// 计数回补、幂等、objectType 把关。它们覆盖不到的是：
//
//   ★ 裁决通过只写**一条**审计日志（decide_appeal），不额外写 restore_comment。
//
// 这条正是最容易在重构里悄悄坏掉的：如果把「带审计的 restoreComment」当成
// 「不带审计的 restoreCommentRow」接进去，每次裁决都会凭空多一行 ——
// /audit 公示页会变长，而所有既有断言照样绿。所以抽之前先把这条钉死：
// 先跑通（证明它描述的确实是当前行为），再重构，再跑（证明行为没变）。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeBlog, makeUser, prisma, resetDb } from '../helpers/db';
import { adjudicate } from '@/lib/admin-appeal-service';
import { nowForDb } from '@/lib/db-time';
import type { SafeUser } from '@/lib/auth';

/** 造一个「已软删」的评论。 */
async function makeDeletedComment(blogId: string, authorId: string) {
  return prisma.blogComment.create({
    data: {
      id: `c-${Math.random().toString(36).slice(2, 10)}`,
      blogId,
      authorId,
      content: '被删的评论',
      status: 'approved',
      isDeleted: true,
      createdAt: nowForDb(),
    },
    select: { id: true, createdAt: true },
  });
}

/** 造一条 delete_comment 审计日志 + 针对它的 pending 申诉。 */
async function makePendingAppeal(opts: {
  action: string;
  adminId: string;
  appellantId: string;
  targetUserId: string;
  objectType: string;
  objectId: string;
}) {
  // 不回读 extra（SQLite 的 JSON 列驱动层读不了，见 admin-user-service 文件头）
  const log = await prisma.adminActionLog.create({
    data: {
      action: opts.action,
      adminId: opts.adminId,
      targetUserId: opts.targetUserId,
      objectType: opts.objectType,
      objectId: opts.objectId,
      reason: '测试',
      createdAt: nowForDb(),
    },
    select: { id: true },
  });
  const appeal = await prisma.adminActionAppeal.create({
    data: {
      logId: log.id,
      appellantId: opts.appellantId,
      content: '我不服',
      status: 'pending',
      createdAt: nowForDb(),
      updatedAt: nowForDb(),
    },
    select: { id: true },
  });
  return { logId: log.id, appealId: appeal.id };
}

function asActor(u: { id: string; role: string }): SafeUser {
  return u as unknown as SafeUser;
}

beforeEach(async () => {
  await resetDb();
});

describe('decideAppeal：恢复评论时的审计日志条数', () => {
  it('★ 裁决通过只写一条 decide_appeal，不额外写 restore_comment', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id });
    const comment = await makeDeletedComment(blog.id, author.id);

    const { appealId } = await makePendingAppeal({
      action: 'delete_comment',
      adminId: owner.id,
      appellantId: author.id,
      targetUserId: author.id,
      objectType: 'comment',
      objectId: comment.id,
    });

    const before = await prisma.adminActionLog.count();

    expect((await adjudicate({ actor: asActor(owner), appealId, decision: 'accept' })).ok).toBe(true);

    const after = await prisma.adminActionLog.count();
    expect(after - before, '裁决通过多写了一条审计日志').toBe(1);

    const added = await prisma.adminActionLog.findMany({
      orderBy: { id: 'desc' },
      take: 1,
      select: { action: true, objectType: true, objectId: true },
    });
    expect(added[0]).toMatchObject({
      action: 'decide_appeal',
      objectType: 'admin_action_appeal',
      objectId: String(appealId),
    });

    expect(
      await prisma.adminActionLog.count({ where: { action: 'restore_comment' } }),
      '恢复被删评论这件事由 decide_appeal 那条日志覆盖，不该另起一条'
    ).toBe(0);
  });

  it('恢复本身确实生效（计数与最后评论时间都回补）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id });
    const comment = await makeDeletedComment(blog.id, author.id);
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 0, lastCommentAt: null },
    });

    const { appealId } = await makePendingAppeal({
      action: 'delete_comment',
      adminId: owner.id,
      appellantId: author.id,
      targetUserId: author.id,
      objectType: 'comment',
      objectId: comment.id,
    });

    await adjudicate({ actor: asActor(owner), appealId, decision: 'accept' });

    expect((await prisma.blogComment.findUnique({ where: { id: comment.id } }))!.isDeleted).toBe(false);
    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(1);
    expect(b!.lastCommentAt!.getTime()).toBe(comment.createdAt!.getTime());
  });

  it('评论本来就没被删 → 幂等：不重算计数、也不写多余日志', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: author.id });
    const alive = await prisma.blogComment.create({
      data: {
        id: 'c-alive',
        blogId: blog.id,
        authorId: author.id,
        content: '还在',
        status: 'approved',
        isDeleted: false,
        createdAt: nowForDb(),
      },
      select: { id: true },
    });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 1, lastCommentAt: nowForDb() },
    });

    const { appealId } = await makePendingAppeal({
      action: 'delete_comment',
      adminId: owner.id,
      appellantId: author.id,
      targetUserId: author.id,
      objectType: 'comment',
      objectId: alive.id,
    });

    const before = await prisma.adminActionLog.count();
    await adjudicate({ actor: asActor(owner), appealId, decision: 'accept' });

    expect(await prisma.adminActionLog.count()).toBe(before + 1); // 仍只有 decide_appeal
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.commentsCount).toBe(1);
  });
});
