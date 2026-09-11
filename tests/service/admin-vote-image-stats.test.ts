// ─────────────────────────────────────────────────────────────────────────────
// admin-vote-image-stats.test.ts —— 投票 / 图床的管理端服务 + 站点概览
//
// 三个文件放一起，因为它们同构且都属「运维台的读侧」。
// 最值得盯的两条：
//   ★ 图床恢复前能发现「记录还在、磁盘文件没了」—— 否则恢复出来是坏图
//   ★ 概览里的 banned 与 newToday 必须守各自的口径（禁言到期不自动清标志位；
//     「今天」要从 UTC+8 的零点算）
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeBlog, makeUser, prisma, resetDb } from '../helpers/db';
import { getVoteForAdmin, listAdminVotes, restoreVote, softDeleteVote } from '@/lib/admin-vote-service';
import { getImageForAdmin, listAdminImages, restoreImage } from '@/lib/admin-image-service';
import { getSiteStats } from '@/lib/admin-stats-service';
import { dayStart, nowForDb, todayStr } from '@/lib/db-time';
import type { SafeUser } from '@/lib/auth';

function asActor(u: { id: string; role: string }): SafeUser {
  return u as unknown as SafeUser;
}

const HOUR = 3600 * 1000;

async function makeVote(opts: { authorId: string; title?: string; ignore?: boolean }) {
  const id = Math.random().toString(36).slice(2, 11);
  await prisma.vote.create({
    data: {
      id,
      title: opts.title ?? '未命名投票',
      authorId: opts.authorId,
      ignore: opts.ignore ?? false,
      createdAt: nowForDb(),
    },
  });
  return { id };
}

async function makeImage(opts: {
  authorId: string;
  filename?: string;
  ignore?: boolean;
  fileSize?: number;
}) {
  const id = Math.random().toString(36).slice(2, 12);
  await prisma.imageHosting.create({
    data: {
      id,
      filename: opts.filename ?? 'a.png',
      fileSize: opts.fileSize ?? 1024,
      mimeType: 'image/png',
      authorId: opts.authorId,
      ignore: opts.ignore ?? false,
      isPublic: true,
      createdAt: nowForDb(),
    },
  });
  return { id };
}

beforeEach(async () => {
  await resetDb();
});

// ── 投票 ─────────────────────────────────────────────────────────────────────

describe('listAdminVotes', () => {
  it('★ status 三态：all 含已删 / active 只剩活的 / deleted 只剩已删', async () => {
    const author = await makeUser();
    const alive = await makeVote({ authorId: author.id, title: '活的' });
    const gone = await makeVote({ authorId: author.id, title: '删了的', ignore: true });

    expect((await listAdminVotes({ status: 'all' })).total).toBe(2);
    expect((await listAdminVotes({ status: 'active' })).votes.map((v) => v.id)).toEqual([alive.id]);
    expect((await listAdminVotes({ status: 'deleted' })).votes.map((v) => v.id)).toEqual([gone.id]);
  });

  it('按标题 / 9 位短 id / 作者搜', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const v = await makeVote({ authorId: bob.id, title: '午饭吃什么' });
    await makeVote({ authorId: alice.id, title: '无关' });

    expect((await listAdminVotes({ search: '午饭' })).total).toBe(1);
    expect((await listAdminVotes({ search: v.id })).votes[0].id).toBe(v.id);
    expect((await listAdminVotes({ search: 'bob' })).total).toBe(1);
  });

  it('带票数与选项数（运维一眼看出这投票有没有人投过）', async () => {
    const author = await makeUser();
    const v = await makeVote({ authorId: author.id });
    const r = await listAdminVotes({});
    expect(r.votes[0]).toMatchObject({ id: v.id });
    expect(r.votes[0]._count).toEqual({ records: 0, options: 0 });
  });
});

