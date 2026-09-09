// chat-service.ts —— 在线聊天区业务逻辑
//
// 【为什么测这些】聊天区是「自增游标 + 懒建成员 + 软删除 + 越权隔离 + 未读汇总」
// 的组合模块，任何一条写错都不会报错，只会静默漏数据 / 放错人：
//   1. 大区懒建成员基线 = 当时最大消息 id —— 算错会让从未进过聊天室的用户看到全量未读，
//      或让新用户把历史当未读。
//   2. 私聊频道「成员制」：非成员拉消息/发消息必须被拒（越权隔离是私聊的第一道墙）。
//   3. 图片归属校验：只能发「自己上传且未软删」的图（图床是站内资源，防止引用他人私有文件）。
//   4. 引用回复必须同频道且存活；软删后引用/正文都要给出占位，不能露原始内容。
//   5. 聊天未读不进通知列表：私聊计条数、大区只在被 @ 时亮红点（顶栏徽标口径）。
//   6. 软删除权限：本人随意删；管理员删他人必须带原因并落审计（申诉数据源）。
//   7. 限频仿评论：资源校验通过才扣额度。
//
// 跑真实 SQLite（tests/.tmp/test.db），不 mock Prisma —— 唯一约束/外键/计数正是要验的。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import {
  CHAT_LOBBY_ID,
  CHAT_DELETED_TEXT,
  PAT_TARGET_FALLBACK,
  listChannelsForUser,
  ensureLobbyMembership,
  startDirectChannel,
  listMessages,
  sendMessage,
  markChannelRead,
  canAccessChannel,
  softDeleteMessage,
  searchCoreUsers,
  getChatUnreadSummary,
  setChannelMuted,
  hideChannel,
} from '@/lib/chat-service';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
});

async function makeImage(authorId: string, opts: { ignore?: boolean } = {}) {
  return prisma.imageHosting.create({
    data: {
      id: crypto.randomUUID().slice(0, 10),
      filename: 'chat-test.png',
      fileSize: 1234,
      mimeType: 'image/png',
      authorId,
      createdAt: nowForDb(),
      isPublic: true,
      ignore: opts.ignore ?? false,
    },
  });
}

