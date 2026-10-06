import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBlog, makeUser, prisma, resetDb } from '../helpers/db';
import { COMMENT_MENTION_ACTION, createComment } from '@/lib/comment-service';
import * as notifications from '@/lib/notification-service';

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function fixture() {
  const author = await makeUser({ username: 'writer', role: 'core' });
  const commenter = await makeUser({ username: 'speaker', role: 'core' });
  const target = await makeUser({ username: 'target', role: 'core' });
  const blog = await makeBlog({ authorId: author.id });
  return { author, commenter, target, blog };
}

describe('博客评论 @ 通知', () => {
  it('重复 @ 一人只发一条；通知指向文章，自己与不存在的名字不发送', async () => {
    const { author, commenter, target, blog } = await fixture();
    const result = await createComment({
      blogId: blog.id, authorId: commenter.id,
      content: '@target 你好 @target @speaker @missing',
    });
    expect(result.ok).toBe(true);
    const rows = await prisma.notification.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.find((n) => n.recipientId === author.id)?.action).toBe('文章评论');
    expect(rows.find((n) => n.recipientId === target.id)).toMatchObject({
      action: COMMENT_MENTION_ACTION, actorId: commenter.id,
      objectType: 'blog', objectId: blog.id,
    });
  });

  it('文章作者和被回复者已有通知时去重；回复里仍能 @ 其他人', async () => {
    const { author, commenter, target, blog } = await fixture();
    const parent = await createComment({ blogId: blog.id, authorId: target.id, content: '原评论' });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    await createComment({
      blogId: blog.id, authorId: commenter.id, parentId: parent.comment.id,
      content: '@target @writer',
    });
    const replyRows = await prisma.notification.findMany({ where: { actorId: commenter.id } });
    expect(replyRows).toHaveLength(2);
    expect(replyRows.find((n) => n.recipientId === target.id)?.action).toBe('评论回复');
    expect(replyRows.find((n) => n.recipientId === author.id)?.action).toBe(COMMENT_MENTION_ACTION);

    await createComment({ blogId: blog.id, authorId: commenter.id, content: '@writer' });
    const authorRows = await prisma.notification.findMany({
      where: { recipientId: author.id, actorId: commenter.id },
    });
    expect(authorRows.map((n) => n.action).sort()).toEqual(['文章评论', COMMENT_MENTION_ACTION].sort());
  });

  it('公开文章也不通知非核心账号；专注或禁言中的 core 仍可读评论', async () => {
    const { commenter, target, blog } = await fixture();
    await makeUser({ username: 'ordinary', role: 'user' });
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'public' } });
    await prisma.user.update({ where: { id: target.id }, data: { focusMode: true, isBanned: true } });
    await createComment({ blogId: blog.id, authorId: commenter.id, content: '@ordinary @target' });
    const rows = await prisma.notification.findMany({ where: { action: COMMENT_MENTION_ACTION } });
    expect(rows.map((n) => n.recipientId)).toEqual([target.id]);
  });

  it('匿名 @ 通知只有化名，名片 / 表情 token 与标点不触发提及', async () => {
    const { commenter, target, blog } = await fixture();
    await createComment({
      blogId: blog.id, authorId: commenter.id, anonymous: true,
      content: '@target 你好 [@用户/writer] [@writer/表情]',
    });
    const rows = await prisma.notification.findMany({ where: { action: COMMENT_MENTION_ACTION } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientId: target.id, actorId: null });
    expect(rows[0].detail).toContain('匿名读者「');
    expect(rows[0].detail).not.toContain(commenter.username);
    expect(rows[0].detail).not.toContain(commenter.id);
    await createComment({ blogId: blog.id, authorId: commenter.id, content: '@target，你好' });
    expect(await prisma.notification.count({ where: { action: COMMENT_MENTION_ACTION } })).toBe(1);
  });

  it('某一人的通知失败不影响评论落库或后续收件人', async () => {
    const { commenter, target, blog } = await fixture();
    const next = await makeUser({ username: 'target_two', role: 'owner' });
    const original = notifications.sendNotification;
    vi.spyOn(notifications, 'sendNotification').mockImplementation(async (input) => {
      if (input.recipientId === target.id) throw new Error('test delivery failure');
      return original(input);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createComment({
      blogId: blog.id, authorId: commenter.id, content: '@target @target_two',
    });
    expect(result.ok).toBe(true);
    expect(await prisma.blogComment.count({ where: { blogId: blog.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: next.id } })).toBe(1);
    expect(log).toHaveBeenCalled();
  });
});
