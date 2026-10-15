import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  MAX_REALTIME_MESSAGE_BYTES,
  REALTIME_PROTOCOL_VERSION,
  parseRealtimeAuthentication,
  type RealtimeControlMessage,
  type RealtimeErrorCode,
} from '../../../shared/realtime/protocol.js';
import { parseAllowedOrigins } from './config.js';
import type { RealtimeGame, RealtimePeer, RealtimeSession } from './game.js';

interface ServerOptions {
  allowedOrigins: readonly string[];
  games: readonly RealtimeGame[];
  authTimeoutMs?: number;
  heartbeatMs?: number;
  shutdownGraceMs?: number;
}

const MAX_CONNECTIONS = 256;
const MAX_MESSAGES_PER_SECOND = 60;
const MAX_BUFFERED_BYTES = 256 * 1024;

function bufferOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function createRealtimeServer(options: ServerOptions) {
  const origins = new Set(parseAllowedOrigins(options.allowedOrigins.join(',')));
  if (!origins.size) throw new Error('实时服务必须指定允许的 Origin');
  const games = new Map<string, RealtimeGame>();
  for (const game of options.games) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(game.id) || games.has(game.id)
        || typeof game.authenticate !== 'function' || typeof game.connect !== 'function') {
      throw new Error('实时游戏必须有唯一 ID、票据验证与连接处理器');
    }
    games.set(game.id, game);
  }
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const heartbeatMs = options.heartbeatMs ?? 30000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 3000;
  for (const duration of [authTimeoutMs, heartbeatMs, shutdownGraceMs]) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('实时服务的超时必须为正数');
  }
  let stopping = false;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(stopping ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !stopping, service: 'realtime', version: REALTIME_PROTOCOL_VERSION, games: [...games.keys()] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_REALTIME_MESSAGE_BYTES, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();

  function attach(socket: WebSocket, game: RealtimeGame) {
    alive.add(socket);
    const abort = new AbortController();
    let phase: 'waiting' | 'authenticating' | 'connected' | 'closed' = 'waiting';
    let session: RealtimeSession | undefined;
    let windowStart = performance.now();
    let messages = 0;

    function control(message: RealtimeControlMessage) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
    function fail(code: RealtimeErrorCode, closeCode = 1008) {
      if (phase === 'closed') return;
      phase = 'closed';
      abort.abort();
      control({ type: 'realtime.error', version: REALTIME_PROTOCOL_VERSION, code });
      socket.close(closeCode, code);
    }
    const authTimer = setTimeout(() => fail('authentication_timeout'), authTimeoutMs);
    authTimer.unref();
    socket.on('pong', () => alive.add(socket));
    socket.on('error', () => {
      // ws 对超大帧等协议错误已经发出关闭帧，保留其 1009 等关闭语义。
      if (socket.readyState === WebSocket.OPEN) socket.terminate();
    });
    socket.on('close', () => {
      phase = 'closed';
      abort.abort();
      clearTimeout(authTimer);
      try { session?.close(); } catch { /* 单个游戏的清理失败不能影响其他连接。 */ }
    });

    async function authenticate(text: string) {
      const authentication = parseRealtimeAuthentication(text);
      if (!authentication) { fail('invalid_message'); return; }
      phase = 'authenticating';
      try {
        const identity = await game.authenticate({ gameId: game.id, ticket: authentication.ticket, signal: abort.signal });
        if (abort.signal.aborted || socket.readyState !== WebSocket.OPEN) return;
        if (!identity || typeof identity.userId !== 'string' || !identity.userId) { fail('authentication_failed'); return; }
        clearTimeout(authTimer);
        phase = 'connected';
        const peer: RealtimePeer = {
          id: randomUUID(),
          identity: Object.freeze({ userId: identity.userId }),
          send(data) {
            if (socket.readyState !== WebSocket.OPEN || phase !== 'connected') return false;
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.close(1013, 'slow_consumer'); return false; }
            socket.send(data);
            return true;
          },
          disconnect() { socket.close(1000, 'game_closed'); },
        };
        control({ type: 'realtime.ready', version: REALTIME_PROTOCOL_VERSION, gameId: game.id, connectionId: peer.id });
        session = game.connect(peer);
      } catch {
        // 错误只返回稳定代码，票据、用户资料与内部异常不写入响应或日志。
        if (!abort.signal.aborted) fail('internal_error', 1011);
      }
    }

    socket.on('message', (data, binary) => {
      if (phase === 'closed') return;
      const now = performance.now();
      if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
      if (++messages > MAX_MESSAGES_PER_SECOND) { fail('rate_limited'); return; }
      const buffer = bufferOf(data);
      if (phase === 'waiting') {
        if (binary) fail('invalid_message');
        else void authenticate(buffer.toString('utf8'));
        return;
      }
      // 验证期间不能排队游戏指令；客户端必须等 realtime.ready 再开始发送。
      if (phase === 'authenticating') { fail('invalid_message'); return; }
      try {
        session?.receive(binary ? { binary: true, data: buffer } : { binary: false, data: buffer.toString('utf8') });
      } catch { fail('internal_error', 1011); }
    });
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (stopping || sockets.clients.size >= MAX_CONNECTIONS) { reject('503 Service Unavailable'); return; }
    const match = /^\/realtime\/([a-z][a-z0-9-]{0,47})$/.exec(req.url ?? '');
    const game = match ? games.get(match[1]) : undefined;
    if (!game) { reject('404 Not Found'); return; }
    if (!req.headers.origin || !origins.has(req.headers.origin)) { reject('403 Forbidden'); return; }
    sockets.handleUpgrade(req, socket, head, (websocket) => attach(websocket, game));
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    clearInterval(heartbeat);
    const deadline = setTimeout(() => {
      for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections();
    }, shutdownGraceMs);
    deadline.unref();
    for (const socket of sockets.clients) socket.close(1001, 'service_stopping');
    closing = Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => sockets.close(() => resolve())),
    ]).then(() => { clearTimeout(deadline); });
    return closing;
  }
  return { server, close };
}
