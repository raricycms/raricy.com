import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { runAsBackendOps } from '@/lib/audit-context';
import { archiveUser, unarchiveUser } from '@/lib/user-archive-service';
import { postEntry } from '@/lib/fish-service';
import { nowForDb } from '@/lib/db-time';
import { toggleLike, getBlogDetail } from '@/lib/blog-service';
import { createComment, listCommentsForBlog, toggleCommentLike, softDeleteComment } from '@/lib/comment-service';
import { listUsers, setRole } from '@/lib/admin-user-service';
import { getCommentForAdmin } from '@/lib/admin-comment-service';
import { getPublicProfile } from '@/lib/user-service';
import { ensureLobbyChannel, listMessages, listChannelsForUser } from '@/lib/chat-service';
import { mintFishToken, validateFishToken } from '@/lib/fish-token-service';
import { createAccessToken, createOAuthApplication, validateAccessToken } from '@/lib/oauth';
import { sendNotification, getUnreadCount } from '@/lib/notification-service';
import { isStreamSessionCurrent, isChatStreamSessionCurrent, verifiedStreamWriter } from '@/lib/stream-session';
import { verifyCredentials } from '@/lib/credential-auth';
import { hashPassword } from '@/lib/password';
import { readFileSync } from 'node:fs';
import { planCompensation } from '@/lib/fish-compensate';

beforeEach(resetDb);

async function fixture() {
  const owner = await makeUser({ role: 'owner' });
  const user = await makeFishUser(12.3456, { role: 'core' });
  const reader = await makeUser({ role: 'core' });
  const input = { actor: owner, username: user.username, reason: '批量账号复核' };
  return { owner, user, reader, input };
}

