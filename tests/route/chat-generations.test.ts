// chat-generations.test.ts（route）—— 生成接口的 HTTP 契约
//
// 【为什么单独测路由】服务层已经钉住状态机；这里验的是只有经过 HTTP 才会暴露的
// 契约：登录/权限闸门、请求体字节上限（不能只信 Content-Length）、响应信封
// （message 固定为字符串、正式消息放 chat_message）、稳定 error 字段与错误码映射。
//
// 登录态用 next/headers 的 cookie mock（同 chat-stream.test.ts），其余跑真实
// SQLite 与真实 route handler（不 mock Prisma）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { POST as createRoute } from '@/app/api/chat/channels/[id]/generations/route';
import { GET as statusRoute } from '@/app/api/chat/generations/[id]/route';
import { POST as chunksRoute } from '@/app/api/chat/generations/[id]/chunks/route';
import { POST as completeRoute } from '@/app/api/chat/generations/[id]/complete/route';
import { POST as cancelRoute } from '@/app/api/chat/generations/[id]/cancel/route';
import { __resetChatGenerations, __setChatGenerationClockForTest } from '@/lib/chat/generations';
import { __resetChatBus } from '@/lib/chat-bus';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { createSessionToken } from '@/lib/session';
import { CHAT_LOBBY_ID } from '@/lib/chat-shared';
import { makeUser, prisma, resetDb } from '../helpers/db';

const BASE = 'http://localhost/api/chat';
let fakeNow = 1_000_000;

beforeEach(async () => {
  await resetDb();
  __resetChatGenerations();
  __resetChatBus();
  __resetRateLimitStore();
  session.token = undefined;
  fakeNow = 1_000_000;
  __setChatGenerationClockForTest(() => fakeNow);
});

afterEach(() => {
  __resetChatGenerations();
});