/** 造一篇可被引用的博客（blogs + blog_contents 各一行）。 */
async function makeBlog(authorId: string, opts: { ignore?: boolean; title?: string } = {}) {
  const id = crypto.randomUUID();
  const now = nowForDb();
  await prisma.blog.create({
    data: {
      id,
      title: opts.title ?? '被引用的博客',
      authorId,
      createdAt: now,
      ignore: opts.ignore ?? false,
    },
  });
  await prisma.blogContent.create({
    data: { blogId: id, content: '测试正文', updatedAt: now },
  });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 大区：懒建成员基线 + 未读数
// ─────────────────────────────────────────────────────────────────────────────

describe('聊天大区：懒建成员基线', () => {
  it('列表会幂等建大区频道与成员行，基线为当前最大消息 id', async () => {
    const a = await makeUser({ role: 'core' });
    const channels = await listChannelsForUser(a.id);
    expect(channels.some((c) => c.id === CHAT_LOBBY_ID && c.kind === 'lobby')).toBe(true);
    const members = await prisma.chatMember.count({ where: { userId: a.id } });
    expect(members).toBe(1);
    // 再次列表不重复建
    await listChannelsForUser(a.id);
    expect(await prisma.chatMember.count({ where: { userId: a.id } })).toBe(1);
  });

  it('先有历史消息的用户入队，历史不算未读；原有成员能看到新消息未读', async () => {
    const a = await makeUser({ role: 'core' });
    // A 先进聊天室（基线 0），此时还没有消息
    await listChannelsForUser(a.id);

    for (let i = 0; i < 3; i++) {
      const res = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: `msg${i}` });
      expect(res.ok).toBe(true);
    }

    // B 现在才第一次进聊天室：基线 = 最大消息 id（3），历史不显示未读
    const b = await makeUser({ role: 'core' });
    const bChannels = await listChannelsForUser(b.id);
    expect(bChannels.find((c) => c.id === CHAT_LOBBY_ID)?.unread_count).toBe(0);

    // A 的基线是 0 → 3 条全算未读
    const aChannels = await listChannelsForUser(a.id);
    expect(aChannels.find((c) => c.id === CHAT_LOBBY_ID)?.unread_count).toBe(3);
  });

  it('已读推进后未读数归零；再发消息重新累计', async () => {
    const a = await makeUser({ role: 'core' });
    await listChannelsForUser(a.id);
    const r1 = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'hi' });
    expect(r1.ok).toBe(true);
    await markChannelRead(CHAT_LOBBY_ID, a.id, (r1 as { message: { id: number } }).message.id);
    expect((await listChannelsForUser(a.id)).find((c) => c.id === CHAT_LOBBY_ID)?.unread_count).toBe(0);
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'hi2' });
    expect((await listChannelsForUser(a.id)).find((c) => c.id === CHAT_LOBBY_ID)?.unread_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.5 大区：@ 红点口径（mention_count）
//    【为什么单列】大区是公共频道，未读提示只认「有人 @ 我」——普通新消息不打扰。
//    判定分两段：SQL LIKE 预筛（超集：大小写不敏感、用户名里的 _ 是通配符）+
//    extractMentions 精确过滤（负责边界：@bob 不能吃掉 @bobby）。两段任何一段写错
//    都不会报错，只会「该亮的红点不亮 / 不该亮的一直亮」，所以逐条钉死。
// ─────────────────────────────────────────────────────────────────────────────

describe('聊天大区：@ 红点口径（mention_count）', () => {
  const ME = 'chat_mention_me';

  const lobbyOf = async (userId: string) =>
    (await listChannelsForUser(userId)).find((c) => c.id === CHAT_LOBBY_ID);

  it('普通消息不计；@ 到我才算（未读总数口径不变）', async () => {
    const me = await makeUser({ role: 'core', username: ME });
    const other = await makeUser({ role: 'core', username: 'chat_mention_other' });
    await listChannelsForUser(me.id); // 先建基线 0，后续消息才都算未读

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: '普通消息' });
    let lobby = await lobbyOf(me.id);
    expect(lobby?.unread_count).toBe(1);
    expect(lobby?.mention_count).toBe(0);

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: `@${ME} 在吗` });
    lobby = await lobbyOf(me.id);
    expect(lobby?.unread_count).toBe(2); // 未读总数照旧统计全部
    expect(lobby?.mention_count).toBe(1); // 红点只看 @
  });

  it('@ 后面必须是空白或行尾（@bobby 不算 @bob）；行尾也认', async () => {
    const me = await makeUser({ role: 'core', username: 'chat_bob' });
    const other = await makeUser({ role: 'core' });
    await listChannelsForUser(me.id);

    // LIKE 预筛会命中（字面含 @chat_bob），精确过滤必须挡掉
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: '@chat_bobby 你好' });
    expect((await lobbyOf(me.id))?.mention_count).toBe(0);

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: 'hello @chat_bob' });
    expect((await lobbyOf(me.id))?.mention_count).toBe(1);
  });

  it('自己 @ 自己不算（与 @ 通知同一口径）', async () => {
    const me = await makeUser({ role: 'core', username: ME });
    await listChannelsForUser(me.id);
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: me.id, content: `@${ME} 记一下` });
    expect((await lobbyOf(me.id))?.mention_count).toBe(0);
  });

  it('已读推进后归零；再来一条 @ 重新累计', async () => {
    const me = await makeUser({ role: 'core', username: ME });
    const other = await makeUser({ role: 'core' });
    await listChannelsForUser(me.id);
    const r = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: other.id,
      content: `@${ME} 第一次`,
    });
    expect((await lobbyOf(me.id))?.mention_count).toBe(1);

    await markChannelRead(CHAT_LOBBY_ID, me.id, (r as { message: { id: number } }).message.id);
    const after = await lobbyOf(me.id);
    expect(after?.unread_count).toBe(0);
    expect(after?.mention_count).toBe(0);

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: `@${ME} 第二次` });
    expect((await lobbyOf(me.id))?.mention_count).toBe(1);
  });

  it('软删的 @ 消息不再算红点', async () => {
    const me = await makeUser({ role: 'core', username: ME });
    const other = await makeUser({ role: 'core' });
    await listChannelsForUser(me.id);
    const r = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: other.id,
      content: `@${ME} 待删`,
    });
    const msgId = (r as { message: { id: number } }).message.id;
    expect((await lobbyOf(me.id))?.mention_count).toBe(1);

    await softDeleteMessage(msgId, { id: other.id, role: 'core' });
    expect((await lobbyOf(me.id))?.mention_count).toBe(0);
  });

  it('私聊不返回 mention_count（只有大区用得上）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const r = await startDirectChannel(a.id, b.id);
    const cid = (r as { channel: { id: string } }).channel.id;
    await sendMessage({ channelId: cid, authorId: b.id, content: `@${a.username} 在吗` });

    const row = (await listChannelsForUser(a.id)).find((c) => c.id === cid);
    expect(row?.unread_count).toBe(1);
    expect(row?.mention_count).toBeUndefined();
  });

  it('专注模式：大区行连 mention_count 都不给（禁用行不提示）', async () => {
    const me = await makeUser({ role: 'core', username: ME });
    const other = await makeUser({ role: 'core' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: other.id, content: `@${ME} 在吗` });

    const lobby = (await listChannelsForUser(me.id, true)).find((c) => c.id === CHAT_LOBBY_ID);
    expect(lobby?.disabled).toBe(true);
    expect(lobby?.unread_count).toBe(0);
    expect(lobby?.mention_count).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 私聊：频道复用 + 越权隔离
// ─────────────────────────────────────────────────────────────────────────────

describe('私聊：建频道与越权隔离', () => {
  it('同一对用户重复发起复用同一频道，双方互为成员', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const r1 = await startDirectChannel(a.id, b.id);
    expect(r1.ok).toBe(true);
    const id1 = (r1 as { channel: { id: string } }).channel.id;
    const r2 = await startDirectChannel(a.id, b.id);
    expect(r2.ok).toBe(true);
    expect((r2 as { channel: { id: string } }).channel.id).toBe(id1);
    const members = await prisma.chatMember.findMany({ where: { channelId: id1 } });
    expect(members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it('不能和自己私聊；目标不是 core+ 则拒绝', async () => {
    const a = await makeUser({ role: 'core' });
    expect((await startDirectChannel(a.id, a.id)).ok).toBe(false);
    const u = await makeUser({ role: 'user' });
    const r = await startDirectChannel(a.id, u.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('notFound');
  });

  it('非成员拉消息/发消息一律被拒', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const c = await makeUser({ role: 'core' });
    const started = await startDirectChannel(a.id, b.id);
    expect(started.ok).toBe(true);
    const channelId = (started as { channel: { id: string } }).channel.id;

    const list = await listMessages(channelId, c.id);
    expect(list.ok).toBe(false);
    expect((list as { error: string }).error).toBe('forbidden');

    const send = await sendMessage({ channelId, authorId: c.id, content: 'hack' });
    expect(send.ok).toBe(false);
    expect((send as { error: string }).error).toBe('forbidden');
  });

  it('私聊消息列表按 id 升序；增量 after 拉取正常', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const started = await startDirectChannel(a.id, b.id);
    const channelId = (started as { channel: { id: string } }).channel.id;
    for (let i = 0; i < 3; i++) {
      await sendMessage({ channelId, authorId: a.id, content: `m${i}` });
    }
    const list = await listMessages(channelId, b.id);
    expect(list.ok).toBe(true);
    const ids = (list as { messages: { id: number; content: string }[] }).messages.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    const after = await listMessages(channelId, b.id, { after: ids[0] });
    expect((after as { messages: unknown[] }).messages.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 发送校验：内容 / 图片归属 / 引用回复 / 限频
// ─────────────────────────────────────────────────────────────────────────────

describe('发消息校验', () => {
  it('空内容拒绝；超长拒绝', async () => {
    const a = await makeUser({ role: 'core' });
    const empty = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '  ' });
    expect((empty as { error: string }).error).toBe('empty');
    const long = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: 'x'.repeat(1001),
    });
    expect((long as { error: string }).error).toBe('tooLong');
  });

  it('图片必须归发送者所有且未软删', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const imgA = await makeImage(a.id);
    const imgDeleted = await makeImage(a.id, { ignore: true });

    const ok = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, imageId: imgA.id, content: '' });
    expect(ok.ok).toBe(true);

    // 用别人的图
    const steal = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, imageId: imgA.id, content: '' });
    expect((steal as { error: string }).error).toBe('imageInvalid');

    // 用已软删的图
    const deleted = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, imageId: imgDeleted.id, content: '' });
    expect((deleted as { error: string }).error).toBe('imageInvalid');

    // 不存在的图
    const ghost = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, imageId: 'nope12345', content: '' });
    expect((ghost as { error: string }).error).toBe('imageInvalid');
  });

  it('带图消息允许空正文（图注可选），图注超限拒绝', async () => {
    const a = await makeUser({ role: 'core' });
    const img = await makeImage(a.id);
    const ok = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, imageId: img.id, content: '' });
    expect(ok.ok).toBe(true);
    const cap = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      imageId: img.id,
      content: 'y'.repeat(501),
    });
    expect((cap as { error: string }).error).toBe('captionTooLong');
  });

  it('引用回复必须同频道且存活', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const c = await makeUser({ role: 'core' });
    const ch1 = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const ch2 = (await startDirectChannel(a.id, c.id)) as { channel: { id: string } };
    expect(ch1.channel.id).not.toBe(ch2.channel.id);
    const base = await sendMessage({ channelId: ch1.channel.id, authorId: a.id, content: 'base' });
    const baseMsg = (base as { message: { id: number } }).message.id;

    // 跨频道引用
    const cross = await sendMessage({ channelId: ch2.channel.id, authorId: a.id, content: 'x', replyTo: baseMsg });
    expect((cross as { error: string }).error).toBe('replyInvalid');

    // 引用已软删的消息
    const delRes = await softDeleteMessage(baseMsg, { id: a.id, role: 'core' });
    expect(delRes.ok).toBe(true);
    const del = await sendMessage({ channelId: ch1.channel.id, authorId: a.id, content: 'x', replyTo: baseMsg });
    expect((del as { error: string }).error).toBe('replyInvalid');
  });

  it('超过每分钟 30 条限频后第 31 条被拒（资源校验先行）', async () => {
    const a = await makeUser({ role: 'core' });
    for (let i = 0; i < 30; i++) {
      const r = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: `n${i}` });
      expect(r.ok).toBe(true);
    }
    const blocked = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'too much' });
    expect(blocked.ok).toBe(false);
    expect((blocked as { error: string }).error).toBe('rateLimited');

    // 被限频的是发送动作；非法请求（空内容）报的是参数错而非限频 —— 证明资源校验先行
    const invalid = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '  ' });
    expect((invalid as { error: string }).error).toBe('empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 消息引用博客（「引用博客」链接卡）
//    只存 blog_id 不存快照：读时按 Blog 当前行解析 → 博客后来被软删，历史消息要
//    退化为占位（blog_missing），不能露已删内容；发送时对 ignore=1 必须拒。
// ─────────────────────────────────────────────────────────────────────────────

type BlogQuoteMsg = {
  id: number;
  content: string;
  blog: {
    id: string;
    title: string;
    description: string;
    author: string | null;
    updated_at: string | null;
  } | null;
  blog_missing: boolean;
};

describe('消息引用博客', () => {
  it('空正文 + 引用博客可发；blog 读时映射当前行（标题/简介/作者/更新时间）', async () => {
    const a = await makeUser({ role: 'core', username: 'blogger' });
    const b = await makeUser({ role: 'core' });
    const blogId = await makeBlog(a.id);

    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, blogId, content: '   ' });
    expect(sent.ok).toBe(true);
    const m = (sent as { message: BlogQuoteMsg }).message;
    expect(m.blog_missing).toBe(false);
    expect(m.blog?.id).toBe(blogId);
    expect(m.blog?.title).toBe('被引用的博客');
    expect(m.blog?.description).toBe('');
    expect(m.blog?.author).toBe('blogger');
    expect(typeof m.blog?.updated_at).toBe('string');
  });

  it('引用的博客不存在或已软删 → blogInvalid', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });

    const ghost = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: b.id,
      blogId: crypto.randomUUID(),
      content: '',
    });
    expect((ghost as { error: string }).error).toBe('blogInvalid');

    const gone = await makeBlog(a.id, { ignore: true });
    const deleted = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, blogId: gone, content: '' });
    expect((deleted as { error: string }).error).toBe('blogInvalid');
  });

  it('引用消息正文超 500 字 → captionTooLong（博客视同附件）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const blogId = await makeBlog(a.id);
    const cap = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: b.id,
      blogId,
      content: 'y'.repeat(501),
    });
    expect((cap as { error: string }).error).toBe('captionTooLong');
  });

  it('引用的博客之后被软删 → 读回占位 blog_missing（不露已删内容）', async () => {
    const a = await makeUser({ role: 'core' });
    const blogId = await makeBlog(a.id);
    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, blogId, content: '' });
    expect(sent.ok).toBe(true);
    const msgId = (sent as { message: { id: number } }).message.id;

    await prisma.blog.update({ where: { id: blogId }, data: { ignore: true } });

    const list = await listMessages(CHAT_LOBBY_ID, a.id);
    expect(list.ok).toBe(true);
    const msgs = (list as { messages: BlogQuoteMsg[] }).messages;
    const target = msgs.find((x) => x.id === msgId);
    expect(target?.blog).toBeNull();
    expect(target?.blog_missing).toBe(true);
  });
});

