// chat-prefs.test.ts —— 聊天偏好：静音 / 隐藏会话 / 聊天通知开关 / @ 提醒
//
// 【为什么测这些】四条都是「静默失效」型逻辑：写错了不会报错，只会让用户
// 「明明关了通知还在响」或者「明明隐藏了会话又冒出来」。
//   · 静音只影响通知，不能顺手把未读徽标也吞了（静音 ≠ 已读）；
//   · notifyChat 是账号级开关，必须拦住所有聊天通知（私聊 + @）；
//   · 隐藏会话记的是「当时最大消息 id」，新消息（id 更大）要让它重新出现；
//   · @ 的口径必须与前端高亮一致（`@bob` 不能命中 `@bobby`）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import {
  CHAT_LOBBY_ID,
  extractMentions,
  listChannelsForUser,
  setChannelMuted,
  hideChannel,
  startDirectChannel,
  sendMessage,
} from '@/lib/chat-service';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
});

async function notificationCount(recipientId: string): Promise<number> {
  return prisma.notification.count({ where: { recipientId, objectType: 'chat' } });
}

describe('extractMentions（与前端 isMentioned 同口径）', () => {
  it('@名字 后跟空白或行尾才算；前缀相同不误伤', () => {
    expect(extractMentions('@bob 你好')).toEqual(['bob']);
    expect(extractMentions('你好 @bob')).toEqual(['bob']);
    expect(extractMentions('@bobby 你好')).toEqual(['bobby']);
    expect(extractMentions('@bob，你好')).toEqual([]); // 中文逗号不是边界（与前端一致）
    expect(extractMentions('邮箱 a@bob 不是提及')).toEqual(['bob']); // 用户名规则限制，这里只验证行为
  });

  it('多个 @ 去重', () => {
    expect(extractMentions('@a @b @a').sort()).toEqual(['a', 'b']);
  });
});

describe('静音会话（D2）', () => {
  it('静音后不再产生通知；取消静音恢复', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '第一条' });
    expect(await notificationCount(b.id)).toBe(1);

    // 清掉未读通知，便于观察下一条
    await prisma.notification.deleteMany({ where: { recipientId: b.id } });
    await setChannelMuted(ch.channel.id, b.id, true);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '静音中' });
    expect(await notificationCount(b.id)).toBe(0);

    await setChannelMuted(ch.channel.id, b.id, false);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '取消静音后' });
    expect(await notificationCount(b.id)).toBe(1);
  });

  it('静音不影响未读徽标（静音 ≠ 已读）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await setChannelMuted(ch.channel.id, b.id, true);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'x' });

    const list = await listChannelsForUser(b.id);
    const row = list.find((c) => c.id === ch.channel.id);
    expect(row?.unread_count).toBe(1);
    expect(row?.muted).toBe(true);
  });

  it('大区也能静音（不建出错误的读游标基线）', async () => {
    const a = await makeUser({ role: 'core' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '历史消息' });

    const res = await setChannelMuted(CHAT_LOBBY_ID, a.id, true);
    expect(res.ok).toBe(true);
    // 懒建基线 = 当时最大 id → 历史不算未读
    const list = await listChannelsForUser(a.id);
    expect(list.find((c) => c.id === CHAT_LOBBY_ID)?.unread_count).toBe(0);
    expect(list.find((c) => c.id === CHAT_LOBBY_ID)?.muted).toBe(true);
  });
});

describe('聊天通知总开关（D3）', () => {
  it('关掉 notifyChat 后私聊与 @ 通知都不发', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'quiet_user' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await prisma.user.update({ where: { id: b.id }, data: { notifyChat: false } });

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '私聊' });
    await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '@quiet_user 大区喊你',
    });

    expect(await notificationCount(b.id)).toBe(0);
  });

  it('开关缺省（null）视为开启', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await prisma.user.update({ where: { id: b.id }, data: { notifyChat: null } });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'x' });
    expect(await notificationCount(b.id)).toBe(1);
  });
});

