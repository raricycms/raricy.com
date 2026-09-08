// 聊天 SSE —— 推送与断线补齐（chat-service 的 sendMessage / listMessagesSince）
//
// 【为什么测这些】
//   1. 推送投递对象：大区广播所有在线、私聊推全体成员（含发送者自己的其他标签页）。
//      推错人 = 私聊内容泄露；漏推 = 消息「丢了」（客户端要等下一次对账才看到）。
//   2. 专注模式：大区广播必须跳过开启者 —— 这是服务端访问控制的一部分，不是 UI 偏好。
//   3. 断线补齐 listMessagesSince：Last-Event-ID 之后的消息要跨频道取回，且只能取
//      该用户可见的频道（越权补齐 = 私聊泄露）。
//   4. 推送失败不能影响消息本身（对齐通知的容错口径）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { __resetChatBus, subscribe, type ChatSubscriber } from '@/lib/chat-bus';
import {
  CHAT_LOBBY_ID,
  startDirectChannel,
  sendMessage,
  listMessagesSince,
  markChannelRead,
} from '@/lib/chat-service';
import type { ChatStreamEvent } from '@/lib/chat-shared';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  __resetChatBus();
});

/** 假订阅者：收集推送帧，便于断言「谁收到了」。 */
function watch(userId: string, focusMode = false) {
  const chunks: string[] = [];
  const sub: ChatSubscriber = {
    userId,
    focusMode,
    write: (c) => {
      chunks.push(c);
      return true;
    },
    close: () => {},
  };
  subscribe(sub);
  const events = (): ChatStreamEvent[] =>
    chunks
      .filter((c) => c.startsWith('id:') || c.startsWith('data:'))
      .map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6).trim()) as ChatStreamEvent);
  return { chunks, events };
}

describe('SSE 推送：大区广播', () => {
  it('大区消息推给所有在线连接', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const wa = watch(a.id);
    const wb = watch(b.id);

    const res = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '大家好' });
    expect(res.ok).toBe(true);

    expect(wa.events()).toHaveLength(1);
    expect(wb.events()).toHaveLength(1);
    const ev = wb.events()[0];
    expect(ev.type).toBe('message');
    if (ev.type === 'message') {
      expect(ev.channel_id).toBe(CHAT_LOBBY_ID);
      expect(ev.message.content).toBe('大家好');
      expect(ev.message.author.id).toBe(a.id);
    }
  });

  it('专注模式连接收不到大区推送（服务端访问控制，不只是 UI 隐藏）', async () => {
    const a = await makeUser({ role: 'core' });
    const focused = await makeUser({ role: 'core' });
    const wa = watch(a.id);
    const wf = watch(focused.id, true);

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '大区消息' });

    expect(wa.chunks).toHaveLength(1);
    expect(wf.chunks).toHaveLength(0);
  });

  it('推送帧带 id: 行（浏览器 Last-Event-ID 断线补齐的依据）', async () => {
    const a = await makeUser({ role: 'core' });
    const wa = watch(a.id);
    const res = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'x' });
    if (!res.ok) throw new Error('send failed');

    expect(wa.chunks[0].startsWith(`id: ${res.message.id}\n`)).toBe(true);
  });
});

describe('SSE 推送：私聊', () => {
  it('推给双方（含发送者自己 → 多标签页同步）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const wa = watch(a.id);
    const wb = watch(b.id);

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '私聊内容' });

    expect(wa.events()).toHaveLength(1);
    expect(wb.events()).toHaveLength(1);
  });

  it('不推给无关用户（私聊内容不泄露）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const outsider = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const wo = watch(outsider.id);

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: '只有两人能看到' });

    expect(wo.chunks).toHaveLength(0);
  });

  it('私聊推送不受专注模式影响', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const wb = watch(b.id, true);

    await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'hi' });

    expect(wb.events()).toHaveLength(1);
  });
});

describe('断线补齐 listMessagesSince', () => {
  it('按 id 跨频道取回游标之后的消息（大区 + 私聊一个游标覆盖）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, content: '大区1' });
    const before = await listMessagesSince(a.id, 0);
    const cursor = before.messages[before.messages.length - 1].id;

    await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, content: '大区2' });
    await sendMessage({ channelId: ch.channel.id, authorId: b.id, content: '私聊1' });

    const { messages, more } = await listMessagesSince(a.id, cursor);
    expect(more).toBe(false);
    expect(messages.map((m) => m.content)).toEqual(['大区2', '私聊1']);
    expect(messages.map((m) => m.channel_id)).toEqual([CHAT_LOBBY_ID, ch.channel.id]);
  });

  it('只补齐该用户可见的频道（不越权拿别人的私聊）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const c = await makeUser({ role: 'core' });
    const bc = (await startDirectChannel(b.id, c.id)) as { channel: { id: string } };

    await sendMessage({ channelId: bc.channel.id, authorId: b.id, content: 'b 和 c 的悄悄话' });

    const { messages } = await listMessagesSince(a.id, 0);
    expect(messages).toHaveLength(0);
  });

  it('积压超过窗口 → more=true（调用方据此发 resync 让客户端整页重拉）', async () => {
    const a = await makeUser({ role: 'core' });
    for (let i = 0; i < 3; i++) {
      await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: `m${i}` });
    }

    const { messages, more } = await listMessagesSince(a.id, 0, 2);
    expect(messages).toHaveLength(2);
    expect(more).toBe(true);
  });

  it('软删消息也会补齐（客户端渲染删除占位，避免「凭空少一条」）', async () => {
    const a = await makeUser({ role: 'core' });
    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: '将被删' });
    if (!sent.ok) throw new Error('send failed');
    const { softDeleteMessage } = await import('@/lib/chat-service');
    await softDeleteMessage(sent.message.id, { id: a.id, role: 'core' });

    const { messages } = await listMessagesSince(a.id, sent.message.id - 1);
    expect(messages).toHaveLength(1);
    expect(messages[0].is_deleted).toBe(true);
  });
});

describe('已读回执（C7）', () => {
  it('markChannelRead 给私聊对方推 read 事件', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const ch = (await startDirectChannel(a.id, b.id)) as { channel: { id: string } };
    const sent = await sendMessage({ channelId: ch.channel.id, authorId: a.id, content: 'hi' });
    if (!sent.ok) throw new Error('send failed');

    const wa = watch(a.id);
    const wb = watch(b.id);
    await markChannelRead(ch.channel.id, b.id, sent.message.id);

    // 回执推给「对方」（消息发送者 a），不是读者自己
    const evs = wa.events().filter((e) => e.type === 'read');
    expect(evs).toHaveLength(1);
    const ev = evs[0];
    if (ev.type === 'read') {
      expect(ev.message_id).toBe(sent.message.id);
      expect(ev.user_id).toBe(b.id);
      expect(ev.channel_id).toBe(ch.channel.id);
    }
    expect(wb.events().filter((e) => e.type === 'read')).toHaveLength(0);
  });

  it('大区已读不推回执（人多且无意义）', async () => {
    const a = await makeUser({ role: 'core' });
    const sent = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: a.id, content: 'x' });
    if (!sent.ok) throw new Error('send failed');
    const wa = watch(a.id);
    await markChannelRead(CHAT_LOBBY_ID, a.id, sent.message.id);
    expect(wa.events().filter((e) => e.type === 'read')).toHaveLength(0);
  });
});