describe('拍一拍', () => {
  type PatMsg = {
    id: number;
    content: string;
    image: unknown;
    blog: unknown;
    pat: { target_id: string; target_name: string } | null;
  };

  it('发拍一拍：正文/附件一律清空，只留目标 id；读回解析当前用户名', async () => {
    const a = await makeUser({ role: 'core', username: '拍拍怪' });
    const b = await makeUser({ role: 'core', username: '被拍的人' });
    const blogId = await makeBlog(a.id);

    const sent = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      patTargetId: b.id,
      // 拍一拍忽略这些附件/正文，防止借它绕开内容校验
      content: '正文应被忽略',
      blogId,
    });
    expect(sent.ok).toBe(true);
    const m = (sent as { message: PatMsg }).message;
    expect(m.pat).toEqual({ target_id: b.id, target_name: '被拍的人' });
    expect(m.content).toBe('');
    expect(m.blog).toBeNull();

    const list = await listMessages(CHAT_LOBBY_ID, a.id);
    const back = (list as { messages: PatMsg[] }).messages.find((x) => x.id === m.id);
    expect(back?.pat?.target_name).toBe('被拍的人');
  });

  it('允许拍自己（微信/QQ 同款）', async () => {
    const a = await makeUser({ role: 'core', username: '自拍' });
    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, patTargetId: a.id });
    expect(sent.ok).toBe(true);
    expect((sent as { message: PatMsg }).message.pat).toEqual({
      target_id: a.id,
      target_name: '自拍',
    });
  });

  it('目标用户不存在 → patInvalid', async () => {
    const a = await makeUser({ role: 'core' });
    const res = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      patTargetId: crypto.randomUUID(),
    });
    expect((res as { error: string }).error).toBe('patInvalid');
  });

  it('侧栏预览给「拍了拍 X」，不显示空串', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: '目标' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, patTargetId: b.id });

    const list = await listChannelsForUser(a.id);
    expect(list.find((c) => c.id === CHAT_LOBBY_ID)?.last_message?.content).toBe('拍了拍 目标');
  });

  it('目标用户行缺失 → 读回占位名（不炸、不露空）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, patTargetId: b.id });
    const msgId = (sent as { message: { id: number } }).message.id;

    // 模拟目标行被清理（pat_target_id 无外键 → 消息行仍在）
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE id = ?', b.id);

    const list = await listMessages(CHAT_LOBBY_ID, a.id);
    const back = (list as { messages: PatMsg[] }).messages.find((x) => x.id === msgId);
    expect(back?.pat?.target_name).toBe(PAT_TARGET_FALLBACK);
  });

  it('拍一拍也走限频（不因没有正文而豁免）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    for (let i = 0; i < 30; i++) {
      const r = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, patTargetId: b.id });
      expect(r.ok).toBe(true);
    }
    const over = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, patTargetId: b.id });
    expect((over as { error: string }).error).toBe('rateLimited');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 聊天未读：不进通知列表，统一走顶栏徽标汇总（getChatUnreadSummary）
