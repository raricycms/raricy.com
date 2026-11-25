// GET /api/chat/stream —— 生成事件帧格式与客户端忽略规则（计划 §7 / §10「断线与终态」）
//
// 【为什么测这个】生成快照 / 终态是搭现有讨论流旁路传输的「无游标事件」：
//   1. 它们绝不能写出 `id:` 行 —— 浏览器会把 id 记成 Last-Event-ID 去补齐正式消息，
//      生成帧混进去等于污染游标（空 id 还会按规范重置游标）；
//   2. 正式 message 仍带 id、仍可携带 generation_id 供客户端交接；
//   3. 客户端收到终态后，即使再出现迟到快照也不能复活预览（墓碑判据）。
//      服务端「终态后不再发快照」由 D 的 generations 用例负责，这里只验帧与客户端规则。
//
// 本文件打真实 route handler（不 mock Prisma），只 mock 登录态；帧由 chat-bus 直接
// 发布，不依赖生成服务，避免把 D 的生命周期逻辑耦合进传输层用例。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb, makeUser } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { __resetChatBus, publishToUsers } from '@/lib/chat-bus';
import { GET } from '@/app/api/chat/stream/route';
import {
  EMPTY_CHAT_GENERATION_STATE,
  applyChatGenerationEvent,
  type ChatGenerationState,
} from '@/lib/chat-generation-reducer';
import type { ChatAuthorDTO, ChatStreamEvent } from '@/lib/chat-shared';

const AUTHOR: ChatAuthorDTO = {
  id: 'u-bot',
  username: '机器人',
  avatar_url: '/static/avatars/u-bot.png',
  frame_url: null,
  bubble_key: null,
  is_admin: false,
};

const snapshotEvent = (revision: number, source = '第一段'): ChatStreamEvent => ({
  type: 'generation_snapshot',
  generation_id: 'gen-1',
  channel_id: 'ch-1',
  revision,
  author: AUTHOR,
  source,
});

const terminalEvent = (revision: number): ChatStreamEvent => ({
  type: 'generation_terminal',
  generation_id: 'gen-1',
  channel_id: 'ch-1',
  revision,
  status: 'completed',
  message_id: 42,
});

describe('GET /api/chat/stream：生成事件帧与正式消息游标', () => {
  const openStreams: Array<() => void> = [];

  beforeEach(async () => {
    await resetDb();
    __resetChatBus();
    session.token = undefined;
  });

  afterEach(() => {
    while (openStreams.length) openStreams.pop()!();
    __resetChatBus();
  });

  /** 打开讨论流并后台收集「带 data: 的帧」；同时跟踪浏览器会记下的 Last-Event-ID。 */
  async function open(userId: string) {
    session.token = await createSessionToken({ uid: userId, sv: 0 });
    const res = await GET(new Request('http://localhost/api/chat/stream'));
    expect(res.status).toBe(200);

    const frames: Array<{ raw: string; id: number | null; event: ChatStreamEvent | null }> = [];
    const cursor = { value: null as number | null };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    const done = (async () => {
      try {
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const lines = raw.split('\n');
            const idLine = lines.find((l) => l.startsWith('id: '));
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (!dataLine) continue; // retry / connected / ping 注释帧
            const id = idLine ? Number(idLine.slice(4)) : null;
            // 浏览器的 Last-Event-ID 只由 id: 行推进；生成帧不得改动它。
            if (id != null) cursor.value = id;
            frames.push({
              raw,
              id,
              event: JSON.parse(dataLine.slice(6)) as ChatStreamEvent,
            });
          }
        }
      } catch {
        /* 被 cancel 掉了 */
      } finally {
        finished = true;
      }
    })();
    openStreams.push(() => {
      void reader.cancel().catch(() => {});
      void done;
    });
    return {
      frames,
      cursor,
      isFinished: () => finished,
    };
  }

  async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return cond();
  }

  it('生成快照 / 终态不带 id:，正式 message 仍带 id: 且不改写 Last-Event-ID 游标', async () => {
    const me = await makeUser({ role: 'core' });
    const p = await open(me.id);

    // 正式消息（带可选 generation_id）先到，作为游标 anchor = 7
    publishToUsers(
      [me.id],
      {
        type: 'message',
        channel_id: 'ch-1',
        message: { id: 7 } as never,
        generation_id: 'gen-1',
      },
      7
    );
    // 生成帧必须由发布方不传 id；bus 不额外生成 id 行
    publishToUsers([me.id], snapshotEvent(1));
    publishToUsers([me.id], terminalEvent(2));

    expect(await waitFor(() => p.frames.length >= 3), '三帧都应到达').toBe(true);

    const [messageFrame, snapshotFrame, terminalFrame] = p.frames;

    expect(messageFrame.id).toBe(7);
    expect(messageFrame.raw.startsWith('id: 7\ndata: '), '正式消息帧保留 id: 行').toBe(true);
    expect(messageFrame.event).toMatchObject({
      type: 'message',
      generation_id: 'gen-1',
    });

    for (const frame of [snapshotFrame, terminalFrame]) {
      expect(frame.id, '生成事件不能写 SSE id（会污染断线补齐游标）').toBeNull();
      expect(frame.raw.startsWith('id: '), `不应有 id: 行：${frame.raw}`).toBe(false);
    }
    expect(snapshotFrame.raw).toContain('"type":"generation_snapshot"');
    expect(terminalFrame.raw).toContain('"type":"generation_terminal"');

    // 浏览器会记下的 Last-Event-ID 仍停在最后一条正式消息（7），没被生成帧推进/重置
    expect(p.cursor.value).toBe(7);
  });

  it('客户端按帧折叠：终态移除预览并通知补拉，此后的迟到快照被墓碑拒绝', async () => {
    const me = await makeUser({ role: 'core' });
    const p = await open(me.id);

    publishToUsers([me.id], snapshotEvent(1));
    publishToUsers([me.id], terminalEvent(2));
    // 模拟一个违反「终态后不再发快照」的发布方：客户端仍必须忽略
    publishToUsers([me.id], snapshotEvent(3, '迟到正文'));

    expect(await waitFor(() => p.frames.length >= 3), '三帧都应到达').toBe(true);

    let state: ChatGenerationState = EMPTY_CHAT_GENERATION_STATE;
    const accepted: boolean[] = [];
    const notices: Array<{ channelId: string; messageId: number }> = [];
    for (const frame of p.frames) {
      const result = applyChatGenerationEvent(state, frame.event, 0);
      state = result.state;
      accepted.push(result.accepted);
      if (result.completed) notices.push(result.completed);
    }

    expect(accepted, '快照接受、终态接受、迟到快照拒绝').toEqual([true, true, false]);
    expect(notices).toEqual([{ channelId: 'ch-1', messageId: 42 }]);
    expect(state.previews, '终态后预览必须为空').toEqual([]);
    expect(state.tombstones).toHaveLength(1);
    expect(state.tombstones[0]).toMatchObject({
      generationId: 'gen-1',
      channelId: 'ch-1',
      status: 'completed',
      messageId: 42,
    });
  });
});