async function login(userId: string) {
  session.token = await createSessionToken({ uid: userId, sv: 0 });
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const createCall = (channelId: string, body: unknown) =>
  createRoute(post(`${BASE}/channels/${channelId}/generations`, body), {
    params: Promise.resolve({ id: channelId }),
  });

const chunkCall = (generationId: string, body: unknown, init?: Request) =>
  chunksRoute(init ?? post(`${BASE}/generations/${generationId}/chunks`, body), {
    params: Promise.resolve({ id: generationId }),
  });

const completeCall = (generationId: string, body: unknown) =>
  completeRoute(post(`${BASE}/generations/${generationId}/complete`, body), {
    params: Promise.resolve({ id: generationId }),
  });

const cancelCall = (generationId: string) =>
  cancelRoute(post(`${BASE}/generations/${generationId}/cancel`, {}), {
    params: Promise.resolve({ id: generationId }),
  });

const statusCall = (generationId: string) =>
  statusRoute(new Request(`${BASE}/generations/${generationId}`), {
    params: Promise.resolve({ id: generationId }),
  });

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

async function createOk(channelId = CHAT_LOBBY_ID) {
  const res = await createCall(channelId, { client_request_id: crypto.randomUUID() });
  expect(res.status).toBe(200);
  return (await json(res)) as {
    generation_id: string;
    next_seq: number;
    idle_timeout_ms: number;
    max_duration_ms: number;
  };
}

describe('生成接口：鉴权与信封', () => {
  it('未登录 401、普通账号/禁言账号 403，错误响应带稳定 error', async () => {
    const anon = await createCall(CHAT_LOBBY_ID, { client_request_id: 'x' });
    expect(anon.status).toBe(401);
    expect(await json(anon)).toMatchObject({ code: 401, error: 'unauthorized' });

    const plain = await makeUser();
    await login(plain.id);
    const forbidden = await createCall(CHAT_LOBBY_ID, { client_request_id: 'x' });
    expect(forbidden.status).toBe(403);
    expect(await json(forbidden)).toMatchObject({ code: 403, error: 'forbidden' });

    const banned = await makeUser({ role: 'core', isBanned: true });
    await login(banned.id);
    expect((await createCall(CHAT_LOBBY_ID, { client_request_id: 'x' })).status).toBe(403);
  });

  it('创建/分块/完成/取消/查询返回 {code, message(string), ...data}', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);

    const createdRes = await createCall(CHAT_LOBBY_ID, { client_request_id: 'envelope' });
    expect(createdRes.status).toBe(200);
    const created = await json(createdRes);
    expect(typeof created.message).toBe('string');
    expect(created).toMatchObject({
      code: 200,
      next_seq: 1,
      idle_timeout_ms: 120_000,
      max_duration_ms: 600_000,
    });
    const generationId = created.generation_id as string;

    const chunkRes = await chunkCall(generationId, { seq: 1, delta: '正文' });
    expect(chunkRes.status).toBe(200);
    expect(await json(chunkRes)).toMatchObject({ code: 200, accepted_seq: 1, next_seq: 2 });

    const statusRes = await statusCall(generationId);
    expect(statusRes.status).toBe(200);
    expect(await json(statusRes)).toMatchObject({
      code: 200,
      status: 'active',
      next_seq: 2,
      revision: 1,
    });

    const doneRes = await completeCall(generationId, { last_seq: 1 });
    expect(doneRes.status).toBe(200);
    const done = await json(doneRes);
    expect(done).toMatchObject({ code: 200, status: 'completed' });
    expect(typeof done.message).toBe('string');
    expect(done.chat_message).toBeTypeOf('object');
    const messageId = done.message_id as number;
    expect(messageId).toBeTypeOf('number');
    expect((done.chat_message as { id: number }).id).toBe(messageId);

    // 重复 complete：同一 HTTP 状态与结果，不再带 chat_message
    const replayRes = await completeCall(generationId, { last_seq: 1 });
    expect(replayRes.status).toBe(200);
    const replay = await json(replayRes);
    expect(replay).toMatchObject({ code: 200, status: 'completed', message_id: messageId });
    expect(replay.chat_message).toBeUndefined();

    // 终态 GET 与终态 cancel
    expect(await json(await statusCall(generationId))).toMatchObject({
      status: 'completed',
      message_id: messageId,
    });
    const cancelled = await cancelCall(generationId);
    expect(cancelled.status).toBe(200);
    expect(await json(cancelled)).toMatchObject({ status: 'completed' });

    expect(await prisma.chatMessage.count()).toBe(1);
  });

  it('create 幂等重放与元数据冲突（HTTP 409 + error）', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);
    const first = await createCall(CHAT_LOBBY_ID, { client_request_id: 'http-idem' });
    expect(first.status).toBe(200);
    const firstBody = await json(first);

    const replay = await createCall(CHAT_LOBBY_ID, { client_request_id: 'http-idem' });
    expect(await json(replay)).toMatchObject({ generation_id: firstBody.generation_id });

    const conflict = await createCall(CHAT_LOBBY_ID, {
      client_request_id: 'http-idem',
      reply_to: 99,
    });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ code: 409, error: 'conflict' });
  });
});