// ─────────────────────────────────────────────────────────────────────────────

describe('聊天消息不产生站内通知', () => {
  it('私聊连发多条也不产生通知', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const started = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const channelId = started.channel.id;

    for (let i = 1; i <= 3; i++) {
      await sendMessage({ channelId, authorId: a.id, content: `hi ${i}` });
    }

    expect(await prisma.notification.count({ where: { recipientId: b.id } })).toBe(0);
  });

  it('大区 @ 我同样不产生通知', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'lobby_mention' });
    await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '@lobby_mention 在吗',
    });
    expect(await prisma.notification.count({ where: { recipientId: b.id } })).toBe(0);
  });
});

describe('顶栏徽标汇总 getChatUnreadSummary', () => {
  it('私聊未读计入 count；读掉后归零', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    const first = (await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '1',
    })) as { message: { id: number } };
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '2' });

    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 2, dot: false });

    // 只读到第一条 → 还剩一条
    await markChannelRead(ch.channel.id, b.id, first.message.id);
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 1, dot: false });

    // 缺省 = 读到频道最大 id → 清零
    await markChannelRead(ch.channel.id, b.id);
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });
  });

  it('大区普通未读不算，只有 @ 到我才亮红点', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'lobby_dot' });
    // 先进一次大区：懒建成员基线（没有成员行时未读恒为 0，测不出 dot）
    await listChannelsForUser(b.id);

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '普通消息' });
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });

    await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '@lobby_dot 叫你',
    });
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: true });
  });

  it('自己 @ 自己不算（与侧栏同口径：作者排除）', async () => {
    const b = await makeUser({ role: 'core', username: 'self_dot' });
    await listChannelsForUser(b.id);
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, content: '@self_dot 记一下' });
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });
  });

  it('专注模式下大区不计（@ 也不亮）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'focus_dot' });
    await listChannelsForUser(b.id);
    await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '@focus_dot 叫你',
    });

    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: true });
    expect(await getChatUnreadSummary(b.id, true)).toEqual({ count: 0, dot: false });
  });

  it('静音会话不计入徽标，但侧栏未读徽标照常（静音 ≠ 已读）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await setChannelMuted(ch.channel.id, b.id, true);

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'x' });

    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });
    const row = (await listChannelsForUser(b.id)).find((c) => c.id === ch.channel.id);
    expect(row?.unread_count).toBe(1);
  });

  it('隐藏的会话不计；隐藏后又来新消息则重新计入', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '旧消息' });

    await hideChannel(ch.channel.id, b.id);
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });

    // 新消息 id 更大 → 会话重新出现（微信语义），未读也随之重新计入
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '新消息' });
    expect((await getChatUnreadSummary(b.id)).count).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 软删除：本人 / 管理员 + 审计
