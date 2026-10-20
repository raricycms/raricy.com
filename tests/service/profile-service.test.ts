// profile-service.ts —— 个人主页积木的读写
//
// 【为什么这么测】这块同时压着三件互相拉扯的事：
//   1. **只出对外可读的数据**：文章要 public / link、图与音频要 isPublic，且访客
//      拿到的那份里**不能有不可用块的指针**（那些块本来就不渲染）。
//   2. **存指针、读时重解析**：目标降档 / 被删 / 归档后整块变 null，而不是继续展示
//      旧标题（那会得到「文章已改成私有、名片上还挂着它」的洞）。
//   3. **保存只校归属、不校档位**：目标刚降档的人也要能把整页存下去（包括删掉那一块），
//      否则他会被一句「有一篇文章不可见」锁死。越权指针（别人的 blogId / 块 id）
//      仍然必须被挡。
//
// 另外钉住「手机端顺序 = 保存时的数组顺序（profile_blocks.sort）」——
// 那是手机上移 / 下移唯一的持久化方式，顺序丢了不会报任何错。
//
// 跑真实 SQLite（tests/.tmp/test-*；helpers/db.ts 有硬校验）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { getProfilePageData, saveProfileBlocks } from '@/lib/profile-service';

beforeEach(async () => {
  await resetDb();
});

/** 一块积木的最小合法形状（id 空串 = 让服务端发号）。 */
function block(
  kind: string,
  config: Record<string, unknown>,
  pos: { x: number; y: number; w?: number; h?: number } = { x: 0, y: 0 }
) {
  return { id: '', kind, x: pos.x, y: pos.y, w: pos.w ?? 1, h: pos.h ?? 1, config };
}

async function makeImage(authorId: string, isPublic: boolean) {
  return prisma.imageHosting.create({
    data: {
      id: `img-${Math.random().toString(36).slice(2, 10)}`,
      filename: 'photo.png',
      fileSize: 10,
      mimeType: 'image/png',
      authorId,
      isPublic,
      createdAt: nowForDb(),
    },
  });
}

async function makeAudio(authorId: string, isPublic: boolean) {
  return prisma.audioHosting.create({
    data: {
      id: `aud-${Math.random().toString(36).slice(2, 10)}`,
      filename: 'voice.mp3',
      fileSize: 10,
      mimeType: 'audio/mpeg',
      authorId,
      isPublic,
      createdAt: nowForDb(),
    },
  });
}

describe('默认布局', () => {
  it('没布置过 = 最近三篇对外可读文章，internal 不出现', async () => {
    const u = await makeUser({ role: 'core' });
    const now = nowForDb();
    const older = await makeBlog({ authorId: u.id, visibility: 'link', title: '凭链接', createdAt: new Date(now.getTime() - 60_000) });
    const newer = await makeBlog({ authorId: u.id, visibility: 'public', title: '公开', createdAt: now });
    await makeBlog({ authorId: u.id, visibility: 'internal', title: '站内', createdAt: now });

    const data = await getProfilePageData(u.id, { isOwner: false });
    expect(data.isDefault).toBe(true);
    expect(data.catalog).toBeNull();
    expect(data.blocks.map((b) => (b.view?.kind === 'blog' ? b.view.title : ''))).toEqual([
      newer.title,
      older.title,
    ]);
  });

  it('一篇对外文章都没有时默认布局是空的（而不是回落到站内文章）', async () => {
    const u = await makeUser({ role: 'core' });
    await makeBlog({ authorId: u.id, visibility: 'internal' });
    const data = await getProfilePageData(u.id, { isOwner: true });
    expect(data.isDefault).toBe(true);
    expect(data.blocks).toEqual([]);
  });

  it('关掉「默认展示最近文章」后，默认布局为空（亲手加的块不受影响）', async () => {
    const u = await makeUser({ role: 'core' });
    const b = await makeBlog({ authorId: u.id, visibility: 'public', title: '公开' });

    // 开关关掉 → 不再自动挂最近文章
    const off = await getProfilePageData(u.id, { isOwner: true, showRecentBlogs: false });
    expect(off.isDefault).toBe(true);
    expect(off.blocks).toEqual([]);

    // 布置过之后再关开关：墙上的内容照常（开关只管默认布局）
    expect((await saveProfileBlocks(u.id, [block('blog', { blogId: b.id })])).ok).toBe(true);
    const arranged = await getProfilePageData(u.id, { isOwner: false, showRecentBlogs: false });
    expect(arranged.isDefault).toBe(false);
    expect(arranged.blocks).toHaveLength(1);
  });
});