describe('getVoteForAdmin', () => {
  it('★ 不过滤 ignore，且带选项 label 与票数', async () => {
    const author = await makeUser({ username: 'alice' });
    const v = await makeVote({ authorId: author.id, title: '删掉的投票', ignore: true });
    await prisma.voteOption.create({
      data: { voteId: v.id, label: '选项甲', sortOrder: 0, voteCount: 3 },
    });

    const row = await getVoteForAdmin(v.id);
    expect(row!.ignore).toBe(true);
    expect(row!.options[0]).toMatchObject({ label: '选项甲', voteCount: 3 });
  });
});

describe('restoreVote / softDeleteVote', () => {
  it('恢复：翻 ignore + 审计；票数与选项不受影响', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const v = await makeVote({ authorId: author.id, ignore: true });
    await prisma.voteOption.create({
      data: { voteId: v.id, label: '甲', sortOrder: 0, voteCount: 7 },
    });

    expect((await restoreVote(v.id, asActor(owner), '误删')).ok).toBe(true);
    expect((await prisma.vote.findUnique({ where: { id: v.id } }))!.ignore).toBe(false);
    // 恢复只翻标志位，计票原样可用
    const opt = await prisma.voteOption.findFirst({ where: { voteId: v.id } });
    expect(opt!.voteCount).toBe(7);

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'restore_vote' } });
    expect(log!.adminId).toBe(owner.id);
    expect(log!.targetUserId).toBe(author.id);
  });

  it('未删的投票不能「恢复」→ 400', async () => {
    const owner = await makeUser({ role: 'owner' });
    const v = await makeVote({ authorId: owner.id });
    expect(await restoreVote(v.id, asActor(owner))).toMatchObject({ ok: false, code: 400 });
  });

  it('既非作者也非站长 → 403', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const v = await makeVote({ authorId: author.id, ignore: true });
    expect(await restoreVote(v.id, asActor(admin))).toMatchObject({ ok: false, code: 403 });
  });

  it('软删写审计日志，且重复软删 → 400', async () => {
    const owner = await makeUser({ role: 'owner' });
    const v = await makeVote({ authorId: owner.id });

    expect((await softDeleteVote(v.id, asActor(owner), '含违规内容')).ok).toBe(true);
    expect((await prisma.vote.findUnique({ where: { id: v.id } }))!.ignore).toBe(true);
    expect((await prisma.adminActionLog.findFirst({ where: { action: 'delete_vote' } }))!.reason).toBe(
      '含违规内容'
    );
    expect(await softDeleteVote(v.id, asActor(owner), '再来一次')).toMatchObject({ ok: false, code: 400 });
  });
});

// ── 图床 ─────────────────────────────────────────────────────────────────────

describe('listAdminImages', () => {
  it('★ status 三态（listAllImages 写死 ignore:false，看不见要恢复的行）', async () => {
    const author = await makeUser();
    const alive = await makeImage({ authorId: author.id, filename: 'a.png' });
    const gone = await makeImage({ authorId: author.id, filename: 'b.png', ignore: true });

    expect((await listAdminImages({ status: 'all' })).total).toBe(2);
    expect((await listAdminImages({ status: 'active' })).images.map((i) => i.id)).toEqual([alive.id]);
    expect((await listAdminImages({ status: 'deleted' })).images.map((i) => i.id)).toEqual([gone.id]);
  });

  it('按文件名 / 10 位短 id / 作者搜', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const img = await makeImage({ authorId: bob.id, filename: '构建报错截图.png' });
    await makeImage({ authorId: alice.id, filename: '无关.png' });

    expect((await listAdminImages({ search: '截图' })).total).toBe(1);
    expect((await listAdminImages({ search: img.id })).images[0].id).toBe(img.id);
    expect((await listAdminImages({ search: 'bob' })).total).toBe(1);
  });
});

