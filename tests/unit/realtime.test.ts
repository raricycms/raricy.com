import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createRealtimeServer } from '../../services/realtime/src/server';
import { readRealtimeConfig } from '../../services/realtime/src/config';
import type { RealtimeGame } from '../../services/realtime/src/game';
import { MAX_REALTIME_MESSAGE_BYTES, parseRealtimeAuthentication } from '../../shared/realtime/protocol';

const ORIGIN = 'http://localhost:3000';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function game(overrides: Partial<RealtimeGame> = {}): RealtimeGame {
  return {
    id: 'probe',
    authenticate: async ({ ticket }) => ticket === 'valid-ticket' ? { userId: 'player-1' } : null,
    connect: (peer) => ({ receive: (message) => { peer.send(message.data); }, close: () => {} }),
    ...overrides,
  };
}

async function start(games: RealtimeGame[] = [], options: { authTimeoutMs?: number; heartbeatMs?: number } = {}) {
  const runtime = createRealtimeServer({ allowedOrigins: [ORIGIN], games, shutdownGraceMs: 100, ...options });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const base = `127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  cleanups.push(runtime.close);
  return { ...runtime, http: `http://${base}`, ws: `ws://${base}` };
}

async function connect(url: string, autoPong = true) {
  const socket = new WebSocket(url, { origin: ORIGIN, autoPong });
  socket.on('error', () => {});
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, 'open');
  return socket;
}

async function authorize(socket: WebSocket, ticket = 'valid-ticket') {
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket }));
  const [data] = await message;
  return JSON.parse(String(data));
}

async function rejected(url: string, origin?: string): Promise<number> {
  const socket = new WebSocket(url, origin ? { origin } : {});
  socket.on('error', () => {});
  cleanups.push(async () => { socket.terminate(); });
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.once('open', () => reject(new Error('不应完成 WebSocket 升级')));
    socket.once('error', reject);
  });
}