describe('CLI 专用账号归档', () => {
  it('网页调用、非站长主体、归档自己均被拒绝', async () => {
    const { user, reader, input } = await fixture();
    expect((await archiveUser(input)).ok).toBe(false);
    expect((await runAsBackendOps(() => archiveUser({ ...input, actor: reader }))).ok).toBe(false);
    expect((await runAsBackendOps(() => archiveUser({ ...input, username: input.actor.username }))).ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).archivedAt).toBeNull();
    await expectLedgerConsistent();
  });

  it('原子撤销文章/评论点赞、清钱包、作废仓位；重复归档不再次记账', async () => {
    const { user, reader, input } = await fixture();
    const blog = await makeBlog({ authorId: reader.id });
    const comment = await createComment({ blogId: blog.id, authorId: reader.id, content: '可见评论' });
    expect(comment.ok).toBe(true);
    if (!comment.ok) return;
    await toggleLike(blog.id, user.id);
    await toggleLike(blog.id, reader.id);
    await toggleCommentLike(comment.comment.id, user.id);
    const position = await prisma.marketPosition.create({ data: {
      id: crypto.randomUUID(), userId: user.id, symbol: 'BTCUSDT', stakeUnits: 10000,
      entryPrice: 100, entryQuoteAt: nowForDb(), openKey: crypto.randomUUID(), createdAt: nowForDb(),
    } });
    expect((await runAsBackendOps(() => archiveUser(input))).ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect((await prisma.blog.findUniqueOrThrow({ where: { id: blog.id } })).likesCount).toBe(1);
    expect((await prisma.blogComment.findUniqueOrThrow({ where: { id: comment.comment.id } })).likesCount).toBe(0);
    expect(await toggleLike(blog.id, user.id)).toEqual({ notFound: true });
    expect(await toggleCommentLike(comment.comment.id, user.id)).toEqual({ notFound: true });
    await runAsBackendOps(async () => {
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.driedFish).toBe(0);
      expect(after.sessionVersion).toBe(user.sessionVersion + 1);
      expect(after.archiveReason).toBe(input.reason);
      expect((await prisma.blogLike.findFirstOrThrow({ where: { userId: user.id } })).deleted).toBe(true);
      expect((await prisma.commentLike.findFirstOrThrow({ where: { userId: user.id } })).deleted).toBe(true);
      expect((await prisma.marketPosition.findUniqueOrThrow({ where: { id: position.id } })).status).toBe('archived');
      expect((await archiveUser(input)).ok).toBe(true);
      expect(await prisma.fishTransaction.count({ where: { userId: user.id, type: 'archive_clear' } })).toBe(1);
      expect(await prisma.adminActionLog.count({ where: { action: 'archive_user', visibility: 'internal' } })).toBe(1);
      await expectLedgerConsistent('归档和重复归档');
      await expect(prisma.$transaction(tx => postEntry(tx, { userId: user.id, units: 10000, type: 'admin_grant' }))).rejects.toThrow();
      await expectLedgerConsistent('归档后拒绝入账');
      expect((await planCompensation({ amount: 1 })).total).toBe(2);
    });
    expect((await listUsers({ search: user.username })).total).toBe(0);
    expect((await setRole({ actor: input.actor, targetId: user.id, newRole: 'admin' })).ok).toBe(false);
  });

  it('文章和资料不可达；评论保留回复结构、抹正文和作者；CLI 仍能读原文', async () => {
    const { user, reader, input } = await fixture();
    const ownBlog = await makeBlog({ authorId: user.id });
    const otherBlog = await makeBlog({ authorId: reader.id });
    const parent = await createComment({ blogId: otherBlog.id, authorId: user.id, content: '归档评论原文' });
    expect(parent.ok).toBe(true); if (!parent.ok) return;
    const reply = await createComment({ blogId: otherBlog.id, authorId: reader.id, parentId: parent.comment.id, content: '保留的回复' });
    expect(reply.ok).toBe(true); if (!reply.ok) return;
    await runAsBackendOps(() => archiveUser(input));
    expect(await getBlogDetail(ownBlog.id, { id: reader.id, isCore: true })).toBeNull();
    expect(await getPublicProfile(user.id, null)).toBeNull();
    expect(await getCommentForAdmin(parent.comment.id)).toBeNull();
    const tree = await listCommentsForBlog(otherBlog.id, reader.id);
    expect(tree).toHaveLength(1);
    expect(tree[0].is_deleted).toBe(true);
    expect(tree[0].content).not.toContain('归档评论原文');
    expect(tree[0].author.id).toBeNull();
    expect(tree[0].author.username).toBe('已删除用户');
    expect(tree[0].image).toBeNull();
    expect(tree[0].children[0].content).toBe('保留的回复');
    expect((await prisma.blog.findUniqueOrThrow({ where: { id: otherBlog.id } })).commentsCount).toBe(1);
    await runAsBackendOps(async () => {
      expect((await getCommentForAdmin(parent.comment.id))?.content).toBe('归档评论原文');
      expect(await prisma.blog.findUnique({ where: { id: ownBlog.id } })).not.toBeNull();
      await softDeleteComment(reply.comment.id, input.actor, 'CLI 后续管理操作');
      expect((await prisma.blog.findUniqueOrThrow({ where: { id: otherBlog.id } })).commentsCount).toBe(0);
    });
  });

  it('讨论正文、引用摘要、作者和未读数都按已删除处理', async () => {
    const { user, reader, input } = await fixture();
    await ensureLobbyChannel();
    await prisma.chatMember.create({ data: { channelId: 'lobby', userId: reader.id, lastReadMessageId: 0, createdAt: nowForDb() } });
    const msg = await prisma.chatMessage.create({ data: { channelId: 'lobby', authorId: user.id, content: `讨论原文 @${reader.username} `, createdAt: nowForDb() } });
    await prisma.chatMessage.create({ data: { channelId: 'lobby', authorId: reader.id, content: '正常回复', replyTo: msg.id, createdAt: nowForDb() } });
    await runAsBackendOps(() => archiveUser(input));
    const result = await listMessages('lobby', reader.id);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.messages[0].is_deleted).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain('讨论原文');
    expect(JSON.stringify(result.messages)).not.toContain(user.username);
    expect(result.messages[1].reply?.is_deleted).toBe(true);
    const channels = await listChannelsForUser(reader.id);
    // 既有未读口径也计本人消息；只剩上面的正常回复，归档消息不再计数。
    expect(channels.find(c => c.id === 'lobby')?.unread_count).toBe(1);
  });

  it('凭据与旧会话作废；恢复仅恢复账号及原来可见的内容', async () => {
    const { owner, user, reader, input } = await fixture();
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword('password123') } });
    const live = await makeBlog({ authorId: user.id });
    const dead = await makeBlog({ authorId: user.id, ignore: true });
    await toggleLike(live.id, user.id);
    const app = await createOAuthApplication({ name: 'archive-test', redirectUris: ['https://example.com/callback'] }, owner.id);
    const oauth = await createAccessToken(app.application.id, user.id, ['profile']);
    const token = await mintFishToken(user.id);
    await sendNotification({ recipientId: reader.id, actorId: user.id, action: '文章点赞', objectType: 'blog', objectId: live.id, detail: '原文快照' });
    expect(await validateAccessToken(oauth.token)).not.toBeNull();
    await runAsBackendOps(() => archiveUser(input));
    expect(await validateAccessToken(oauth.token)).toBeNull();
    expect(await validateFishToken(token.token)).toBeNull();
    expect((await verifyCredentials(user.username, 'password123')).ok).toBe(false);
    expect(await isStreamSessionCurrent(user)).toBe(false);
    expect(await isChatStreamSessionCurrent({
      id: user.id,
      sessionVersion: user.sessionVersion,
      lobbyBlocked: false,
    })).toBe(false);
    expect(await getUnreadCount(reader.id)).toBe(0);
    expect((await runAsBackendOps(() => unarchiveUser({ ...input, reason: '复核后恢复' }))).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).driedFish).toBe(0);
    expect(await getBlogDetail(live.id, { id: reader.id, isCore: true })).not.toBeNull();
    expect(await getBlogDetail(dead.id, { id: reader.id, isCore: true })).toBeNull();
    expect((await prisma.blog.findUniqueOrThrow({ where: { id: live.id } })).likesCount).toBe(0);
    expect(await validateAccessToken(oauth.token)).toBeNull();
    expect(await validateFishToken(token.token)).toBeNull();
    expect(await isStreamSessionCurrent(user)).toBe(false);
    await runAsBackendOps(() => expectLedgerConsistent('恢复后'));
    expect(await prisma.adminActionLog.count({ where: { action: { in: ['archive_user', 'unarchive_user'] } } })).toBe(0);
    expect(await runAsBackendOps(() => prisma.adminActionLog.count({ where: { action: { in: ['archive_user', 'unarchive_user'] } } }))).toBe(2);
  });

  it('归档状态写入失败时，扣款和撤赞一并回滚', async () => {
    const { user, reader, input } = await fixture();
    const blog = await makeBlog({ authorId: reader.id });
    await toggleLike(blog.id, user.id);
    await prisma.$executeRawUnsafe("CREATE TRIGGER test_reject_archive BEFORE UPDATE ON users WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test archive failure'); END");
    try {
      await expect(runAsBackendOps(() => archiveUser(input))).rejects.toThrow();
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_archive'); }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).driedFish).toBe(123456);
    expect(await prisma.blogLike.count({ where: { userId: user.id, deleted: false } })).toBe(1);
    expect(await prisma.fishTransaction.count({ where: { type: 'archive_clear' } })).toBe(0);
    await expectLedgerConsistent('事务失败回滚');
  });

  it('扩展查询边界覆盖所有自有内容与分页计数，且后台上下文不会泄漏到并发网页查询', async () => {
    const { user, input } = await fixture();
    await prisma.imageHosting.create({ data: { id: 'archive-img', authorId: user.id, filename: 'private.png', mimeType: 'image/png', fileSize: 10, createdAt: nowForDb() } });
    await runAsBackendOps(() => archiveUser(input));
    const [web, cli] = await Promise.all([
      prisma.user.count({ where: { id: user.id } }),
      runAsBackendOps(() => prisma.user.count({ where: { id: user.id } })),
    ]);
    expect([web, cli]).toEqual([0, 1]);
    expect(await prisma.imageHosting.findUnique({ where: { id: 'archive-img' } })).toBeNull();
    expect(await prisma.imageHosting.count()).toBe(0);
    expect(await prisma.user.count({ where: { AND: [{ id: user.id }, { role: 'core' }] } })).toBe(0);
    expect(await prisma.user.count({ where: { AND: [{ id: input.actor.id }, { role: 'owner' }] } })).toBe(1);
    await expect(prisma.user.update({ where: { id: user.id }, data: { role: 'admin' } })).rejects.toThrow();
  });

  it('归档迁移可在旧表上保留原数据并提供默认未归档/未撤赞状态', async () => {
    // 测试库内另起验证表执行 ALTER SQL；不依赖 db push 替迁移作证。
    const sql = readFileSync(new URL('../../prisma/migrations/29_user_archive/migration.sql', import.meta.url), 'utf8');
    const renamed = sql.replace(/\busers\b/g, 'archive_test_users').replace(/\bcomment_likes\b/g, 'archive_test_comment_likes')
      .replace(/\bnotifications\b/g, 'archive_test_notifications').replace(/ix_users_archived_at/g, 'archive_test_index');
    try {
      for (const statement of ['CREATE TABLE archive_test_users(id TEXT)', 'CREATE TABLE archive_test_comment_likes(id INTEGER)', 'CREATE TABLE archive_test_notifications(id TEXT)', "INSERT INTO archive_test_users VALUES ('kept')", 'INSERT INTO archive_test_comment_likes VALUES (1)']) await prisma.$executeRawUnsafe(statement);
      for (const statement of renamed.split(';').filter(s => s.trim())) await prisma.$executeRawUnsafe(statement);
      expect(await prisma.$queryRawUnsafe('SELECT id, archived_at FROM archive_test_users')).toMatchObject([{ id: 'kept', archived_at: null }]);
      expect(await prisma.$queryRawUnsafe('SELECT deleted FROM archive_test_comment_likes')).toMatchObject([{ deleted: false }]);
    } finally {
      for (const table of ['archive_test_users', 'archive_test_comment_likes', 'archive_test_notifications']) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('另一进程撤权后，不投递下一条 SSE 数据帧', async () => {
    const { user, input } = await fixture();
    const sent: string[] = [];
    let closed = false;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const writer = verifiedStreamWriter(() => isStreamSessionCurrent(user), chunk => { sent.push(chunk); return true; }, () => { closed = true; finish(); }, 3);
    await runAsBackendOps(() => archiveUser(input));
    writer('私有消息');
    await done;
    expect(closed).toBe(true);
    expect(sent).toEqual([]);
  });
});