describe('getImageForAdmin / restoreImage', () => {
  it('★ 报告磁盘文件是否存在（软删不删文件，但文件可能被手工清理过）', async () => {
    const author = await makeUser();
    const img = await makeImage({ authorId: author.id, ignore: true });

    const row = await getImageForAdmin(img.id);
    expect(row).not.toBeNull();
    expect(row!.ignore).toBe(true);
    // 测试环境没有真的落盘这个文件
    expect(row!.fileExists).toBe(false);
  });

  it('恢复：翻 ignore + 审计，并回报文件是否还在（好让运维知道恢复出来是不是坏图）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: author.id, ignore: true });

    const r = await restoreImage(img.id, asActor(owner), '误删');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileExists).toBe(false);

    expect((await prisma.imageHosting.findUnique({ where: { id: img.id } }))!.ignore).toBe(false);
    const log = await prisma.adminActionLog.findFirst({ where: { action: 'restore_image' } });
    expect(log!.targetUserId).toBe(author.id);
  });

  it('未删的图片不能「恢复」→ 400', async () => {
    const owner = await makeUser({ role: 'owner' });
    const img = await makeImage({ authorId: owner.id });
    expect(await restoreImage(img.id, asActor(owner))).toMatchObject({ ok: false, code: 400 });
  });
});

// ── 站点概览 ─────────────────────────────────────────────────────────────────

describe('getSiteStats', () => {
  it('分类计数：总数与已删数分开统计', async () => {
    const author = await makeUser({ role: 'core' });
    await makeBlog({ authorId: author.id, ignore: true });
    await makeBlog({ authorId: author.id, ignore: false });
    await makeVote({ authorId: author.id, ignore: true });
    await makeImage({ authorId: author.id, ignore: true, fileSize: 2048 });

    const s = await getSiteStats();
    expect(s.blogs.total).toBe(2);
    expect(s.blogs.deleted).toBe(1);
    expect(s.votes.deleted).toBe(1);
    expect(s.images.deleted).toBe(1);
    expect(s.images.storageBytes).toBe(2048);
  });

  it('按角色分档计数，总和等于 total', async () => {
    await makeUser({ role: 'owner' });
    await makeUser({ role: 'admin' });
    await makeUser({ role: 'core' });
    await makeUser({ role: 'user' });

    const s = await getSiteStats();
    expect(s.users.byRole).toEqual({ user: 1, core: 1, admin: 1, owner: 1 });
    expect(s.users.total).toBe(4);
  });

  it('★ banned 与 isCurrentlyBanned 同口径：禁言已过期的不算', async () => {
    const now = nowForDb();
    await makeUser({ isBanned: true, banUntil: new Date(now.getTime() + HOUR) }); // 还在禁
    await makeUser({ isBanned: true, banUntil: new Date(now.getTime() - HOUR) }); // 已过期
    await makeUser({ isBanned: true, banUntil: null }); // 永久

    // 标志位都还是 true —— 到期不会自动清，所以不能直接 count({isBanned:true})
    expect(await prisma.user.count({ where: { isBanned: true } })).toBe(3);
    expect((await getSiteStats()).users.banned).toBe(2);
  });

  it('★ newToday 从 UTC+8 的零点算（不是 setHours(0,0,0,0)）', async () => {
    const author = await makeUser();
    // 今天起点之前一分钟创建的 → 不该算进 newToday
    await prisma.blog.create({
      data: {
        id: 'b-old',
        title: '昨天的',
        authorId: author.id,
        createdAt: new Date(dayStart(todayStr()).getTime() - 60_000),
      },
    });
    await prisma.blog.create({
      data: {
        id: 'b-new',
        title: '今天的',
        authorId: author.id,
        createdAt: new Date(dayStart(todayStr()).getTime() + 60_000),
      },
    });

    expect((await getSiteStats()).blogs.newToday).toBe(1);
  });

  it('待审申诉计入概览', async () => {
    const owner = await makeUser({ role: 'owner' });
    const user = await makeUser();
    const log = await prisma.adminActionLog.create({
      data: {
        action: 'delete_blog',
        adminId: owner.id,
        targetUserId: user.id,
        objectType: 'blog',
        objectId: 'x',
        createdAt: nowForDb(),
      },
      select: { id: true },
    });
    await prisma.adminActionAppeal.create({
      data: {
        logId: log.id,
        appellantId: user.id,
        content: '不服',
        status: 'pending',
        createdAt: nowForDb(),
        updatedAt: nowForDb(),
      },
    });

    expect((await getSiteStats()).appeals.pending).toBe(1);
  });
});
