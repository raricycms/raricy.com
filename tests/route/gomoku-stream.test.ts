// GET /api/game/gomoku/rooms/:code/stream —— 对局实时流（SSE）
//
// 【为什么单独测路由】bus 与房间的语义已经在 tests/service 里打过，这里打的是
// **HTTP 那一层**，而这一层的故障单测看不见、构建也不报错：
//   1. 响应头。少了 `Cache-Control: no-transform`，next start 的压缩中间件会把
//      事件 gzip 攒到流结束才发 —— 页面 200、内容也对，只是实时性归零。
//   2. 首帧必须立刻可见（retry: + 注释帧），否则某些中间层会把流当成空响应挂住。
//   3. 一连上就要推一次全量状态 —— 这就是断线补齐，缺了它重连后棋盘停在旧状态。
//   4. 断开必须注销订阅并重算在线状态，否则对手端永远显示「在线」，判胜按钮不出来。
//
// 本文件打真实 route handler（不 mock Prisma），只 mock 登录态。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 只替换 getCurrentUser，保留真实的 isCoreUser —— 权限判定本身是被测语义
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

import { makeUser, resetDb } from '../helpers/db';
import { GET as streamRoom } from '@/app/api/game/gomoku/rooms/[code]/stream/route';
import { __resetGameBus, connectionsIn, MAX_CONNECTIONS_PER_VIEWER, subscribe } from '@/lib/game-bus';
import { __resetGomokuRooms, createRoom, getSnapshot, joinRoom } from '@/lib/gomoku-room';

beforeEach(async () => {
  await resetDb();
  __resetGomokuRooms();
  __resetGameBus();
  mockUser.current = null;
});

function call(code: string): Promise<Response> {
  return streamRoom(new Request(`http://localhost/api/game/gomoku/rooms/${code}/stream`), {
    params: Promise.resolve({ code }),
  });
}

/** 读流的前 n 个 chunk（路由在 start() 里同步写完首帧，不会挂住）。 */
async function readChunks(res: Response, n: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < n; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { reader, text };
}

/** 建一局 Alice 黑 / Bob 白的对局，并让 Alice 成为当前登录用户。 */
async function playingAsAlice() {
  const alice = await makeUser({ role: 'core' });
  const bob = await makeUser({ role: 'core' });
  const created = createRoom({ id: alice.id, name: alice.username });
  if (!created.ok) throw new Error('建房失败');
  joinRoom(created.value.view.code, { id: bob.id, name: bob.username });
  mockUser.current = alice;
  return { alice, bob, code: created.value.view.code };
}

describe('响应头（no-transform 不可省）', () => {
  it('Content-Type / Cache-Control / X-Accel-Buffering 三件套齐全', async () => {
    const { code } = await playingAsAlice();
    const res = await call(code);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // 少了这一条，next start 的压缩中间件会把事件攒到流结束才发，实时性归零
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    await res.body!.cancel();
  });
});

describe('首帧与初始状态', () => {
  it('首帧立刻给出 retry: 与注释帧（免得被中间层当成空响应）', async () => {
    const { code } = await playingAsAlice();
    const res = await call(code);
    const { reader, text } = await readChunks(res, 1);

    expect(text).toContain('retry: ');
    expect(text).toContain(': connected');

    await reader.cancel();
  });

  it('一连上就推一次全量状态（这就是断线补齐）', async () => {
    const { code } = await playingAsAlice();
    const res = await call(code);
    const { reader, text } = await readChunks(res, 2);

    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    const event = JSON.parse(dataLines[0].slice('data: '.length));
    expect(event.type).toBe('state');
    expect(event.view.code).toBe(code);
    expect(event.view.grid).toHaveLength(15);
    expect(event.view.status).toBe('playing');

    await reader.cancel();
  });
});

describe('鉴权（每次建连都重做）', () => {
  it('未登录 → 401', async () => {
    const res = await call('abcdef');
    expect(res.status).toBe(401);
  });

  it('已登录但非 core → 403', async () => {
    const plain = await makeUser({ role: 'user' });
    mockUser.current = plain;

    const res = await call('abcdef');
    expect(res.status).toBe(403);
  });

  it('专注模式 → 403（联机是社交行为，比单机子页严）', async () => {
    const { alice, code } = await playingAsAlice();
    mockUser.current = { ...(alice as object), focusMode: true };

    const res = await call(code);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain('专注模式');
  });

  it('房间不存在 / 房号非法 → 同一个 404（不泄露「格式对不对」）', async () => {
    const { alice } = await playingAsAlice();
    mockUser.current = alice;

    expect((await call('zzzzzz')).status).toBe(404);
    expect((await call('!!')).status).toBe(404);
  });

  it('超过每用户并发连接上限 → 429', async () => {
    const { alice, code } = await playingAsAlice();
    mockUser.current = alice;

    // 先把配额占满（模拟开了太多标签页）
    for (let i = 0; i < MAX_CONNECTIONS_PER_VIEWER; i++) {
      const off = subscribe({
        roomCode: code,
        viewerId: alice.id,
        write: () => true,
        close: () => {},
      });
      expect(off).not.toBeNull();
    }

    const res = await call(code);
    expect(res.status).toBe(429);
  });

  it('大小写/杂质混写的房号能被规范化到同一个房', async () => {
    const { code } = await playingAsAlice();
    const messy = ` ${code.toUpperCase()} `;

    const res = await call(messy);
    expect(res.status).toBe(200);

    await res.body!.cancel();
  });
});

describe('断开后的收尾', () => {
  it('取消流 → 注销订阅，席位主人转为「已掉线」', async () => {
    const { alice, code } = await playingAsAlice();

    const res = await call(code);
    expect(connectionsIn(code, alice.id)).toBe(1);
    // 用 reader 取消 —— res.body 已被 getReader() 锁住，不能再直接 cancel
    const { reader } = await readChunks(res, 2);
    // 连上后席位显示在线
    const snap = getSnapshot(code, alice.id);
    if (!snap.ok) throw new Error('快照失败');
    expect(snap.value.view.seats.black?.connected).toBe(true);

    await reader.cancel();

    // 断开后：订阅没了，席位转为掉线（对手端据此显示并开始计时判胜）
    expect(connectionsIn(code, alice.id)).toBe(0);
    const after = getSnapshot(code, alice.id);
    if (!after.ok) throw new Error('快照失败');
    expect(after.value.view.seats.black?.connected).toBe(false);
  });

  it('断开后再连一次仍能拿到状态（重连即回到原座）', async () => {
    const { alice, code } = await playingAsAlice();

    const first = await call(code);
    const { reader: firstReader } = await readChunks(first, 1);
    await firstReader.cancel();

    const second = await call(code);
    expect(second.status).toBe(200);
    const { reader, text } = await readChunks(second, 2);
    expect(text).toContain('"type":"state"');

    const snap = getSnapshot(code, alice.id);
    if (!snap.ok) throw new Error('快照失败');
    expect(snap.value.you).toEqual({ role: 'player', seat: 'black' });

    await reader.cancel();
  });
});