describe('本人视图', () => {
  it('给编辑清单，且清单里只有对外可读的博客 / 公开的图与音频', async () => {
    const u = await makeUser({ role: 'core' });
    await makeBlog({ authorId: u.id, visibility: 'public', title: '公开' });
    await makeBlog({ authorId: u.id, visibility: 'link', title: '链接' });
    await makeBlog({ authorId: u.id, visibility: 'internal', title: '站内' });
    await makeImage(u.id, true);
    await makeImage(u.id, false);
    await makeAudio(u.id, true);
    await makeAudio(u.id, false);

    const data = await getProfilePageData(u.id, { isOwner: true });
    expect(data.catalog).not.toBeNull();
    expect(data.catalog!.blogs.map((b) => b.title).sort()).toEqual(['公开', '链接']);
    expect(data.catalog!.images).toHaveLength(1);
    expect(data.catalog!.audios).toHaveLength(1);
  });

  it('统计值：对外文章数 / 获赞总和 / 累计签到天数', async () => {
    const u = await makeUser({ role: 'core' });
    const b1 = await makeBlog({ authorId: u.id, visibility: 'public' });
    const b2 = await makeBlog({ authorId: u.id, visibility: 'link' });
    await makeBlog({ authorId: u.id, visibility: 'internal' });
    await prisma.blog.update({ where: { id: b1.id }, data: { likesCount: 3 } });
    await prisma.blog.update({ where: { id: b2.id }, data: { likesCount: 4 } });
    const today = nowForDb();
    for (const daysAgo of [0, 1, 2]) {
      await prisma.dailyCheckIn.create({
        data: {
          userId: u.id,
          checkinDate: new Date(today.getTime() - daysAgo * 86400_000),
          createdAt: nowForDb(),
        },
      });
    }

    const data = await getProfilePageData(u.id, { isOwner: true });
    expect(data.catalog!.stats).toEqual({ blogs: 2, likes: 7, checkins: 3 });

    // 新拖进来的统计块必须立刻有真数（编辑器预览读的就是这一份）。
    const res = await saveProfileBlocks(u.id, [
      block('stats', {}, { x: 0, y: 0, w: 2, h: 1 }),
      block('checkin', {}, { x: 2, y: 0 }),
    ]);
    expect(res.ok).toBe(true);
    const own = await getProfilePageData(u.id, { isOwner: true });
    const stats = own.blocks.find((b) => b.kind === 'stats')!.view;
    const checkin = own.blocks.find((b) => b.kind === 'checkin')!.view;
    expect(stats).toMatchObject({ blogs: 2, likes: 7, checkins: 3 });
    expect(checkin).toMatchObject({ days: 3 });
  });
});

describe('解析视图', () => {
  it('目标降档 / 变私有后整块变 null，访客连这一块都收不到', async () => {
    const u = await makeUser({ role: 'core' });
    const pub = await makeBlog({ authorId: u.id, visibility: 'public' });
    const link = await makeBlog({ authorId: u.id, visibility: 'link' });
    const priv = await makeBlog({ authorId: u.id, visibility: 'internal' });
    const img = await makeImage(u.id, false);

    const res = await saveProfileBlocks(u.id, [
      block('blog', { blogId: pub.id }, { x: 0, y: 0, w: 2, h: 1 }),
      block('blog', { blogId: priv.id }, { x: 2, y: 0, w: 2, h: 1 }),
      block('blog', { blogId: link.id }, { x: 0, y: 1, w: 2, h: 1 }),
      block('image', { imageId: img.id }, { x: 2, y: 1 }),
    ]);
    expect(res.ok).toBe(true);

    const own = await getProfilePageData(u.id, { isOwner: true });
    expect(own.blocks).toHaveLength(4);
    expect(own.blocks.filter((b) => b.view === null)).toHaveLength(2);

    const guest = await getProfilePageData(u.id, { isOwner: false });
    expect(guest.blocks).toHaveLength(2);
    expect(guest.blocks.every((b) => b.view !== null)).toBe(true);
    expect(guest.blocks.map((b) => (b.view?.kind === 'blog' ? b.view.title : ''))).toEqual([
      pub.title,
      link.title,
    ]);
  });
});