// ─────────────────────────────────────────────────────────────────────────────

describe('消息软删除', () => {
  it('作者删自己 → 列表显示占位，不暴露原文', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const started = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const channelId = started.channel.id;
    const sent = (await sendMessage({ channelId, authorId: a.id, content: 'secret' })) as {
      message: { id: number };
    };

    const del = await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });
    expect(del.ok).toBe(true);

    const list = (await listMessages(channelId, b.id)) as { messages: { content: string; is_deleted: boolean }[] };
    expect(list.messages[0].content).toBe(CHAT_DELETED_TEXT);
    expect(list.messages[0].is_deleted).toBe(true);
    expect(list.messages[0].content).not.toContain('secret');
  });

  it('非作者非管理员不能删', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const c = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const sent = (await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'x' })) as {
      message: { id: number };
    };
    const r = await softDeleteMessage(sent.message.id, { id: c.id, role: 'core' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('forbidden');
  });

  it('管理员删他人必须带原因并写审计日志；作者删自己不需要', async () => {
    const a = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });
    const ch = (await startDirectChannel(a.id, admin.id)) as { channel: { id: string } };
    const sent = (await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '违规' })) as {
      message: { id: number };
    };

    const noReason = await softDeleteMessage(sent.message.id, { id: admin.id, role: 'admin' });
    expect((noReason as { error: string }).error).toBe('reasonRequired');

    const withReason = await softDeleteMessage(sent.message.id, { id: admin.id, role: 'admin' }, '引战');
    expect(withReason.ok).toBe(true);

    const logs = await prisma.adminActionLog.findMany({
      where: { action: 'delete_chat_message', adminId: admin.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].reason).toBe('引战');
    expect(logs[0].objectId).toBe(String(sent.message.id));
  });

  it('删除已删除的消息报 notFound', async () => {
    const a = await makeUser({ role: 'core' });
    const sent = (await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'x' })) as {
      message: { id: number };
    };
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });
    const again = await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });
    expect((again as { error: string }).error).toBe('notFound');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 用户搜索（发起私聊弹窗）