describe('隐藏会话（D4）', () => {
  it('隐藏后不在侧栏；对方再发消息会重新出现', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '旧消息' });

    expect(await hideChannel(ch.channel.id, b.id)).toEqual({ ok: true });
    let list = await listChannelsForUser(b.id);
    expect(list.some((c) => c.id === ch.channel.id)).toBe(false);
    // 对方（a）不受影响
    expect((await listChannelsForUser(a.id)).some((c) => c.id === ch.channel.id)).toBe(true);

    // 新消息 → id 比隐藏时的最大 id 大 → 重新出现
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '新消息' });
    list = await listChannelsForUser(b.id);
    const row = list.find((c) => c.id === ch.channel.id);
    expect(row).toBeTruthy();
    expect(row?.unread_count).toBe(2);
  });

  it('大区不能被隐藏', async () => {
    const a = await makeUser({ role: 'core' });
    expect((await hideChannel(CHAT_LOBBY_ID, a.id)).ok).toBe(false);
  });

  it('非成员不能隐藏别人的私聊', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const outsider = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    expect((await hideChannel(ch.channel.id, outsider.id)).ok).toBe(false);
  });
});

describe('@ 提醒（D5）', () => {
  it('大区 @ 到的人收到「聊天提到你」通知（同频道合并为一条）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'alice_target' });

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '@alice_target 在吗' });
    const rows = await prisma.notification.findMany({ where: { recipientId: b.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('聊天提到你');
    expect(rows[0].detail).toContain('@了你');

    // 同一频道再 @ 一次 → 仍是同一条（会话合并）
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '@alice_target 再问一次' });
    expect(await notificationCount(b.id)).toBe(1);
  });

  it('@ 自己不发通知；@ 不存在的用户名不发', async () => {
    const a = await makeUser({ role: 'core', username: 'self_mention' });
    await sendMessage({
      channelId: CHAT_LOBBY_ID,
      authorId: a.id,
      content: '@self_mention @nobody_here 你好',
    });
    expect(await notificationCount(a.id)).toBe(0);
  });

  it('@ 非 core+ 用户不发（他们进不了聊天）', async () => {
    const a = await makeUser({ role: 'core' });
    const plain = await makeUser({ role: 'user', username: 'plain_user' });
    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '@plain_user 你好' });
    expect(await notificationCount(plain.id)).toBe(0);
  });

  it('私聊里 @ 不触发（只有两个人）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core', username: 'dm_target' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await sendMessage({
      channelId: ch.channel.id,
      authorId: a.id,
      content: '@dm_target 你好',
    });
    // 只有一条私聊消息通知，没有额外的「聊天提到你」
    const rows = await prisma.notification.findMany({ where: { recipientId: b.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('私聊消息');
  });
});

describe('迁移列的可空性（D1）', () => {
  it('新建的成员行默认 muted_at / hidden_after_message_id 为空', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const row = await prisma.chatMember.findUnique({
      where: { uq_chat_member_channel_user: { channelId: ch.channel.id, userId: a.id } },
      select: { mutedAt: true, hiddenAfterMessageId: true, createdAt: true },
    });
    expect(row?.mutedAt ?? null).toBeNull();
    expect(row?.hiddenAfterMessageId ?? null).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(nowForDb()).toBeInstanceOf(Date);
  });
});

describe('隐藏后再发起私聊（复用路径不能被隐藏过滤掉）', () => {
  it('发起者隐藏过 → 再次发起应拿到有效 DTO 且会话回到列表', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const first = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    await sendMessage({ channelId: first.channel.id, authorId: a.id, content: 'x' });
    await hideChannel(first.channel.id, a.id);
    expect((await listChannelsForUser(a.id)).some((c) => c.id === first.channel.id)).toBe(false);

    const again = await startDirectChannel(a.id, b.id);
    expect(again.ok).toBe(true);
    const ch = (again as { channel: { id: string; title: string } | null }).channel;
    expect(ch).not.toBeNull();
    expect(ch?.id).toBe(first.channel.id);
    expect((await listChannelsForUser(a.id)).some((c) => c.id === first.channel.id)).toBe(true);
  });
});

describe('空会话不进对方侧栏（1.6）', () => {
  it('发起方能看到空会话，对方看不到；发出第一条消息后对方才看到', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });

    const created = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const id = created.channel.id;

    // 发起方：POST 的响应里必须带有效 DTO（不然前端没法开始打字）。
    // 注意：这只在「显式发起」这条路径上放行（includeEmptyChannelId），
    // 刷新后空会话对双方都不显示 —— 与微信一致（没说过话的会话不算会话）。
    expect(created.channel).toBeTruthy();
    expect((await listChannelsForUser(a.id)).some((c) => c.id === id)).toBe(false);
    // 对方：不该凭空多出一行「开始对话」
    expect((await listChannelsForUser(b.id)).some((c) => c.id === id)).toBe(false);

    await sendMessage({ channelId: id, authorId: a.id, content: 'hi' });
    expect((await listChannelsForUser(b.id)).some((c) => c.id === id)).toBe(true);
  });
});