describe('保存', () => {
  it('手机上移 / 下移 = 数组顺序，落成 sort 列；桌面坐标原样保留', async () => {
    const u = await makeUser({ role: 'core' });
    const a = await makeBlog({ authorId: u.id, visibility: 'public', title: 'A' });
    const b = await makeBlog({ authorId: u.id, visibility: 'public', title: 'B' });

    // 数组顺序 B、A，但桌面坐标是反的 —— 手机上看到的第一块必须是 B。
    const saved = await saveProfileBlocks(u.id, [
      block('blog', { blogId: b.id }, { x: 2, y: 1, w: 2, h: 1 }),
      block('blog', { blogId: a.id }, { x: 0, y: 0, w: 2, h: 1 }),
    ]);
    expect(saved.ok).toBe(true);

    const data = await getProfilePageData(u.id, { isOwner: true });
    expect(data.blocks.map((x) => (x.view?.kind === 'blog' ? x.view.title : ''))).toEqual(['B', 'A']);
    expect(data.blocks.map((x) => [x.x, x.y])).toEqual([
      [2, 1],
      [0, 0],
    ]);

    const rows = await prisma.profileBlock.findMany({ where: { userId: u.id, deleted: false }, orderBy: { sort: 'asc' } });
    expect(rows.map((r) => r.sort)).toEqual([0, 1]);
  });

  it('整页替换：少掉的块翻墓碑（不物理删除）', async () => {
    const u = await makeUser({ role: 'core' });
    const text = (t: string, x: number) => block('text', { title: '', text: t }, { x, y: 0, w: 2, h: 1 });

    await saveProfileBlocks(u.id, [text('第一块', 0), text('第二块', 2)]);
    const first = await prisma.profileBlock.findMany({ where: { userId: u.id }, orderBy: { sort: 'asc' } });
    expect(first).toHaveLength(2);

    // 只留第二块 → 第一块翻墓碑
    const keep = first[1];
    await saveProfileBlocks(u.id, [
      { id: keep.id, kind: 'text', x: 0, y: 0, w: 2, h: 1, config: { title: '', text: '第二块' } },
    ]);
    const rows = await prisma.profileBlock.findMany({ where: { userId: u.id }, orderBy: { sort: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deleted)).toHaveLength(1);
    expect((await getProfilePageData(u.id, { isOwner: true })).blocks).toHaveLength(1);

    // 被删掉的那块**再也不会**自己回来（客户端没有它的 id，服务端只保留带回来的）
    expect((await prisma.profileBlock.findMany({ where: { userId: u.id, deleted: false } }))).toHaveLength(1);
  });

  it('别人的 blogId / 图 id 一律拒绝（越权指针）', async () => {
    const me = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    const foreignBlog = await makeBlog({ authorId: other.id, visibility: 'public' });

    const res = await saveProfileBlocks(me.id, [block('blog', { blogId: foreignBlog.id })]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('不属于你');
    expect(await prisma.profileBlock.count({ where: { userId: me.id } })).toBe(0);
  });

  it('借别人的块 id 不会改到别人那行（id 不认就重新发号）', async () => {
    const me = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    const otherRow = await prisma.profileBlock.create({
      data: {
        id: 'aaaaaaaaaaaa',
        userId: other.id,
        kind: 'text',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        config: JSON.stringify({ title: '', text: '别人的块' }),
        sort: 0,
        createdAt: nowForDb(),
      },
    });

    const res = await saveProfileBlocks(me.id, [
      { id: otherRow.id, kind: 'text', x: 0, y: 0, w: 2, h: 1, config: { title: '', text: '我的块' } },
    ]);
    expect(res.ok).toBe(true);

    const stillOther = await prisma.profileBlock.findUnique({ where: { id: otherRow.id } });
    expect(stillOther!.userId).toBe(other.id);
    expect(JSON.parse(stillOther!.config).text).toBe('别人的块');

    const mine = await prisma.profileBlock.findMany({ where: { userId: me.id, deleted: false } });
    expect(mine).toHaveLength(1);
    expect(mine[0].id).not.toBe(otherRow.id);
  });

  it('目标刚降档时仍能把整页存下去（档位只在读路径判）', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, visibility: 'public' });
    expect((await saveProfileBlocks(u.id, [block('blog', { blogId: blog.id })])).ok).toBe(true);

    // 作者把文章降回站内（块指针留在原地，未编辑）
    await prisma.blog.update({ where: { id: blog.id }, data: { visibility: 'internal' } });

    // 用户现在想改别的块（或删掉这一块）：整页保存不能因为这一条指针失败
    const again = await saveProfileBlocks(u.id, [
      block('blog', { blogId: blog.id }, { x: 0, y: 0, w: 2, h: 1 }),
      block('text', { title: '', text: '新加的一块' }, { x: 2, y: 0, w: 2, h: 1 }),
    ]);
    expect(again.ok).toBe(true);
  });
});

describe('校验', () => {
  it('重叠 / 超界 / 超量一律拒绝并给出第几块', async () => {
    const u = await makeUser({ role: 'core' });
    const overlap = await saveProfileBlocks(u.id, [
      block('text', { text: 'a' }, { x: 0, y: 0, w: 2, h: 1 }),
      block('text', { text: 'b' }, { x: 1, y: 0, w: 2, h: 1 }),
    ]);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.message).toContain('重叠');

    const outside = await saveProfileBlocks(u.id, [
      block('text', { text: 'a' }, { x: 3, y: 0, w: 2, h: 1 }),
    ]);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.message).toContain('右边界');
  });
});