describe('实时服务边界', () => {
  it('生产必须指定 Origin，拒绝带路径的 Origin 与非法端口', () => {
    expect(() => readRealtimeConfig({ NODE_ENV: 'production' })).toThrow('REALTIME_ALLOWED_ORIGINS');
    expect(() => readRealtimeConfig({ REALTIME_PORT: '0' })).toThrow('REALTIME_PORT');
    expect(() => readRealtimeConfig({ REALTIME_ALLOWED_ORIGINS: `${ORIGIN}/` })).toThrow('origin');
    expect(readRealtimeConfig({})).toMatchObject({ host: '127.0.0.1', port: 3033 });
  });

  it('认证帧只接受当前版本与非空、有限长度的票据', () => {
    for (const value of ['bad-json', 'null', '[]', '{"type":"realtime.authenticate","version":2,"ticket":"a"}',
      JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: ' '.repeat(10) }),
      JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: 'a'.repeat(2049) })]) {
      expect(parseRealtimeAuthentication(value)).toBeNull();
    }
  });

  it('空注册表只开放健康检查，不暴露 Wand 或其他游戏', async () => {
    const runtime = await start();
    const response = await fetch(`${runtime.http}/healthz`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, service: 'realtime', version: 1, games: [] });
    expect(await rejected(`${runtime.ws}/realtime/wand`, ORIGIN)).toBe(404);
    expect((await fetch(`${runtime.http}/missing`)).status).toBe(404);
  });

  it('升级时精确检查来源，不从 URL 接受认证票据', async () => {
    const runtime = await start([game()]);
    for (const origin of [undefined, 'https://untrusted.example', `${ORIGIN}.evil.example`]) {
      expect(await rejected(`${runtime.ws}/realtime/probe`, origin)).toBe(403);
    }
    expect(await rejected(`${runtime.ws}/realtime/probe?ticket=valid-ticket`, ORIGIN)).toBe(404);
  });

  it('认证后才建立游戏，文本与二进制帧保持原样，断连清理一次', async () => {
    const closed = vi.fn();
    const connected = vi.fn<RealtimeGame['connect']>((peer) => {
      expect(peer.identity).toEqual({ userId: 'player-1' });
      return { receive: (message) => { peer.send(message.data); }, close: closed };
    });
    const runtime = await start([game({ connect: connected })]);
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    expect(connected).not.toHaveBeenCalled();
    expect(await authorize(socket)).toMatchObject({ type: 'realtime.ready', version: 1, gameId: 'probe' });
    let reply = once(socket, 'message');
    socket.send('game-input');
    const [text, textBinary] = await reply;
    expect(String(text)).toBe('game-input');
    expect(textBinary).toBe(false);
    reply = once(socket, 'message');
    socket.send(Buffer.from([0, 1, 255]));
    const [bytes, binary] = await reply;
    expect([...bytes as Buffer]).toEqual([0, 1, 255]);
    expect(binary).toBe(true);
    const disconnected = once(socket, 'close');
    socket.close();
    await disconnected;
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('拒绝无效票据，认证前不调用游戏入口', async () => {
    const connected = vi.fn();
    const runtime = await start([game({ connect: connected })]);
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    const closed = once(socket, 'close');
    expect(await authorize(socket, 'invalid-ticket')).toMatchObject({ type: 'realtime.error', code: 'authentication_failed' });
    expect((await closed)[0]).toBe(1008);
    expect(connected).not.toHaveBeenCalled();
  });

  it('认证期间收到额外帧会拒绝，迟到的验证结果不会进入游戏', async () => {
    let finish!: (identity: { userId: string }) => void;
    let signal!: AbortSignal;
    const connected = vi.fn();
    const runtime = await start([game({
      authenticate: (input) => { signal = input.signal; return new Promise((resolve) => { finish = resolve; }); },
      connect: connected,
    })]);
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    socket.send(JSON.stringify({ type: 'realtime.authenticate', version: 1, ticket: 'any' }));
    socket.send('early-input');
    const [data] = await once(socket, 'message');
    expect(JSON.parse(String(data)).code).toBe('invalid_message');
    expect(signal.aborted).toBe(true);
    finish({ userId: 'late-user' });
    await runtime.close();
    expect(connected).not.toHaveBeenCalled();
  });

  it('验证挂起时按时断开，并取消验证任务', async () => {
    let signal!: AbortSignal;
    const runtime = await start([game({ authenticate: (input) => {
      signal = input.signal;
      return new Promise(() => {});
    } })], { authTimeoutMs: 60 });
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    const closed = once(socket, 'close');
    expect(await authorize(socket)).toMatchObject({ code: 'authentication_timeout' });
    expect((await closed)[0]).toBe(1008);
    expect(signal.aborted).toBe(true);
  });

  it('游戏指令抛错只断开当前连接，服务仍能处理健康检查', async () => {
    const runtime = await start([game({ connect: () => ({ receive: () => { throw new Error('private-detail'); }, close: () => {} }) })]);
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    await authorize(socket);
    const message = once(socket, 'message');
    const closed = once(socket, 'close');
    socket.send('input');
    expect(JSON.parse(String((await message)[0]))).toMatchObject({ code: 'internal_error' });
    expect((await closed)[0]).toBe(1011);
    expect((await fetch(`${runtime.http}/healthz`)).status).toBe(200);
  });

  it('超大帧与高频发送会断开连接', async () => {
    const runtime = await start([game()]);
    let socket = await connect(`${runtime.ws}/realtime/probe`);
    await authorize(socket);
    let closed = once(socket, 'close');
    socket.send(Buffer.alloc(MAX_REALTIME_MESSAGE_BYTES + 1));
    expect((await closed)[0]).toBe(1009);
    socket = await connect(`${runtime.ws}/realtime/probe`);
    await authorize(socket);
    closed = once(socket, 'close');
    for (let i = 0; i < 61; i++) socket.send('input');
    expect((await closed)[0]).toBe(1008);
  });

  it('不响应 ping 的连接会被回收', async () => {
    const runtime = await start([game()], { heartbeatMs: 40 });
    const socket = await connect(`${runtime.ws}/realtime/probe`, false);
    const closed = once(socket, 'close');
    await authorize(socket);
    expect((await closed)[0]).toBe(1006);
  });

  it('服务停止会通知客户端、清理会话，重复停止幂等', async () => {
    const closedSession = vi.fn();
    const runtime = await start([game({ connect: () => ({ receive: () => {}, close: closedSession }) })]);
    const socket = await connect(`${runtime.ws}/realtime/probe`);
    await authorize(socket);
    const closed = once(socket, 'close');
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    expect((await closed)[0]).toBe(1001);
    await first;
    expect(closedSession).toHaveBeenCalledTimes(1);
  });
});
