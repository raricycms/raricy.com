// chat-prefs.test.ts —— 聊天偏好：静音 / 隐藏会话 / @ 口径
//
// 【为什么测这些】三条都是「静默失效」型逻辑：写错了不会报错，只会让用户
// 「明明静音了铃铛还响」或者「明明隐藏了会话又冒出来」。
//   · 静音只影响顶栏徽标，不能顺手把侧栏未读徽标也吞了（静音 ≠ 已读）；
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
  getChatUnreadSummary,
} from '@/lib/chat-service';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
});

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
  it('静音后不计入顶栏徽标；取消静音后重新计入（未读本身没丢）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '第一条' });
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 1, dot: false });

    await setChannelMuted(ch.channel.id, b.id, true);
    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '静音中' });
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 0, dot: false });

    // 取消静音：静音期间的未读仍在（静音 ≠ 已读），只是刚才没上徽标
    await setChannelMuted(ch.channel.id, b.id, false);
    expect(await getChatUnreadSummary(b.id)).toEqual({ count: 2, dot: false });
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