describe('生成接口：请求体上限与错误映射', () => {
  it('单片段 8 KiB body 超限 → 413 too_large（Content-Length 正常）', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);
    const created = await createOk();

    const res = await chunkCall(created.generation_id, { seq: 1, delta: 'a'.repeat(9000) });
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ code: 413, error: 'too_large' });
  });

  it('分块请求体按字节流截断，不信任伪造 Content-Length', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);
    const created = await createOk();

    const payload = JSON.stringify({ seq: 1, delta: 'b'.repeat(9000) });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    const req = new Request(`${BASE}/generations/${created.generation_id}/chunks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 伪造一个很小的长度：路由若只看它就会读进 9KB 再解析
        'content-length': '10',
      },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit);

    const res = await chunkCall(created.generation_id, null, req);
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ error: 'too_large' });
  });

  it('invalid_request / not_found / conflict / gone 的 HTTP 映射', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);

    expect((await createCall(CHAT_LOBBY_ID, {})).status).toBe(400);
    expect((await chunkCall('missing-id', { seq: 1, delta: 'x' })).status).toBe(404);
    expect((await statusCall('missing-id')).status).toBe(404);
    expect((await completeCall('missing-id', { last_seq: 0 })).status).toBe(404);
    expect((await cancelCall('missing-id')).status).toBe(404);

    const created = await createOk();
    expect((await chunkCall(created.generation_id, { seq: 2, delta: 'x' })).status).toBe(409);
    const conflict = await json(await chunkCall(created.generation_id, { seq: 2, delta: 'x' }));
    expect(conflict).toMatchObject({ error: 'conflict', next_seq: 1 });

    // 超时 → 410 gone
    fakeNow += 120_000;
    const gone = await chunkCall(created.generation_id, { seq: 1, delta: 'x' });
    expect(gone.status).toBe(410);
    expect(await json(gone)).toMatchObject({ error: 'gone' });
    expect((await completeCall(created.generation_id, { last_seq: 0 })).status).toBe(410);
    expect((await cancelCall(created.generation_id)).status).toBe(410);
    // 终态 GET 仍 200，用 status 描述
    expect(await json(await statusCall(created.generation_id))).toMatchObject({ status: 'expired' });
  });

  it('cancel 后 complete 409，空正文 complete 400 empty', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);

    const empty = await createOk();
    const emptyDone = await completeCall(empty.generation_id, { last_seq: 0 });
    expect(emptyDone.status).toBe(400);
    expect(await json(emptyDone)).toMatchObject({ status: 'failed', error: 'empty' });

    const created = await createOk();
    await chunkCall(created.generation_id, { seq: 1, delta: 'x' });
    expect((await cancelCall(created.generation_id)).status).toBe(200);
    const late = await completeCall(created.generation_id, { last_seq: 1 });
    expect(late.status).toBe(409);
    expect(await json(late)).toMatchObject({ error: 'conflict', status: 'cancelled' });
    expect(await prisma.chatMessage.count()).toBe(0);
  });
});

describe('生成接口：权限与副作用', () => {
  it('非作者查询/写入/完成/取消均 403', async () => {
    const author = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    await login(author.id);
    const created = await createOk();

    await login(other.id);
    for (const res of [
      await statusCall(created.generation_id),
      await chunkCall(created.generation_id, { seq: 1, delta: 'x' }),
      await completeCall(created.generation_id, { last_seq: 0 }),
      await cancelCall(created.generation_id),
    ]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ error: 'forbidden' });
    }
  });

  it('专注模式屏蔽大区：创建 403，生成中途开启则任务终止', async () => {
    const author = await makeUser({ role: 'core' });
    await login(author.id);
    const created = await createOk();

    await prisma.user.update({
      where: { id: author.id },
      data: { focusMode: true, focusBlockLobby: true },
    });
    const blocked = await createCall(CHAT_LOBBY_ID, { client_request_id: 'blocked' });
    expect(blocked.status).toBe(403);
    expect(await json(blocked)).toMatchObject({ error: 'forbidden' });

    const chunkRes = await chunkCall(created.generation_id, { seq: 1, delta: '中途失权' });
    expect(chunkRes.status).toBe(403);
    // 无法再查询该任务（GET 也要重验频道访问）
    expect((await statusCall(created.generation_id)).status).toBe(403);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('私聊里第三方看不到快照（通过成员投递，HTTP 层不泄露）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    const outsider = await makeUser({ role: 'core' });
    const { startDirectChannel } = await import('@/lib/chat-service');
    const direct = await startDirectChannel(a.id, b.id);
    if (!direct.ok) throw new Error('direct failed');
    const channelId = direct.channel.id;

    await login(a.id);
    const created = await createOk(channelId);
    await chunkCall(created.generation_id, { seq: 1, delta: '私聊' });

    await login(outsider.id);
    expect((await statusCall(created.generation_id)).status).toBe(403);
    expect((await chunkCall(created.generation_id, { seq: 2, delta: 'x' })).status).toBe(403);
    expect(await prisma.chatMessage.count()).toBe(0);
  });
});