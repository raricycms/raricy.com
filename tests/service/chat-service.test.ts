// chat-service.ts —— 在线聊天区业务逻辑
//
// 【为什么测这些】聊天区是「自增游标 + 懒建成员 + 软删除 + 越权隔离 + 会话合并通知」
// 的组合模块，任何一条写错都不会报错，只会静默漏数据 / 放错人：
//   1. 大区懒建成员基线 = 当时最大消息 id —— 算错会让从未进过聊天室的用户看到全量未读，
//      或让新用户把历史当未读。
//   2. 私聊频道「成员制」：非成员拉消息/发消息必须被拒（越权隔离是私聊的第一道墙）。
//   3. 图片归属校验：只能发「自己上传且未软删」的图（图床是站内资源，防止引用他人私有文件）。
//   4. 引用回复必须同频道且存活；软删后引用/正文都要给出占位，不能露原始内容。
//   5. 私聊通知「会话合并」：连发 N 条只留 1 条未读通知，打开会话后一并清掉。
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
  listChannelsForUser,
  ensureLobbyMembership,
  startDirectChannel,
  listMessages,
  sendMessage,
  markChannelRead,
  softDeleteMessage,
  searchCoreUsers,
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
// 4. 私聊通知：会话合并 + 已读清通知
// ─────────────────────────────────────────────────────────────────────────────

describe('私聊通知（会话合并）', () => {
  it('连发多条只产生一条未读通知，detail 刷新为最新一条', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const started = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const channelId = started.channel.id;

    for (let i = 1; i <= 3; i++) {
      await sendMessage({ channelId, authorId: a.id, content: `hi ${i}` });
    }

    const notifs = await prisma.notification.findMany({
      where: { recipientId: b.id, objectType: 'chat', objectId: channelId },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].read).toBe(false);
    expect(notifs[0].detail).toBe('hi 3');
    expect(notifs[0].action).toBe('私聊消息');
  });

  it('大区消息不产生通知', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'lobby' });
    const count = await prisma.notification.count({ where: { recipientId: b.id } });
    expect(count).toBe(0);
  });

  it('markChannelRead 把该会话的未读通知一并清掉', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const started = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const channelId = started.channel.id;
    const sent = (await sendMessage({ channelId, authorId: a.id, content: 'hi' })) as {
      message: { id: number };
    };

    await markChannelRead(channelId, b.id, sent.message.id);

    const notifs = await prisma.notification.findMany({
      where: { recipientId: b.id, objectType: 'chat', objectId: channelId },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].read).toBe(true);
    const chans = await listChannelsForUser(b.id);
    expect(chans.find((c) => c.id === channelId)?.unread_count).toBe(0);
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
    const names = all.map((u) => u.username);
    expect(names).not.toContain('me_user');
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).not.toContain('gamma');

    const hit = await searchCoreUsers('al', me.id);
    expect(hit.map((u) => u.username)).toEqual(['alpha']);
  });

  it('ensureLobbyMembership 在频道缺失时也会兜底建行', async () => {
    const a = await makeUser({ role: 'core' });
    const row = await ensureLobbyMembership(a.id);
    expect(typeof row.lastReadMessageId).toBe('number');
    expect(await prisma.chatChannel.count({ where: { id: CHAT_LOBBY_ID } })).toBe(1);
  });
});