// ─────────────────────────────────────────────────────────────────────────────

describe('搜索可私聊用户', () => {
  it('只返回 core+，排除自己，支持用户名子串匹配', async () => {
    const me = await makeUser({ role: 'core', username: 'me_user' });
    const c1 = await makeUser({ role: 'core', username: 'alpha' });
    await makeUser({ role: 'admin', username: 'beta' });
    await makeUser({ role: 'user', username: 'gamma' });

    const all = await searchCoreUsers('', me.id);
    expect(all.total).toBe(2); // core+ 且非自己：alpha + beta
    const names = all.users.map((u) => u.username);
    expect(names).not.toContain('me_user');
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('gamma');

    const hit = await searchCoreUsers('al', me.id);
    expect(hit.users.map((u) => u.username)).toEqual(['alpha']);
  });

  it('offset/limit 分页 + total 总数', async () => {
    const me = await makeUser({ role: 'core', username: 'pager_me' });
    for (let i = 0; i < 5; i++) {
      await makeUser({ role: 'core', username: `page_u${i}` });
    }
    const p1 = await searchCoreUsers('', me.id, 2, 0);
    const p2 = await searchCoreUsers('', me.id, 2, 2);
    const p3 = await searchCoreUsers('', me.id, 2, 4);
    expect(p1.total).toBe(5);
    const ids = [...p1.users, ...p2.users, ...p3.users].map((u) => u.id);
    // 三页各 2/2/1 条且无重叠
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('ensureLobbyMembership 在频道缺失时也会兜底建行', async () => {
    const a = await makeUser({ role: 'core' });
    const row = await ensureLobbyMembership(a.id);
    expect(typeof row.lastReadMessageId).toBe('number');
    expect(await prisma.chatChannel.count({ where: { id: CHAT_LOBBY_ID } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 专注模式：大区禁用（focusMode 参数）
//    语义：侧栏大区行保留但 disabled（无预览/未读/不懒建成员基线）；
//    发消息/拉消息对 lobby 一律 forbidden；私聊全程不受影响。
// ─────────────────────────────────────────────────────────────────────────────

describe('专注模式：聊天大区禁用', () => {
  it('listChannelsForUser(focus)：lobby 行 disabled 且无预览无未读，不建成员行', async () => {
    const a = await makeUser({ role: 'core' });
    // 先在大区留一条历史消息（focus 前）
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '历史消息' });

    const channels = await listChannelsForUser(a.id, true);
    const lobby = channels.find((c) => c.id === CHAT_LOBBY_ID);
    expect(lobby?.disabled).toBe(true);
    expect(lobby?.last_message).toBeNull();
    expect(lobby?.unread_count).toBe(0);
    expect(lobby?.title).toBe('聊天大区');
    // 置顶语义保持（_order 已剥掉，直接断言它是第一行）
    expect(channels[0]?.id).toBe(CHAT_LOBBY_ID);
    // focus 期间不得把成员基线建出来（否则关掉 focus 后历史全变未读）
    expect(await prisma.chatMember.count({ where: { userId: a.id } })).toBe(0);

    // 对照：不传 focus 时预览照常
    const plain = await listChannelsForUser(a.id);
    const plainLobby = plain.find((c) => c.id === CHAT_LOBBY_ID);
    expect(plainLobby?.last_message?.content).toBe('历史消息');
  });

  it('focus 用户给 lobby 发消息 → forbidden + 专注文案；私聊照发', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });

    const blocked = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '想在大区发言',
      focusMode: true,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toBe('forbidden');
      expect(blocked.message).toBe('已开启专注模式，无法使用该功能');
    }

    const direct = await startDirectChannel(a.id, b.id);
    expect(direct.ok).toBe(true);
    const did = (direct as { channel: { id: string } }).channel.id;
    const ok = await sendMessage({
      channelId: did,
      authorId: a.id,
      content: '私聊不受影响',
      focusMode: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('focus 用户拉 lobby 消息 → forbidden；markRead 静默 0；direct 不受影响', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '历史' });

    const listRes = await listMessages(CHAT_LOBBY_ID, a.id, {}, true);
    expect(listRes.ok).toBe(false);
    if (!listRes.ok) {
      expect(listRes.error).toBe('forbidden');
      expect(listRes.message).toBe('已开启专注模式，无法使用该功能');
    }

    const read = await markChannelRead(CHAT_LOBBY_ID, a.id, undefined, true);
    expect(read).toBe(0);
    expect(await prisma.chatMember.count({ where: { userId: a.id } })).toBe(0);

    const direct = await startDirectChannel(a.id, b.id);
    const did = (direct as { channel: { id: string } }).channel.id;
    const okList = await listMessages(did, a.id, {}, true);
    expect(okList.ok).toBe(true);
  });

  it('canAccessChannel 单点：focus 对大区 false、对私聊 true', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const lobbyAccess = await canAccessChannel(CHAT_LOBBY_ID, a.id, true);
    expect(lobbyAccess.allowed).toBe(false);
    const lobbyPlain = await canAccessChannel(CHAT_LOBBY_ID, a.id);
    expect(lobbyPlain.allowed).toBe(true);
    const direct = await startDirectChannel(a.id, b.id);
    const did = (direct as { channel: { id: string } }).channel.id;
    const directAccess = await canAccessChannel(did, a.id, true);
    expect(directAccess.allowed).toBe(true);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// 8. 软删的附件必须一并消失（P0：删掉的图/博客卡/回复引用不能再下发）
// ─────────────────────────────────────────────────────────────────────────────

describe('软删消息不返回附件', () => {
  it('带图消息软删后 image / image_missing 均为空', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const img = await makeImage(a.id);
    const sent = (await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '带图',
      imageId: img.id,
    })) as { message: { id: number } };
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });

    const list = (await listMessages(ch.channel.id, b.id)) as {
      messages: { image: unknown; image_missing: boolean; is_deleted: boolean }[];
    };
    expect(list.messages[0].is_deleted).toBe(true);
    expect(list.messages[0].image).toBeNull();
    expect(list.messages[0].image_missing).toBe(false);
  });

  it('引用博客的消息软删后 blog 为空', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const blogId = await makeBlog(a.id);
    const sent = (await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      blogId,
    })) as { message: { id: number } };
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });

    const list = (await listMessages(ch.channel.id, b.id)) as {
      messages: { blog: unknown; blog_missing: boolean }[];
    };
    expect(list.messages[0].blog).toBeNull();
    expect(list.messages[0].blog_missing).toBe(false);
  });

  it('回复消息软删后 reply 为空（不残留引用块）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const base = (await sendMessage({
      channelId: ch.channel.id,
      authorId: b.id,
      content: '原消息',
    })) as { message: { id: number } };
    const sent = (await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '回复',
      replyTo: base.message.id,
    })) as { message: { id: number } };
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });

    const list = (await listMessages(ch.channel.id, b.id)) as {
      messages: { id: number; reply: unknown }[];
    };
    const target = list.messages.find((m) => m.id === sent.message.id);
    expect(target?.reply).toBeNull();
  });

  it('引用图片消息：reply 带缩略图 URL、正文留空（前端渲染「作者：缩略图」）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const img = await makeImage(b.id);
    const base = (await sendMessage({
      channelId: ch.channel.id,
      authorId: b.id,
      imageId: img.id,
      content: '',
    })) as { message: { id: number } };
    await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '这张图不错',
      replyTo: base.message.id,
    });

    const list = (await listMessages(ch.channel.id, b.id)) as {
      messages: { content: string; reply: { content: string; image_url: string | null } | null }[];
    };
    const reply = list.messages.find((m) => m.content === '这张图不错')?.reply;
    expect(reply?.content).toBe('');
    expect(reply?.image_url).toBe(`/api/images/${img.id}/raw`);
  });

  it('引用图片消息：图已软删 → reply 给占位文案而非空白', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const img = await makeImage(b.id);
    const base = (await sendMessage({
      channelId: ch.channel.id,
      authorId: b.id,
      imageId: img.id,
      content: '',
    })) as { message: { id: number } };
    await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '这张图不错',
      replyTo: base.message.id,
    });
    await prisma.imageHosting.update({ where: { id: img.id }, data: { ignore: true } });

    const list = (await listMessages(ch.channel.id, b.id)) as {
      messages: { content: string; reply: { content: string; image_url: string | null } | null }[];
    };
    const reply = list.messages.find((m) => m.content === '这张图不错')?.reply;
    expect(reply?.content).toBe('[图片已删除]');
    expect(reply?.image_url).toBeNull();
  });

  it('拍一拍软删后仍带 pat（前端要渲染居中删除占位行）', async () => {
    const a = await makeUser({ role: 'core' });
    const sent = (await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      patTargetId: a.id,
    })) as { message: { id: number } };
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });

    const list = (await listMessages(CHAT_LOBBY_ID, a.id)) as {
      messages: { id: number; pat: unknown; is_deleted: boolean }[];
    };
    const target = list.messages.find((m) => m.id === sent.message.id);
    expect(target?.is_deleted).toBe(true);
    expect(target?.pat).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 侧栏预览：纯图片消息不能显示空串
