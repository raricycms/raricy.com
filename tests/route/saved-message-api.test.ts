// 保存箱 API —— route handler 层
//
// 【为什么单独一个文件】这里打真实 route handler，重点不在业务（service 用例已覆盖），
// 而在三条**路由契约**：
//   ① 档位：未登录 401 / 非 core 403（与 /api/chat/* 的 requireChatUser 同一道门）；
//   ② 失败同形：不存在 / 不是成员 / 大区消息一律 400「消息不存在或无权保存」，
//      不确认消息存在性；
//   ③ 幂等：重复保存 / 重复取消都回 200。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 会话由 cookie 决定：单测里没有请求上下文，用可变 holder 模拟「有 / 没有会话」。
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
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { CHAT_LOBBY_ID } from '@/lib/chat-shared';
import { startDirectChannel, sendMessage } from '@/lib/chat-service';
import { POST as saveApi } from '@/app/api/chat/saved/route';
import { DELETE as unsaveApi } from '@/app/api/chat/saved/[messageId]/route';
import { GET as idsApi } from '@/app/api/chat/saved/ids/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

const jsonReq = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

const url = (path: string) => new Request(`http://localhost${path}`);
const ctxMessage = (messageId: string) => ({ params: Promise.resolve({ messageId }) });

/** 造一对 core 用户 + 私聊频道 + 一条消息。 */
async function makeDirectMessage() {
  const a = await makeUser({ role: 'core' });
  const b = await makeUser({ role: 'core' });
  const ch = await startDirectChannel(a.id, b.id);
  if (!ch.ok) throw new Error(`建私聊失败：${ch.error}`);
  const sent = await sendMessage({ channelId: ch.channel.id, authorId: b.id, content: '要保存的话' });
  if (!sent.ok) throw new Error(`发消息失败：${sent.error}`);
  return { a, b, channelId: ch.channel.id, messageId: sent.message.id };
}

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  session.token = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── 档位 ─────────────────────────────────────────────────────────────────────

describe('档位：匿名 401 / 非 core 403', () => {
  it('POST /api/chat/saved', async () => {
    expect((await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId: 1 }))).status).toBe(401);
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId: 1 }))).status).toBe(403);
  });

  it('DELETE /api/chat/saved/:messageId', async () => {
    expect(
      (await unsaveApi(jsonReq('/api/chat/saved/1', 'DELETE'), ctxMessage('1'))).status
    ).toBe(401);
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect(
      (await unsaveApi(jsonReq('/api/chat/saved/1', 'DELETE'), ctxMessage('1'))).status
    ).toBe(403);
  });

  it('GET /api/chat/saved/ids', async () => {
    expect((await idsApi(url('/api/chat/saved/ids?channel=lobby'))).status).toBe(401);
    const plain = await makeUser({ role: 'user' });
    await login(plain.id);
    expect((await idsApi(url('/api/chat/saved/ids?channel=lobby'))).status).toBe(403);
  });
});

// ── 保存 / 取消 ──────────────────────────────────────────────────────────────

describe('保存与取消', () => {
  it('保存成功 → 200 { saved, count }；重复保存仍 200 且 count 不变', async () => {
    const { a, messageId } = await makeDirectMessage();
    await login(a.id);

    const first = await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { saved: boolean; count: number };
    expect(firstBody.saved).toBe(true);
    expect(firstBody.count).toBe(1);

    const again = await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { count: number }).count).toBe(1);
  });

  it('取消成功 → 200；重复取消仍 200（幂等）', async () => {
    const { a, messageId } = await makeDirectMessage();
    await login(a.id);
    await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId }));

    for (let i = 0; i < 2; i++) {
      const res = await unsaveApi(jsonReq(`/api/chat/saved/${messageId}`, 'DELETE'), ctxMessage(String(messageId)));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { saved: boolean; count: number };
      expect(body.saved).toBe(false);
      expect(body.count).toBe(0);
    }
  });

  it('不存在 / 非成员 / 大区消息一律 400 且同一文案（不确认存在性）', async () => {
    const { a, b, channelId } = await makeDirectMessage();
    const outsider = await makeUser({ role: 'core' });
    const lobby = await sendMessage({ channelId: CHAT_LOBBY_ID, authorId: b.id, content: '大区' });
    if (!lobby.ok) throw new Error('发大区消息失败');

    await login(a.id);
    for (const messageId of [999_999_999, lobby.message.id]) {
      const res = await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('消息不存在或无权保存');
    }

    // 非成员：拿别人私聊里的消息 id 也不行（同形文案）
    await login(outsider.id);
    const msg = await sendMessage({ channelId, authorId: b.id, content: '私聊' });
    if (!msg.ok) throw new Error('发私聊消息失败');
    const res = await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId: msg.message.id }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('消息不存在或无权保存');
  });

  it('DELETE 的非法 id → 400', async () => {
    const a = await makeUser({ role: 'core' });
    await login(a.id);
    const res = await unsaveApi(jsonReq('/api/chat/saved/nope', 'DELETE'), ctxMessage('nope'));
    expect(res.status).toBe(400);
  });
});

// ── 已保存 id ────────────────────────────────────────────────────────────────

describe('GET /api/chat/saved/ids', () => {
  it('返回该频道里我保存过的消息 id', async () => {
    const { a, messageId, channelId } = await makeDirectMessage();
    await login(a.id);
    await saveApi(jsonReq('/api/chat/saved', 'POST', { messageId }));

    const res = await idsApi(url(`/api/chat/saved/ids?channel=${channelId}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ids: number[] }).ids).toEqual([messageId]);
  });

  it('大区 → 空数组；非成员 → 403；频道不存在 → 404', async () => {
    const { a, channelId } = await makeDirectMessage();
    const outsider = await makeUser({ role: 'core' });

    await login(a.id);
    const lobby = await idsApi(url(`/api/chat/saved/ids?channel=${CHAT_LOBBY_ID}`));
    expect(lobby.status).toBe(200);
    expect(((await lobby.json()) as { ids: number[] }).ids).toEqual([]);

    await login(outsider.id);
    expect((await idsApi(url(`/api/chat/saved/ids?channel=${channelId}`))).status).toBe(403);
    expect((await idsApi(url('/api/chat/saved/ids?channel=no-such'))).status).toBe(404);
  });

  it('缺频道参数 → 400', async () => {
    const a = await makeUser({ role: 'core' });
    await login(a.id);
    expect((await idsApi(url('/api/chat/saved/ids'))).status).toBe(400);
  });
});
