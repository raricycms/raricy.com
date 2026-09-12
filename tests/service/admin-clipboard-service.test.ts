// ─────────────────────────────────────────────────────────────────────────────
// admin-clipboard-service.test.ts —— 管理端剪贴板检索与恢复
//
// 两条最值得钉的：
//   ★ 列表**绝不取正文** —— ClipText.content 上限 5 万字，一页 20 行就是近一兆
//   ★ 能看见被软删 / 被设为私有的行 —— clipboard-service 的 getClip 恰好看不见
//     （它带 ignore:false），所以管理端必须有另一套读取
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import {
  getClipForAdmin,
  listAdminClips,
  restoreClip,
  softDeleteClip,
} from '@/lib/admin-clipboard-service';
import type { SafeUser } from '@/lib/auth';
import { nowForDb } from '@/lib/db-time';

async function makeClip(opts: {
  authorId: string;
  title?: string;
  content?: string;
  ignore?: boolean;
  publicity?: boolean;
}) {
  const id = Math.random().toString(36).slice(2, 10);
  await prisma.clipBoard.create({
    data: {
      id,
      title: opts.title ?? '未命名剪贴板',
      authorId: opts.authorId,
      ignore: opts.ignore ?? false,
      publicity: opts.publicity ?? true,
      createdAt: nowForDb(),
      content: { create: { content: opts.content ?? '正文', updatedAt: nowForDb() } },
    },
  });
  return { id };
}

function asActor(u: { id: string; role: string }): SafeUser {
  return u as unknown as SafeUser;
}

beforeEach(async () => {
  await resetDb();
});

describe('listAdminClips：能看见已删与私有', () => {
  it('★ status 三态：all 含已删 / active 只剩活的 / deleted 只剩已删', async () => {
    const author = await makeUser();
    const alive = await makeClip({ authorId: author.id, title: '活的' });
    const gone = await makeClip({ authorId: author.id, title: '删了的', ignore: true });

    expect((await listAdminClips({ status: 'all' })).total).toBe(2);
    expect((await listAdminClips({ status: 'active' })).clips.map((c) => c.id)).toEqual([alive.id]);
    expect((await listAdminClips({ status: 'deleted' })).clips.map((c) => c.id)).toEqual([gone.id]);
  });

  it('按 publicity 筛：private 能单独捞出来（网页端根本不列）', async () => {
    const author = await makeUser();
    await makeClip({ authorId: author.id, title: '公开', publicity: true });
    await makeClip({ authorId: author.id, title: '私有', publicity: false });

    expect((await listAdminClips({ publicity: 'private' })).total).toBe(1);
    expect((await listAdminClips({ publicity: 'public' })).total).toBe(1);
    expect((await listAdminClips({ publicity: 'all' })).total).toBe(2);
  });

  it('★ 列表载荷里没有正文（5 万字 × 20 行 = 近一兆）', async () => {
    const author = await makeUser();
    await makeClip({ authorId: author.id, content: 'x'.repeat(5000) });

    const { clips } = await listAdminClips({});
    expect(Object.keys(clips[0])).not.toContain('content');
    expect(JSON.stringify(clips).length, '列表载荷被正文撑大了').toBeLessThan(1000);
  });
});

describe('listAdminClips：搜索', () => {
  it('按标题搜', async () => {
    const author = await makeUser();
    await makeClip({ authorId: author.id, title: '构建报错排查' });
    await makeClip({ authorId: author.id, title: '无关' });
    expect((await listAdminClips({ search: '报错' })).total).toBe(1);
  });

  it('按 8 位短 id 精确命中（直接粘 id 是运维常见动作）', async () => {
    const author = await makeUser();
    const clip = await makeClip({ authorId: author.id, title: '标题' });
    const r = await listAdminClips({ search: clip.id });
    expect(r.total).toBe(1);
    expect(r.clips[0].id).toBe(clip.id);
  });

  it('★ 按正文搜（正文在关联表里，要跨表过滤）', async () => {
    const author = await makeUser();
    await makeClip({ authorId: author.id, title: 'A', content: '这里有报错栈信息' });
    await makeClip({ authorId: author.id, title: 'B', content: '无关内容' });
    expect((await listAdminClips({ search: '报错栈' })).total).toBe(1);
  });

  it('按作者用户名搜', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    await makeClip({ authorId: bob.id, title: 'bob 的' });
    await makeClip({ authorId: alice.id, title: 'alice 的' });
    expect((await listAdminClips({ search: 'bob' })).total).toBe(1);
  });
});

describe('getClipForAdmin', () => {
  it('★ 能读到已删的剪贴板与它的正文（getClip 恰好看不见这个）', async () => {
    const author = await makeUser({ username: 'alice' });
    const clip = await makeClip({
      authorId: author.id,
      title: '删掉的',
      content: '要找回的正文',
      ignore: true,
    });

    const row = await getClipForAdmin(clip.id);
    expect(row).not.toBeNull();
    expect(row!.ignore).toBe(true);
    expect(row!.content?.content).toBe('要找回的正文');
  });
});

describe('restoreClip', () => {
  it('★ 翻回 ignore=false 并写一条审计日志', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const clip = await makeClip({ authorId: author.id, ignore: true });

    const r = await restoreClip(clip.id, asActor(owner), '误删');

    expect(r.ok).toBe(true);
    expect((await prisma.clipBoard.findUnique({ where: { id: clip.id } }))!.ignore).toBe(false);

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'restore_clip' } });
    expect(log).not.toBeNull();
    expect(log!.adminId).toBe(owner.id);
    expect(log!.targetUserId).toBe(author.id);
    expect(log!.objectId).toBe(clip.id);
  });

  it('本来就没被删 → 400，不重复写日志', async () => {
    const owner = await makeUser({ role: 'owner' });
    const clip = await makeClip({ authorId: owner.id });

    expect(await restoreClip(clip.id, asActor(owner))).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.adminActionLog.count({ where: { action: 'restore_clip' } })).toBe(0);
  });

  it('不存在的 id → 404', async () => {
    const owner = await makeUser({ role: 'owner' });
    expect(await restoreClip('nope', asActor(owner))).toMatchObject({ ok: false, code: 404 });
  });

  it('既不是作者也不是站长 → 403', async () => {
    const admin = await makeUser({ role: 'admin' });
    const author = await makeUser({ role: 'core' });
    const clip = await makeClip({ authorId: author.id, ignore: true });

    expect(await restoreClip(clip.id, asActor(admin))).toMatchObject({ ok: false, code: 403 });
  });
});

describe('softDeleteClip', () => {
  it('软删并写审计日志（网页端的 deleteClip 不写日志，这是新增能力）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const author = await makeUser({ role: 'core' });
    const clip = await makeClip({ authorId: author.id });

    const r = await softDeleteClip(clip.id, asActor(owner), '含广告');

    expect(r.ok).toBe(true);
    expect((await prisma.clipBoard.findUnique({ where: { id: clip.id } }))!.ignore).toBe(true);
    const log = await prisma.adminActionLog.findFirst({ where: { action: 'delete_clip' } });
    expect(log!.reason).toBe('含广告');
    expect(log!.targetUserId).toBe(author.id);
  });

  it('已删的再删 → 404（deleteClip 只找 ignore=false 的）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const clip = await makeClip({ authorId: owner.id, ignore: true });
    expect(await softDeleteClip(clip.id, asActor(owner), 'x')).toMatchObject({ ok: false, code: 404 });
  });
});