// ─────────────────────────────────────────────────────────────────────────────

describe('侧栏预览占位', () => {
  it('纯图片消息（无图注）预览为 [图片]', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const img = await makeImage(a.id);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, imageId: img.id });

    const list = await listChannelsForUser(a.id);
    const row = list.find((c) => c.id === ch.channel.id);
    expect(row?.last_message?.content).toBe('[图片]');
  });

  it('引用博客（无正文）预览为 [博客]', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const blogId = await makeBlog(a.id);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, blogId });

    const list = await listChannelsForUser(a.id);
    const row = list.find((c) => c.id === ch.channel.id);
    expect(row?.last_message?.content).toBe('[博客]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 越权/脏输入的兜底（拍一拍目标、读游标归属、搜索结果字段）
// ─────────────────────────────────────────────────────────────────────────────

describe('拍一拍目标限定本会话成员', () => {
  it('私聊里拍一个与本会话无关的人 → patInvalid', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const outsider = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    const res = await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      patTargetId: outsider.id,
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('patInvalid');
  });

  it('私聊里拍对方 / 拍自己都可以', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    expect((await sendMessage({ channelId: ch.channel.id, authorId: a.id, patTargetId: b.id })).ok).toBe(true);
    expect((await sendMessage({ channelId: ch.channel.id, authorId: a.id, patTargetId: a.id })).ok).toBe(true);
  });

  it('大区里拍非成员仍允许（大区本就无成员限制）', async () => {
    const a = await makeUser({ role: 'core' });
    const stranger = await makeUser({ role: 'core' });
    const res = await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      patTargetId: stranger.id,
    });
    expect(res.ok).toBe(true);
  });
});

describe('读游标只能落在本频道的消息上', () => {
  it('传入别的频道的消息 id → 回落为「本频道当前最大 id」', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    // 大区先有一条（id 小），私聊里再发一条（id 大）
    const lobbyMsg = (await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '大区消息',
    })) as { message: { id: number } };
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '私聊消息' });

    // 给私聊频道传大区的 id：不该把游标推到那个值
    const upTo = await markChannelRead(ch.channel.id, b.id, lobbyMsg.message.id);
    const row = await prisma.chatMember.findUnique({
      where: { uq_chat_member_channel_user: { channelId: ch.channel.id, userId: b.id } },
      select: { lastReadMessageId: true },
    });
    // 回落后应为私聊里的最大 id（大于大区那条，但不是「被传进来的那个」的语义）
    expect(upTo).toBeGreaterThan(0);
    expect(row?.lastReadMessageId).toBe(upTo);
    // 未读归零（私聊里只有那一条，已被本频道最大 id 覆盖）
    const list = await listChannelsForUser(b.id);
    expect(list.find((c) => c.id === ch.channel.id)?.unread_count).toBe(0);
  });
});

describe('用户搜索结果不再暴露角色', () => {
  it('返回项只有 id 与 username', async () => {
    const me = await makeUser({ role: 'core' });
    await makeUser({ role: 'admin', username: 'role_probe' });
    const { users } = await searchCoreUsers('role_probe', me.id);
    expect(users).toHaveLength(1);
    expect(Object.keys(users[0]).sort()).toEqual(['id', 'username']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 频道列表的查询次数（N+1 批量化后应与频道数无关）
// ─────────────────────────────────────────────────────────────────────────────

describe('频道列表查询次数', () => {
  it('10 个私聊频道下仍是常数级调用（旧实现约 46 次）', async () => {
    const me = await makeUser({ role: 'core' });
    for (let i = 0; i < 10; i++) {
      const other = await makeUser({ role: 'core' });
      const ch = (await startDirectChannel(me.id, other.id)) as { channel: { id: string } };
      await sendMessage({ channelId: ch.channel.id, authorId: other.id, content: `hi ${i}` });
    }

    // 给 Prisma 模型方法套一层计数器（只统计模型调用；$queryRaw 在 client 上，另算）
    const tally: Record<string, number> = {};
    const models = ['chatChannel', 'chatMember', 'chatMessage', 'user', 'notification'] as const;
    const restore: (() => void)[] = [];
    for (const m of models) {
      const model = prisma[m] as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const key of Object.keys(model)) {
        const fn = model[key];
        if (typeof fn !== 'function') continue;
        model[key] = (...args: unknown[]) => {
          tally[`${m}.${key}`] = (tally[`${m}.${key}`] ?? 0) + 1;
          return (fn as (...a: unknown[]) => unknown).apply(model, args);
        };
        restore.push(() => {
          model[key] = fn;
        });
      }
    }

    try {
      const list = await listChannelsForUser(me.id);
      expect(list).toHaveLength(11); // 大区 + 10 私聊（顺带验证批量结果没丢）
    } finally {
      restore.forEach((f) => f());
    }

    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(tally)).toBeLessThanOrEqual(8);
    // 逐频道的那两条查询必须彻底消失
    expect(tally['chatMessage.count'] ?? 0).toBe(0);
    expect(tally['chatMessage.findFirst'] ?? 0).toBe(0);
    expect(tally['chatMember.findUnique'] ?? 0).toBe(0);
  });
});

describe('私聊已读回执字段（C7）', () => {
  it('频道 DTO 带 peer_last_read_message_id；大区为 null', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const sent = (await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: 'hi',
    })) as { message: { id: number } };
    await markChannelRead(ch.channel.id, b.id, sent.message.id);

    const aList = await listChannelsForUser(a.id);
    const dm = aList.find((c) => c.id === ch.channel.id);
    expect(dm?.peer_last_read_message_id).toBe(sent.message.id);

    const lobby = aList.find((c) => c.id === CHAT_LOBBY_ID);
    expect(lobby?.peer_last_read_message_id ?? null).toBeNull();
  });
});
